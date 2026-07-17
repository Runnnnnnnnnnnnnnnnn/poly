import {
  discoverActiveCryptoDirectionMarkets,
  fetchCurrentBooks,
  type ActiveCryptoDirectionMarket,
} from "@/src/lib/backtest/polymarket";
import {
  calculatePriceBasisPct,
  fetchPolymarketReferencePrices,
  selectReferencePrice,
  type SupportedReferenceAsset,
} from "@/src/lib/combined-trading/polymarket-reference";
import type {
  CombinedHorizonSignalScan,
  CombinedLiveSignal,
  CombinedSignalScan,
} from "@/src/lib/combined-trading/live-signal";
import { fetchHyperliquidMarketStates } from "@/src/lib/monitoring/hyperliquid";
import { prisma } from "@/src/lib/server/prisma";

export const shortTermDirectionHorizonKey = 0;
export const shortTermDirectionStrategyKey = "poly-updown-hl-trend-forward-v3-m15";
export const shortTermDirectionControlKey = "poly-updown-forward-control-v3-m15";

const supportedAssets = ["BTC", "ETH", "SOL", "XRP"] as const;
const targetDurationMinutes = 15;
const decisionDelayMinutes = 2;
const decisionWindowMinutes = 2;
const maximumSpread = 0.08;

export function isShortTermDirectionExperimentKey(value: string | null | undefined) {
  return value === shortTermDirectionStrategyKey || value === shortTermDirectionControlKey;
}

export function isShortTermDirectionStrategyKey(value: string | null | undefined) {
  return value === shortTermDirectionStrategyKey;
}

export function isShortTermDirectionControlKey(value: string | null | undefined) {
  return value === shortTermDirectionControlKey;
}

export function isShortTermDirectionFamilyKey(value: string | null | undefined) {
  return typeof value === "string"
    && /^poly-updown-(?:hl-trend-forward|forward-control)-v\d+-m15$/.test(value);
}

export function isShortTermDecisionWindow(market: Pick<ActiveCryptoDirectionMarket, "eventStartTime" | "durationMinutes">, now: Date) {
  if (Math.abs(market.durationMinutes - targetDurationMinutes) > 0.5) return false;
  const startMs = new Date(market.eventStartTime).getTime();
  if (!Number.isFinite(startMs)) return false;
  const elapsedMinutes = (now.getTime() - startMs) / 60_000;
  return elapsedMinutes >= decisionDelayMinutes
    && elapsedMinutes < decisionDelayMinutes + decisionWindowMinutes;
}

export async function scanShortTermDirectionSignal(now = new Date()): Promise<CombinedSignalScan> {
  const markets = await discoverActiveCryptoDirectionMarkets().catch(() => []);
  const structured = markets.filter((market) => (
    supportedAssets.includes(market.asset as (typeof supportedAssets)[number])
    && Math.abs(market.durationMinutes - targetDurationMinutes) <= 0.5
    && market.eventId
    && market.endDate
  ));
  const inWindow = structured.filter((market) => isShortTermDecisionWindow(market, now));
  const nextWindowAt = findNextDecisionAt(structured, now);
  const closestHoursToEnd = findClosestHoursToEnd(structured, now);

  if (!inWindow.length) {
    const horizon = emptyHorizonScan({ nextWindowAt, closestHoursToEnd });
    return {
      signal: null,
      signals: [],
      horizons: [horizon],
      scannedMarkets: markets.length,
      structuredMarkets: structured.length,
      horizonEligibleMarkets: 0,
      groupedEvents: 0,
      priceReadyEvents: 0,
      eligibleEvents: 0,
      nextWindowAt,
      closestHoursToEnd,
      reason: nextWindowAt
        ? `次の15分市場は${formatJapanTime(nextWindowAt)}に判定します`
        : "開始2分後の15分Up/Down市場を待っています",
    };
  }

  const tokenIds = inWindow.map((market) => market.tokenId);
  const assets = Array.from(new Set(inWindow.map((market) => market.asset))) as SupportedReferenceAsset[];
  const historyStart = new Date(Math.min(
    now.getTime() - 30 * 60_000,
    ...inWindow.map((market) => new Date(market.eventStartTime).getTime() - 90_000),
  ));
  const [books, liveStates, referencePrices, history] = await Promise.all([
    fetchCurrentBooks(tokenIds).catch(() => new Map()),
    fetchHyperliquidMarketStates().catch(() => []),
    fetchPolymarketReferencePrices(assets).catch(() => []),
    prisma.hyperliquidSnapshot.findMany({
      where: {
        asset: { in: [...supportedAssets] },
        capturedAt: { gte: historyStart, lte: now },
      },
      orderBy: { capturedAt: "asc" },
    }),
  ]);
  const liveByAsset = new Map(liveStates.map((state) => [state.asset, state]));
  const historyByAsset = new Map<string, typeof history>();
  for (const row of history) historyByAsset.set(row.asset, [...(historyByAsset.get(row.asset) ?? []), row]);

  const signals = inWindow.flatMap((market): CombinedLiveSignal[] => {
    const book = books.get(market.tokenId);
    const bestBid = book?.bids[0]?.price ?? null;
    const bestAsk = book?.asks[0]?.price ?? null;
    if (bestBid === null || bestAsk === null || bestAsk < bestBid || bestAsk - bestBid > maximumSpread) return [];
    const marketProbability = clamp((bestBid + bestAsk) / 2, 0.01, 0.99);
    const state = liveByAsset.get(market.asset);
    if (!state || state.midPrice <= 0) return [];
    const startAt = new Date(market.eventStartTime);
    const endAt = new Date(market.endDate as string);
    const rows = historyByAsset.get(market.asset) ?? [];
    const startPrice = nearestPrice(rows, startAt, 90_000);
    if (startPrice === null) return [];
    const elapsedHours = Math.max((now.getTime() - startAt.getTime()) / 3_600_000, 1 / 60);
    const remainingHours = Math.max((endAt.getTime() - now.getTime()) / 3_600_000, 0);
    const momentum = Math.log(state.midPrice / startPrice);
    const volatility24h = estimateVolatility24h(rows.map((row) => row.midPrice));
    const horizonVolatility = Math.max(volatility24h * Math.sqrt(elapsedHours / 24), 0.0003);
    const trendZ = momentum / horizonVolatility;
    const projectedMove = clamp(momentum * (remainingHours / elapsedHours), -0.03, 0.03);
    const asset = market.asset as CombinedLiveSignal["asset"];
    const reference = selectReferencePrice(referencePrices, asset, market.referenceSource);
    const signalZ = (marketProbability - 0.5) / 0.08;

    return [{
      eventId: market.eventId as string,
      marketId: market.id,
      asset,
      observedAt: now.toISOString(),
      exitAt: endAt.toISOString(),
      horizonHours: shortTermDirectionHorizonKey,
      actualHoursToEnd: remainingHours,
      marketProbability,
      marketBestBid: bestBid,
      marketBestAsk: bestAsk,
      marketSpread: bestAsk - bestBid,
      polymarketReferencePrice: reference?.price ?? null,
      referenceSource: reference?.source ?? null,
      referenceCapturedAt: reference?.capturedAt ?? null,
      spotPrice: state.midPrice,
      priceBasisPct: reference ? calculatePriceBasisPct(state.midPrice, reference.price) : null,
      impliedTarget: state.midPrice * Math.exp(projectedMove),
      realizedVolatility24h: volatility24h,
      hyperliquidMomentum6h: momentum,
      trendZ6h: trendZ,
      hyperliquidFunding24h: Number.isFinite(state.fundingRate) ? state.fundingRate * 24 : null,
      signalZ,
      side: signalZ >= 0 ? "LONG" : "SHORT",
      sourceMarkets: 1,
      ladderViolations: 0,
      ladderAdjustmentRms: 0,
    }];
  }).sort((left, right) => Math.abs(right.signalZ) - Math.abs(left.signalZ));
  const signal = signals[0] ?? null;
  const reason = signal
    ? `${signals.length}件の15分Up/Down市場を開始2分後の板で判定`
    : "板の厚さ、スプレッド、または開始時のHyperliquid価格が不足しています";
  const horizon: CombinedHorizonSignalScan = {
    horizonHours: shortTermDirectionHorizonKey,
    signal,
    signals,
    horizonEligibleMarkets: inWindow.length,
    groupedEvents: inWindow.length,
    priceReadyEvents: signals.length,
    nextWindowAt,
    closestHoursToEnd,
    reason,
  };
  return {
    signal,
    signals,
    horizons: [horizon],
    scannedMarkets: markets.length,
    structuredMarkets: structured.length,
    horizonEligibleMarkets: inWindow.length,
    groupedEvents: inWindow.length,
    priceReadyEvents: signals.length,
    eligibleEvents: signals.length,
    nextWindowAt,
    closestHoursToEnd,
    reason,
  };
}

function emptyHorizonScan(input: { nextWindowAt: string | null; closestHoursToEnd: number | null }): CombinedHorizonSignalScan {
  return {
    horizonHours: shortTermDirectionHorizonKey,
    signal: null,
    signals: [],
    horizonEligibleMarkets: 0,
    groupedEvents: 0,
    priceReadyEvents: 0,
    nextWindowAt: input.nextWindowAt,
    closestHoursToEnd: input.closestHoursToEnd,
    reason: input.nextWindowAt ? `次回は${formatJapanTime(input.nextWindowAt)}` : "15分市場を待っています",
  };
}

function nearestPrice(rows: Array<{ capturedAt: Date; midPrice: number }>, at: Date, toleranceMs: number) {
  const candidate = [...rows]
    .filter((row) => Math.abs(row.capturedAt.getTime() - at.getTime()) <= toleranceMs)
    .sort((left, right) => Math.abs(left.capturedAt.getTime() - at.getTime()) - Math.abs(right.capturedAt.getTime() - at.getTime()))[0];
  return candidate?.midPrice && candidate.midPrice > 0 ? candidate.midPrice : null;
}

function estimateVolatility24h(prices: number[]) {
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index])).filter(Number.isFinite);
  if (returns.length < 3) return 0.02;
  const realized = Math.sqrt(returns.reduce((total, value) => total + value ** 2, 0) * (1_440 / returns.length));
  return clamp(realized, 0.005, 0.25);
}

function findNextDecisionAt(markets: ActiveCryptoDirectionMarket[], now: Date) {
  const next = markets
    .map((market) => new Date(market.eventStartTime).getTime() + decisionDelayMinutes * 60_000)
    .filter((timestamp) => timestamp > now.getTime())
    .sort((left, right) => left - right)[0];
  return next ? new Date(next).toISOString() : null;
}

function findClosestHoursToEnd(markets: ActiveCryptoDirectionMarket[], now: Date) {
  const values = markets.flatMap((market) => market.endDate
    ? [(new Date(market.endDate).getTime() - now.getTime()) / 3_600_000]
    : []);
  return values.length ? values.sort((left, right) => Math.abs(left) - Math.abs(right))[0] : null;
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
