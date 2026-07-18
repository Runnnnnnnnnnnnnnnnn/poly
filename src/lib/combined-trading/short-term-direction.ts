import { createHash } from "node:crypto";

import {
  discoverActiveCryptoDirectionMarkets,
  type ActiveCryptoDirectionMarket,
} from "@/src/lib/backtest/polymarket";
import type {
  CombinedHorizonSignalScan,
  CombinedLiveSignal,
  CombinedSignalScan,
} from "@/src/lib/combined-trading/live-signal";
import { realtimeSynchronizationVersion } from "@/src/lib/realtime-market-data/collector";
import { prisma } from "@/src/lib/server/prisma";

export const shortTermDirectionHorizonKey = 0;
export const shortTermDirectionStrategyKey = "poly-updown-hl-trend-forward-v7-m15";
export const shortTermDirectionControlKey = "poly-updown-forward-control-v7-m15";

export const shortTermDirectionSpecification = Object.freeze({
  version: 7,
  executionAuditVersion: 3,
  decisionDataSource: "persisted-synchronized-5s-orderbook",
  independentSampleUnit: "15-minute-window",
  strategyTrials: 11,
  supportedAssets: ["BTC", "ETH", "SOL", "XRP"] as const,
  targetDurationMinutes: 15,
  durationToleranceMinutes: 0.5,
  decisionDelayMinutes: 2,
  decisionWindowMinutes: 2,
  maximumSpread: 0.08,
  historyLookbackMinutes: 30,
  maximumDecisionTickAgeMs: 15_000,
  startPriceToleranceMs: 90_000,
  marketProbabilityMinimum: 0.01,
  marketProbabilityMaximum: 0.99,
  probabilityCenter: 0.5,
  probabilityScale: 0.08,
  projectedMoveLimit: 0.03,
  fallbackVolatility24h: 0.02,
  minimumVolatility24h: 0.005,
  maximumVolatility24h: 0.25,
  horizonVolatilityFloor: 0.0003,
  observationsPerDay: 1_440,
});
export const shortTermDirectionSpecificationHash = createHash("sha256")
  .update(JSON.stringify(shortTermDirectionSpecification))
  .digest("hex")
  .slice(0, 16);

const supportedAssets = shortTermDirectionSpecification.supportedAssets;
const targetDurationMinutes = shortTermDirectionSpecification.targetDurationMinutes;
const decisionDelayMinutes = shortTermDirectionSpecification.decisionDelayMinutes;
const decisionWindowMinutes = shortTermDirectionSpecification.decisionWindowMinutes;
const maximumSpread = shortTermDirectionSpecification.maximumSpread;

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
  if (Math.abs(market.durationMinutes - targetDurationMinutes) > shortTermDirectionSpecification.durationToleranceMinutes) return false;
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
    && Math.abs(market.durationMinutes - targetDurationMinutes) <= shortTermDirectionSpecification.durationToleranceMinutes
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

  const historyStart = new Date(Math.min(
    now.getTime() - shortTermDirectionSpecification.historyLookbackMinutes * 60_000,
    ...inWindow.map((market) => new Date(market.eventStartTime).getTime() - shortTermDirectionSpecification.startPriceToleranceMs),
  ));
  const [synchronizedTicks, history] = await Promise.all([
    prisma.realtimeMarketTick.findMany({
      where: {
        marketId: { in: inWindow.map((market) => market.id) },
        synchronizationVersion: realtimeSynchronizationVersion,
        capturedAt: { gte: historyStart, lte: now },
      },
      orderBy: { capturedAt: "asc" },
    }),
    prisma.hyperliquidSnapshot.findMany({
      where: {
        asset: { in: [...supportedAssets] },
        capturedAt: { gte: historyStart, lte: now },
      },
      orderBy: { capturedAt: "asc" },
    }),
  ]);
  const ticksByMarket = new Map<string, typeof synchronizedTicks>();
  for (const tick of synchronizedTicks) ticksByMarket.set(tick.marketId, [...(ticksByMarket.get(tick.marketId) ?? []), tick]);
  const historyByAsset = new Map<string, typeof history>();
  for (const row of history) historyByAsset.set(row.asset, [...(historyByAsset.get(row.asset) ?? []), row]);

  const signals = inWindow.flatMap((market): CombinedLiveSignal[] => {
    const ticks = ticksByMarket.get(market.id) ?? [];
    const decisionTick = selectLatestSynchronizedDecisionTick(
      ticks,
      now,
      shortTermDirectionSpecification.maximumDecisionTickAgeMs,
    );
    const bestBid = decisionTick?.polymarketBestBid ?? null;
    const bestAsk = decisionTick?.polymarketBestAsk ?? null;
    if (bestBid === null || bestAsk === null || bestAsk < bestBid || bestAsk - bestBid > maximumSpread) return [];
    const marketProbability = clamp(
      (bestBid + bestAsk) / 2,
      shortTermDirectionSpecification.marketProbabilityMinimum,
      shortTermDirectionSpecification.marketProbabilityMaximum,
    );
    if (!decisionTick || decisionTick.hyperliquidMidPrice <= 0) return [];
    const startAt = new Date(market.eventStartTime);
    const endAt = new Date(market.endDate as string);
    const rows = historyByAsset.get(market.asset) ?? [];
    const startPrice = selectCausalStartPrice(ticks, startAt, shortTermDirectionSpecification.startPriceToleranceMs);
    if (startPrice === null) return [];
    const elapsedHours = Math.max((now.getTime() - startAt.getTime()) / 3_600_000, 1 / 60);
    const remainingHours = Math.max((endAt.getTime() - now.getTime()) / 3_600_000, 0);
    const momentum = Math.log(decisionTick.hyperliquidMidPrice / startPrice);
    const volatility24h = estimateVolatility24h(rows.map((row) => row.midPrice));
    const horizonVolatility = Math.max(
      volatility24h * Math.sqrt(elapsedHours / 24),
      shortTermDirectionSpecification.horizonVolatilityFloor,
    );
    const trendZ = momentum / horizonVolatility;
    const projectedMove = clamp(
      momentum * (remainingHours / elapsedHours),
      -shortTermDirectionSpecification.projectedMoveLimit,
      shortTermDirectionSpecification.projectedMoveLimit,
    );
    const asset = market.asset as CombinedLiveSignal["asset"];
    const signalZ = (
      marketProbability - shortTermDirectionSpecification.probabilityCenter
    ) / shortTermDirectionSpecification.probabilityScale;

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
      polymarketReferencePrice: decisionTick.referencePrice,
      referenceSource: decisionTick.referenceSource === "BINANCE" || decisionTick.referenceSource === "CHAINLINK"
        ? decisionTick.referenceSource
        : null,
      referenceCapturedAt: decisionTick.referenceUpdatedAt.toISOString(),
      spotPrice: decisionTick.hyperliquidMidPrice,
      priceBasisPct: decisionTick.priceBasisPct,
      impliedTarget: decisionTick.hyperliquidMidPrice * Math.exp(projectedMove),
      realizedVolatility24h: volatility24h,
      hyperliquidMomentum6h: momentum,
      trendZ6h: trendZ,
      hyperliquidFunding24h: typeof decisionTick.hyperliquidFundingRate === "number" && Number.isFinite(decisionTick.hyperliquidFundingRate)
        ? decisionTick.hyperliquidFundingRate * 24
        : null,
      signalZ,
      side: signalZ >= 0 ? "LONG" : "SHORT",
      sourceMarkets: 1,
      ladderViolations: 0,
      ladderAdjustmentRms: 0,
    }];
  }).sort((left, right) => Math.abs(right.signalZ) - Math.abs(left.signalZ));
  const signal = signals[0] ?? null;
  const reason = signal
    ? `${signals.length}件の15分Up/Down市場を同期5秒板で判定`
    : "同期5秒板、スプレッド、または開始時価格が不足しています";
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

export function selectLatestSynchronizedDecisionTick<T extends {
  capturedAt: Date;
  polymarketUpdatedAt: Date;
  negativeUpdatedAt: Date;
  hyperliquidUpdatedAt: Date;
  referenceUpdatedAt: Date;
  captureSkewMs: number;
}>(
  ticks: T[],
  now: Date,
  maximumAgeMs: number,
) {
  return [...ticks]
    .filter((tick) => {
      const ageMs = now.getTime() - tick.capturedAt.getTime();
      const sourceAges = [
        tick.polymarketUpdatedAt,
        tick.negativeUpdatedAt,
        tick.hyperliquidUpdatedAt,
        tick.referenceUpdatedAt,
      ].map((updatedAt) => tick.capturedAt.getTime() - updatedAt.getTime());
      return ageMs >= 0
        && ageMs <= maximumAgeMs
        && tick.captureSkewMs <= maximumAgeMs
        && sourceAges.every((sourceAgeMs) => sourceAgeMs >= -5_000 && sourceAgeMs <= maximumAgeMs);
    })
    .sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime())[0] ?? null;
}

export function selectCausalStartPrice(
  ticks: Array<{ capturedAt: Date; hyperliquidMidPrice: number }>,
  startAt: Date,
  maximumDelayMs: number,
) {
  const candidate = [...ticks]
    .filter((tick) => {
      const delayMs = tick.capturedAt.getTime() - startAt.getTime();
      return delayMs >= 0 && delayMs <= maximumDelayMs && tick.hyperliquidMidPrice > 0;
    })
    .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime())[0];
  return candidate?.hyperliquidMidPrice ?? null;
}

function estimateVolatility24h(prices: number[]) {
  const returns = prices.slice(1).map((price, index) => Math.log(price / prices[index])).filter(Number.isFinite);
  if (returns.length < 3) return shortTermDirectionSpecification.fallbackVolatility24h;
  const realized = Math.sqrt(
    returns.reduce((total, value) => total + value ** 2, 0)
    * (shortTermDirectionSpecification.observationsPerDay / returns.length),
  );
  return clamp(
    realized,
    shortTermDirectionSpecification.minimumVolatility24h,
    shortTermDirectionSpecification.maximumVolatility24h,
  );
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
