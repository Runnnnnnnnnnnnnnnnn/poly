import { discoverActiveCryptoPriceMarkets, discoverCryptoMarkets, fetchCurrentBook } from "@/src/lib/backtest/polymarket";
import type { CryptoMarket } from "@/src/lib/backtest/types";
import { impliedTerminalMedianForCondition } from "@/src/lib/model-evaluation/combined-trading";
import { parseTerminalPriceCondition } from "@/src/lib/model-evaluation/price-structure";
import { prisma } from "@/src/lib/server/prisma";

const supportedAssets = ["BTC", "ETH", "SOL", "XRP"] as const;
const minimumHoursToEnd = 21;
const maximumHoursToEnd = 27;

export type CombinedLiveSignal = {
  eventId: string;
  marketId: string;
  asset: (typeof supportedAssets)[number];
  observedAt: string;
  exitAt: string;
  marketProbability: number;
  spotPrice: number;
  impliedTarget: number;
  realizedVolatility24h: number;
  signalZ: number;
  side: "LONG" | "SHORT";
  sourceMarkets: number;
};

export type CombinedSignalScan = {
  signal: CombinedLiveSignal | null;
  scannedMarkets: number;
  eligibleEvents: number;
  reason: string;
};

export async function scanCombinedLiveSignal(now = new Date()): Promise<CombinedSignalScan> {
  const [activeEvents, discovered] = await Promise.all([
    discoverActiveCryptoPriceMarkets().catch(() => []),
    discoverCryptoMarkets({ includeResolved: false, limit: 180 }),
  ]);
  const markets = Array.from(new Map([...activeEvents, ...discovered].map((market) => [market.id, market])).values());
  const eligible = markets.filter((market) => isEligibleMarket(market, now));
  const groups = groupMarkets(eligible)
    .sort((left, right) => right.volume - left.volume)
    .slice(0, 10);
  if (!groups.length) {
    return { signal: null, scannedMarkets: markets.length, eligibleEvents: 0, reason: "24時間前後で終了する価格市場がありません" };
  }

  const priceStates = await loadPriceStates(now);
  const signals = (await mapWithConcurrency(groups, 4, async (group) => {
    const priceState = priceStates.get(group.asset);
    if (!priceState) return null;
    const probabilities = await mapWithConcurrency(group.markets.slice(0, 12), 6, currentProbability);
    const estimates = group.markets.slice(0, 12).flatMap((market, index) => {
      const condition = parseTerminalPriceCondition(market.title);
      const probability = probabilities[index];
      if (!condition || condition.kind === "between" || probability === null) return [];
      const target = impliedTerminalMedianForCondition(condition.kind, condition.lower, condition.upper, probability, priceState.volatility24h);
      if (target === null) return [];
      return [{ market, probability, target, weight: probability * (1 - probability) }];
    });
    if (estimates.length < 2) return null;

    const totalWeight = estimates.reduce((sum, estimate) => sum + estimate.weight, 0);
    if (totalWeight <= 0) return null;
    const impliedTarget = Math.exp(estimates.reduce((sum, estimate) => sum + Math.log(estimate.target) * estimate.weight, 0) / totalWeight);
    const signalZ = Math.log(impliedTarget / priceState.spotPrice) / priceState.volatility24h;
    if (!Number.isFinite(signalZ)) return null;
    const representative = [...estimates].sort((left, right) => right.market.volume - left.market.volume)[0];

    return {
      eventId: group.eventId,
      marketId: representative.market.id,
      asset: group.asset,
      observedAt: now.toISOString(),
      exitAt: group.endDate.toISOString(),
      marketProbability: representative.probability,
      spotPrice: priceState.spotPrice,
      impliedTarget,
      realizedVolatility24h: priceState.volatility24h,
      signalZ,
      side: signalZ >= 0 ? "LONG" as const : "SHORT" as const,
      sourceMarkets: estimates.length,
    };
  })).filter((signal): signal is CombinedLiveSignal => Boolean(signal));

  const signal = signals.sort((left, right) => Math.abs(right.signalZ) - Math.abs(left.signalZ))[0] ?? null;
  return {
    signal,
    scannedMarkets: markets.length,
    eligibleEvents: signals.length,
    reason: signal ? `${signal.asset}の${signal.sourceMarkets}市場から方向を算出` : "価格帯を束ねられる市場または相場データが不足しています",
  };
}

function isEligibleMarket(market: CryptoMarket, now: Date) {
  if (market.resolved || market.currentProbability === null || !market.eventId || !market.endDate) return false;
  if (!supportedAssets.includes(market.asset as (typeof supportedAssets)[number])) return false;
  const condition = parseTerminalPriceCondition(market.title);
  if (!condition || condition.kind === "between") return false;
  const hoursToEnd = (new Date(market.endDate).getTime() - now.getTime()) / (60 * 60 * 1_000);
  return hoursToEnd >= minimumHoursToEnd && hoursToEnd <= maximumHoursToEnd;
}

function groupMarkets(markets: CryptoMarket[]) {
  const groups = new Map<string, {
    eventId: string;
    asset: CombinedLiveSignal["asset"];
    endDate: Date;
    volume: number;
    markets: CryptoMarket[];
  }>();
  for (const market of markets) {
    const key = `${market.eventId}:${market.asset}:${market.endDate}`;
    const existing = groups.get(key);
    if (existing) {
      existing.markets.push(market);
      existing.volume += market.volume;
    } else {
      groups.set(key, {
        eventId: market.eventId as string,
        asset: market.asset as CombinedLiveSignal["asset"],
        endDate: new Date(market.endDate as string),
        volume: market.volume,
        markets: [market],
      });
    }
  }
  return Array.from(groups.values()).filter((group) => group.markets.length >= 2);
}

async function currentProbability(market: CryptoMarket) {
  const book = await fetchCurrentBook(market.tokenId).catch(() => null);
  const bestBid = book?.bids[0]?.price;
  const bestAsk = book?.asks[0]?.price;
  if (typeof bestBid === "number" && typeof bestAsk === "number" && bestAsk >= bestBid) {
    return clamp((bestBid + bestAsk) / 2, 0.01, 0.99);
  }
  return market.currentProbability === null ? null : clamp(market.currentProbability, 0.01, 0.99);
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

  const states = new Map<CombinedLiveSignal["asset"], { spotPrice: number; volatility24h: number }>();
  for (const asset of supportedAssets) {
    const assetRows = grouped.get(asset) ?? [];
    const hourly = new Map<number, (typeof assetRows)[number]>();
    for (const row of assetRows) hourly.set(Math.floor(row.capturedAt.getTime() / (60 * 60 * 1_000)), row);
    const prices = Array.from(hourly.values()).sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime()).map((row) => row.midPrice);
    if (prices.length < 12) continue;
    const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index])).filter(Number.isFinite).slice(-24);
    const volatility24h = clamp(Math.sqrt(returns.reduce((sum, value) => sum + value ** 2, 0)), 0.005, 0.25);
    states.set(asset, { spotPrice: prices.at(-1) as number, volatility24h });
  }
  return states;
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
