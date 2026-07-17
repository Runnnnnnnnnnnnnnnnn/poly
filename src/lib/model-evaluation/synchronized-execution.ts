import type { MarketSnapshot, Prisma } from "@prisma/client";

import { parseTerminalPriceCondition, probabilityForCondition } from "@/src/lib/model-evaluation/price-structure";
import type { EvaluationSample } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";

const maximumSignalAgeMs = 5 * 60 * 1_000;
const maximumEntryLagMs = 5 * 60 * 1_000;
const maximumExitLeadMs = 5 * 60 * 1_000;
export const synchronizedSnapshotWhere = {
  synchronizationVersion: "fetch-time-v3-orderbook",
  bestBid: { not: null },
  bestAsk: { not: null },
  spread: { not: null },
  hyperliquidMidPrice: { not: null },
  hyperliquidBestBid: { not: null },
  hyperliquidBestAsk: { not: null },
  hyperliquidSpread: { not: null },
  referencePrice: { not: null },
  priceBasisPct: { not: null },
  captureSkewMs: { lte: 60_000 },
} satisfies Prisma.MarketSnapshotWhereInput;

type ExactSnapshot = Pick<
  MarketSnapshot,
  "capturedAt" | "probability" | "bestBid" | "bestAsk" | "spread" | "hyperliquidMidPrice" | "hyperliquidBestBid"
  | "hyperliquidBestAsk" | "hyperliquidSpread" | "priceBasisPct" | "captureSkewMs"
>;

export async function overlaySynchronizedExecution(samples: EvaluationSample[]) {
  if (!samples.length) return samples;
  const bounds = await prisma.marketSnapshot.aggregate({
    where: synchronizedSnapshotWhere,
    _min: { capturedAt: true },
    _max: { capturedAt: true },
  });
  const firstAt = bounds._min.capturedAt?.getTime();
  const lastAt = bounds._max.capturedAt?.getTime();
  if (firstAt === undefined || lastAt === undefined) return samples;

  const output = [...samples];
  const candidates = samples.flatMap((sample, index) => {
    const endAt = new Date(sample.endAt).getTime();
    const targetAt = endAt - (sample.horizonHours ?? 24) * 60 * 60 * 1_000;
    return targetAt >= firstAt
      && targetAt <= lastAt
      && endAt >= firstAt
      && endAt - maximumExitLeadMs <= lastAt
      ? [{ sample, index, targetAt, endAt }]
      : [];
  });

  await mapWithConcurrency(candidates, 6, async ({ sample, index, targetAt, endAt }) => {
    const signal = await prisma.marketSnapshot.findFirst({
      where: {
        ...synchronizedSnapshotWhere,
        marketId: sample.marketId,
        capturedAt: { gte: new Date(targetAt - maximumSignalAgeMs), lte: new Date(targetAt) },
      },
      orderBy: { capturedAt: "desc" },
      select: exactSnapshotSelect,
    });
    if (!signal) return;
    const [entry, exit] = await Promise.all([
      prisma.marketSnapshot.findFirst({
        where: {
          ...synchronizedSnapshotWhere,
          marketId: sample.marketId,
          capturedAt: {
            gt: new Date(targetAt),
            lte: new Date(Math.min(endAt, targetAt + maximumEntryLagMs)),
          },
        },
        orderBy: { capturedAt: "asc" },
        select: exactSnapshotSelect,
      }),
      prisma.marketSnapshot.findFirst({
        where: {
          ...synchronizedSnapshotWhere,
          marketId: sample.marketId,
          capturedAt: { gte: new Date(endAt - maximumExitLeadMs), lte: new Date(endAt) },
        },
        orderBy: { capturedAt: "desc" },
        select: exactSnapshotSelect,
      }),
    ]);
    if (!entry || !exit) return;
    output[index] = applySynchronizedExecutionOverlay(sample, { signal, entry, exit, targetAt, endAt });
  });
  return output;
}

export function applySynchronizedExecutionOverlay(
  sample: EvaluationSample,
  input: { signal: ExactSnapshot; entry: ExactSnapshot; exit: ExactSnapshot; targetAt: number; endAt: number },
): EvaluationSample {
  const { signal, entry, exit, targetAt, endAt } = input;
  const condition = parseTerminalPriceCondition(sample.title);
  const realizedVolatility24h = sample.realizedVolatility24h;
  const horizonHours = sample.horizonHours ?? Math.max(1, (endAt - targetAt) / (60 * 60 * 1_000));
  const horizonVolatility = typeof realizedVolatility24h === "number"
    ? realizedVolatility24h * Math.sqrt(horizonHours / 24)
    : null;
  const structuralProbability = condition && horizonVolatility !== null && signal.hyperliquidMidPrice !== null
    ? probabilityForCondition(signal.hyperliquidMidPrice, horizonVolatility, condition)
    : sample.structuralProbability;
  const timingValues = [signal.captureSkewMs, entry.captureSkewMs, exit.captureSkewMs]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    ...sample,
    observedAt: signal.capturedAt.toISOString(),
    marketProbability: signal.probability,
    observationLagMinutes: Math.max(0, targetAt - signal.capturedAt.getTime()) / (60 * 1_000),
    structuralProbability,
    spotPrice: signal.hyperliquidMidPrice,
    hyperliquidEntryAt: entry.capturedAt.toISOString(),
    hyperliquidEntryPrice: entry.hyperliquidMidPrice,
    hyperliquidEntryBestBid: entry.hyperliquidBestBid,
    hyperliquidEntryBestAsk: entry.hyperliquidBestAsk,
    hyperliquidEntrySpread: entry.hyperliquidSpread,
    hyperliquidExitAt: exit.capturedAt.toISOString(),
    hyperliquidExitPrice: exit.hyperliquidMidPrice,
    hyperliquidExitBestBid: exit.hyperliquidBestBid,
    hyperliquidExitBestAsk: exit.hyperliquidBestAsk,
    hyperliquidExitSpread: exit.hyperliquidSpread,
    hyperliquidEntryLagMinutes: Math.max(0, entry.capturedAt.getTime() - targetAt) / (60 * 1_000),
    hyperliquidExitLeadMinutes: Math.max(0, endAt - exit.capturedAt.getTime()) / (60 * 1_000),
    executionPriceSource: "synchronized-1m",
    marketBestBid: signal.bestBid,
    marketBestAsk: signal.bestAsk,
    marketSpread: signal.spread,
    executionPriceBasisPct: signal.priceBasisPct,
    executionSynchronizationSkewMs: timingValues.length ? Math.max(...timingValues) : null,
  };
}

const exactSnapshotSelect = {
  capturedAt: true,
  probability: true,
  bestBid: true,
  bestAsk: true,
  spread: true,
  hyperliquidMidPrice: true,
  hyperliquidBestBid: true,
  hyperliquidBestAsk: true,
  hyperliquidSpread: true,
  priceBasisPct: true,
  captureSkewMs: true,
} satisfies Prisma.MarketSnapshotSelect;

async function mapWithConcurrency<T>(items: T[], concurrency: number, mapper: (item: T) => Promise<void>) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
