import { discoverActiveCryptoPriceMarkets, discoverCryptoMarkets, fetchCurrentBook } from "@/src/lib/backtest/polymarket";
import type { CryptoMarket } from "@/src/lib/backtest/types";
import { fetchWithTimeout } from "@/lib/utils";
import {
  calculatePriceBasisPct,
  fetchPolymarketReferencePrices,
  selectReferencePrice,
  type SupportedReferenceAsset,
} from "@/src/lib/combined-trading/polymarket-reference";
import { impliedTerminalMedianForCondition } from "@/src/lib/model-evaluation/combined-trading";
import { fitMonotonicProbabilityLadder } from "@/src/lib/model-evaluation/probability-ladder";
import { parseTerminalPriceCondition } from "@/src/lib/model-evaluation/price-structure";
import { prisma } from "@/src/lib/server/prisma";

const supportedAssets = ["BTC", "ETH", "SOL", "XRP"] as const;
const observationHorizons = [
  { hours: 6, tolerance: 2 },
  { hours: 12, tolerance: 2 },
  { hours: 24, tolerance: 3 },
  { hours: 48, tolerance: 4 },
] as const;

export type CombinedLiveSignal = {
  eventId: string;
  marketId: string;
  asset: (typeof supportedAssets)[number];
  observedAt: string;
  exitAt: string;
  horizonHours: number;
  actualHoursToEnd: number;
  marketProbability: number;
  marketBestBid: number | null;
  marketBestAsk: number | null;
  marketSpread: number | null;
  polymarketReferencePrice: number | null;
  referenceSource: "BINANCE" | "CHAINLINK" | null;
  referenceCapturedAt: string | null;
  spotPrice: number;
  priceBasisPct: number | null;
  impliedTarget: number;
  realizedVolatility24h: number;
  hyperliquidMomentum6h: number;
  trendZ6h: number;
  hyperliquidFunding24h: number | null;
  signalZ: number;
  side: "LONG" | "SHORT";
  sourceMarkets: number;
  ladderViolations: number;
  ladderAdjustmentRms: number;
};

export type CombinedSignalScan = {
  signal: CombinedLiveSignal | null;
  signals: CombinedLiveSignal[];
  horizons: CombinedHorizonSignalScan[];
  scannedMarkets: number;
  structuredMarkets: number;
  horizonEligibleMarkets: number;
  groupedEvents: number;
  priceReadyEvents: number;
  eligibleEvents: number;
  nextWindowAt: string | null;
  closestHoursToEnd: number | null;
  reason: string;
};

export type CombinedHorizonSignalScan = {
  horizonHours: number;
  signal: CombinedLiveSignal | null;
  signals: CombinedLiveSignal[];
  horizonEligibleMarkets: number;
  groupedEvents: number;
  priceReadyEvents: number;
  nextWindowAt: string | null;
  closestHoursToEnd: number | null;
  reason: string;
};

type HorizonMarket = {
  market: CryptoMarket;
  horizonHours: number;
  actualHoursToEnd: number;
};

type PriceObservation = {
  probability: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
};

export async function scanCombinedLiveSignal(now = new Date()): Promise<CombinedSignalScan> {
  const [activeEvents, discovered] = await Promise.all([
    discoverActiveCryptoPriceMarkets().catch(() => []),
    discoverCryptoMarkets({ includeResolved: false, limit: 180 }),
  ]);
  // The active-events payload includes resolution-source text; let it win over public-search duplicates.
  const markets = Array.from(new Map([...discovered, ...activeEvents].map((market) => [market.id, market])).values());
  const structured = markets.filter(isStructuredMarket);
  const horizonEligible = structured.flatMap((market) => {
    const matched = matchObservationHorizon(market, now);
    return matched ? [{ market, ...matched }] : [];
  });
  const groups = observationHorizons.flatMap(({ hours }) => groupMarkets(
    horizonEligible.filter((item) => item.horizonHours === hours),
  ).sort((left, right) => right.volume - left.volume).slice(0, 4));
  const nextWindowAt = findNextWindowAt(structured, now);
  const closestHoursToEnd = findClosestHoursToEnd(structured, now);

  if (!groups.length) {
    const horizons = buildHorizonScans(structured, horizonEligible, groups, [], now);
    return {
      signal: null,
      signals: [],
      horizons,
      scannedMarkets: markets.length,
      structuredMarkets: structured.length,
      horizonEligibleMarkets: horizonEligible.length,
      groupedEvents: 0,
      priceReadyEvents: 0,
      eligibleEvents: 0,
      nextWindowAt,
      closestHoursToEnd,
      reason: nextWindowAt
        ? `次の観測時間は${formatJapanTime(nextWindowAt)}です`
        : "6・12・24・48時間の観測帯に入る価格市場がありません",
    };
  }

  const assets = Array.from(new Set(groups.map((group) => group.asset)));
  const [priceStates, referencePrices] = await Promise.all([
    loadPriceStates(now),
    fetchPolymarketReferencePrices(assets as SupportedReferenceAsset[]).catch(() => []),
  ]);
  const evaluatedSignals = await mapWithConcurrency<(typeof groups)[number], CombinedLiveSignal | null>(groups, 4, async (group) => {
    const priceState = priceStates.get(group.asset);
    if (!priceState) return null;
    const observations = await mapWithConcurrency(group.markets.slice(0, 16), 6, currentProbability);
    const ladderInput = group.markets.slice(0, 16).flatMap((market, index) => {
      const condition = parseTerminalPriceCondition(market.title);
      const observation = observations[index];
      if (!condition || condition.kind === "between" || observation === null) return [];
      const threshold = condition.kind === "above" ? condition.lower : condition.upper;
      if (typeof threshold !== "number") return [];
      return [{
        id: market.id,
        kind: condition.kind,
        threshold,
        probability: observation.probability,
        weight: observation.probability * (1 - observation.probability),
      }];
    });
    const ladder = fitMonotonicProbabilityLadder(ladderInput);
    const correctedByMarket = new Map(ladder.points.map((point) => [point.id, point.correctedProbability]));
    const horizonVolatility = priceState.volatility24h * Math.sqrt(group.actualHoursToEnd / 24);
    const estimates = group.markets.slice(0, 16).flatMap((market, index) => {
      const condition = parseTerminalPriceCondition(market.title);
      const observation = observations[index];
      const probability = correctedByMarket.get(market.id);
      if (!condition || condition.kind === "between" || observation === null || probability === undefined) return [];
      const target = impliedTerminalMedianForCondition(condition.kind, condition.lower, condition.upper, probability, horizonVolatility);
      if (target === null) return [];
      return [{ market, observation, probability, target, weight: probability * (1 - probability) }];
    });
    if (estimates.length < 2) return null;

    const totalWeight = estimates.reduce((sum, estimate) => sum + estimate.weight, 0);
    if (totalWeight <= 0) return null;
    const impliedTarget = Math.exp(estimates.reduce((sum, estimate) => sum + Math.log(estimate.target) * estimate.weight, 0) / totalWeight);
    const signalZ = Math.log(impliedTarget / priceState.spotPrice) / Math.max(horizonVolatility, 0.001);
    const trendZ6h = priceState.momentum6h / Math.max(priceState.volatility24h * Math.sqrt(6 / 24), 0.001);
    if (!Number.isFinite(signalZ)) return null;
    const representative = [...estimates].sort((left, right) => right.market.volume - left.market.volume)[0];
    const reference = selectReferencePrice(referencePrices, group.asset, representative.market.referenceSource);
    const priceBasisPct = reference ? calculatePriceBasisPct(priceState.spotPrice, reference.price) : null;

    return {
      eventId: group.eventId,
      marketId: representative.market.id,
      asset: group.asset,
      observedAt: now.toISOString(),
      exitAt: group.endDate.toISOString(),
      horizonHours: group.horizonHours,
      actualHoursToEnd: group.actualHoursToEnd,
      marketProbability: representative.probability,
      marketBestBid: representative.observation.bestBid,
      marketBestAsk: representative.observation.bestAsk,
      marketSpread: representative.observation.spread,
      polymarketReferencePrice: reference?.price ?? null,
      referenceSource: reference?.source ?? null,
      referenceCapturedAt: reference?.capturedAt ?? null,
      spotPrice: priceState.spotPrice,
      priceBasisPct,
      impliedTarget,
      realizedVolatility24h: priceState.volatility24h,
      hyperliquidMomentum6h: priceState.momentum6h,
      trendZ6h,
      hyperliquidFunding24h: priceState.funding24h,
      signalZ,
      side: signalZ >= 0 ? "LONG" as const : "SHORT" as const,
      sourceMarkets: estimates.length,
      ladderViolations: ladder.violations,
      ladderAdjustmentRms: ladder.adjustmentRms,
    };
  });
  const signals = evaluatedSignals.filter((signal): signal is CombinedLiveSignal => signal !== null);
  signals.sort((left, right) => Math.abs(right.signalZ) - Math.abs(left.signalZ));
  const signal = signals[0] ?? null;
  const horizons = buildHorizonScans(structured, horizonEligible, groups, signals, now);
  return {
    signal,
    signals,
    horizons,
    scannedMarkets: markets.length,
    structuredMarkets: structured.length,
    horizonEligibleMarkets: horizonEligible.length,
    groupedEvents: groups.length,
    priceReadyEvents: signals.length,
    eligibleEvents: signals.length,
    nextWindowAt,
    closestHoursToEnd,
    reason: signal
      ? `${signal.asset}・${signal.horizonHours}時間モデルを${signal.sourceMarkets}市場から算出`
      : "価格帯を束ねられる市場、板情報、または相場データが不足しています",
  };
}

export function selectCombinedSignalScan(scan: CombinedSignalScan, horizonHours: number): CombinedSignalScan {
  const horizon = scan.horizons.find((item) => item.horizonHours === horizonHours);
  if (!horizon) return scan;
  return {
    ...scan,
    signal: horizon.signal,
    signals: horizon.signals,
    horizonEligibleMarkets: horizon.horizonEligibleMarkets,
    groupedEvents: horizon.groupedEvents,
    priceReadyEvents: horizon.priceReadyEvents,
    eligibleEvents: horizon.priceReadyEvents,
    nextWindowAt: horizon.nextWindowAt,
    closestHoursToEnd: horizon.closestHoursToEnd,
    reason: horizon.reason,
  };
}

function buildHorizonScans(
  structured: CryptoMarket[],
  horizonEligible: HorizonMarket[],
  groups: ReturnType<typeof groupMarkets>,
  signals: CombinedLiveSignal[],
  now: Date,
): CombinedHorizonSignalScan[] {
  return observationHorizons.map(({ hours }) => {
    const horizonSignals = signals.filter((signal) => signal.horizonHours === hours);
    const signal = horizonSignals[0] ?? null;
    const groupedEvents = groups.filter((group) => group.horizonHours === hours).length;
    const nextWindowAt = findNextWindowAt(structured, now, hours);
    return {
      horizonHours: hours,
      signal,
      signals: horizonSignals,
      horizonEligibleMarkets: horizonEligible.filter((item) => item.horizonHours === hours).length,
      groupedEvents,
      priceReadyEvents: horizonSignals.length,
      nextWindowAt,
      closestHoursToEnd: findClosestHoursToEnd(structured, now, hours),
      reason: signal
        ? `${signal.asset}・${hours}時間モデルを${signal.sourceMarkets}市場から算出`
        : groupedEvents > 0
          ? "価格帯を束ねられる市場、板情報、または相場データが不足しています"
          : nextWindowAt
            ? `次の${hours}時間観測は${formatJapanTime(nextWindowAt)}です`
            : `${hours}時間の観測帯に入る価格市場がありません`,
    };
  });
}

function isStructuredMarket(market: CryptoMarket) {
  if (market.resolved || market.currentProbability === null || !market.eventId || !market.endDate) return false;
  if (!supportedAssets.includes(market.asset as (typeof supportedAssets)[number])) return false;
  const condition = parseTerminalPriceCondition(market.title);
  return Boolean(condition && condition.kind !== "between");
}

function matchObservationHorizon(market: CryptoMarket, now: Date) {
  if (!market.endDate) return null;
  const actualHoursToEnd = (new Date(market.endDate).getTime() - now.getTime()) / (60 * 60 * 1_000);
  const horizon = observationHorizons.find((candidate) => Math.abs(actualHoursToEnd - candidate.hours) <= candidate.tolerance);
  return horizon ? { horizonHours: horizon.hours, actualHoursToEnd } : null;
}

function groupMarkets(items: HorizonMarket[]) {
  const groups = new Map<string, {
    eventId: string;
    asset: CombinedLiveSignal["asset"];
    endDate: Date;
    horizonHours: number;
    actualHoursToEnd: number;
    volume: number;
    markets: CryptoMarket[];
  }>();
  for (const { market, horizonHours, actualHoursToEnd } of items) {
    const key = `${market.eventId}:${market.asset}:${market.endDate}:${horizonHours}`;
    const existing = groups.get(key);
    if (existing) {
      existing.markets.push(market);
      existing.volume += market.volume;
    } else {
      groups.set(key, {
        eventId: market.eventId as string,
        asset: market.asset as CombinedLiveSignal["asset"],
        endDate: new Date(market.endDate as string),
        horizonHours,
        actualHoursToEnd,
        volume: market.volume,
        markets: [market],
      });
    }
  }
  return Array.from(groups.values()).filter((group) => group.markets.length >= 2);
}

async function currentProbability(market: CryptoMarket): Promise<PriceObservation | null> {
  const book = await fetchCurrentBook(market.tokenId).catch(() => null);
  const bestBid = book?.bids[0]?.price ?? null;
  const bestAsk = book?.asks[0]?.price ?? null;
  if (bestBid !== null && bestAsk !== null && bestAsk >= bestBid) {
    return {
      probability: clamp((bestBid + bestAsk) / 2, 0.01, 0.99),
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
    };
  }
  return market.currentProbability === null
    ? null
    : { probability: clamp(market.currentProbability, 0.01, 0.99), bestBid, bestAsk, spread: null };
}

function findNextWindowAt(markets: CryptoMarket[], now: Date, onlyHorizonHours?: number) {
  const candidates = markets.flatMap((market) => {
    if (!market.endDate) return [];
    const endAt = new Date(market.endDate).getTime();
    return observationHorizons.filter((horizon) => onlyHorizonHours === undefined || horizon.hours === onlyHorizonHours).flatMap((horizon) => {
      const startsAt = endAt - (horizon.hours + horizon.tolerance) * 60 * 60 * 1_000;
      return startsAt > now.getTime() ? [startsAt] : [];
    });
  });
  const next = candidates.sort((left, right) => left - right)[0];
  return next ? new Date(next).toISOString() : null;
}

function findClosestHoursToEnd(markets: CryptoMarket[], now: Date, targetHours = 24) {
  const values = markets.flatMap((market) => market.endDate
    ? [(new Date(market.endDate).getTime() - now.getTime()) / (60 * 60 * 1_000)]
    : []);
  return values.length ? values.sort((left, right) => Math.abs(left - targetHours) - Math.abs(right - targetHours))[0] : null;
}

function formatJapanTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function loadPriceStates(now: Date) {
  const rows = await prisma.hyperliquidSnapshot.findMany({
    where: {
      asset: { in: [...supportedAssets] },
      capturedAt: { gte: new Date(now.getTime() - 30 * 60 * 60 * 1_000), lte: now },
    },
    orderBy: { capturedAt: "asc" },
  });
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.asset, [...(grouped.get(row.asset) ?? []), row]);
  const recentCandles = new Map(await Promise.all(supportedAssets.map(async (asset) => [
    asset,
    await fetchRecentHourlyPrices(asset, now).catch(() => []),
  ] as const)));

  const states = new Map<CombinedLiveSignal["asset"], { spotPrice: number; volatility24h: number; momentum6h: number; funding24h: number | null }>();
  for (const asset of supportedAssets) {
    const assetRows = grouped.get(asset) ?? [];
    const hourly = new Map<number, (typeof assetRows)[number]>();
    for (const row of assetRows) hourly.set(Math.floor(row.capturedAt.getTime() / (60 * 60 * 1_000)), row);
    const collectedPrices = Array.from(hourly.values()).sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime()).map((row) => row.midPrice);
    const prices = collectedPrices.length >= 12 ? collectedPrices : recentCandles.get(asset) ?? [];
    if (prices.length < 12) continue;
    const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index])).filter(Number.isFinite).slice(-24);
    const volatility24h = clamp(Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0)), 0.005, 0.25);
    const momentum6h = Math.log((prices.at(-1) as number) / prices[prices.length - 7]);
    if (!Number.isFinite(momentum6h)) continue;
    const currentHour = Math.floor(now.getTime() / (60 * 60 * 1_000));
    const fundingRows = Array.from(hourly.entries())
      .filter(([hour]) => hour >= currentHour - 24 && hour < currentHour)
      .map(([, row]) => row.fundingRate)
      .filter(Number.isFinite);
    const funding24h = fundingRows.length >= 18 ? fundingRows.reduce((sum, rate) => sum + rate, 0) : null;
    states.set(asset, { spotPrice: prices.at(-1) as number, volatility24h, momentum6h, funding24h });
  }
  return states;
}

async function fetchRecentHourlyPrices(asset: CombinedLiveSignal["asset"], now: Date) {
  const response = await fetchWithTimeout("https://api.hyperliquid.xyz/info", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: {
        coin: asset,
        interval: "1h",
        startTime: now.getTime() - 48 * 60 * 60 * 1_000,
        endTime: now.getTime(),
      },
    }),
  }, 15_000);
  if (!response.ok) return [];
  const body = await response.json();
  if (!Array.isArray(body)) return [];
  return body
    .map((item) => Number((item as { c?: unknown }).c))
    .filter((price) => Number.isFinite(price) && price > 0)
    .slice(-30);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
