import { calculateShortTermImpliedSignal } from "../src/lib/combined-trading/short-term-implied-signal";
import { blockBootstrapMeanConfidenceInterval } from "../src/lib/model-evaluation/combined-trading";
import { realtimeSynchronizationVersion } from "../src/lib/realtime-market-data/collector";
import { prisma } from "../src/lib/server/prisma";

const maximumTimingErrorMs = 15_000;
const takerFeePerSide = 0.00045;
const slippagePerSide = 0.0002;
const roundTripCost = 2 * (takerFeePerSide + slippagePerSide);
const minimumVerifiedTrades = 50;
const maximumDrawdownPct = 0.05;

const ticks = await prisma.realtimeMarketTick.findMany({
  where: { synchronizationVersion: realtimeSynchronizationVersion },
  orderBy: { capturedAt: "asc" },
});
const marketIds = Array.from(new Set(ticks.map((tick) => tick.marketId)));
const outcomes = marketIds.length
  ? await prisma.predictionMarket.findMany({
      where: { id: { in: marketIds } },
      select: { id: true, resolved: true, result: true },
    })
  : [];
const outcomeByMarket = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
const ticksByMarket = groupBy(ticks, (tick) => tick.marketId);
const ticksByAsset = groupBy(uniqueAssetTicks(ticks), (tick) => tick.asset);

const observations = Array.from(ticksByMarket, ([marketId, rows]) => {
  const first = rows[0];
  if (!first || first.marketEndAt > new Date()) return null;
  const start = nearest(rows, first.marketStartAt, (tick) => tick.referenceUpdatedAt);
  const exit = nearest(rows, first.marketEndAt, (tick) => tick.hyperliquidUpdatedAt);
  if (!start || !exit) return null;

  const windowStart = new Date(first.marketStartAt.getTime() + 2 * 60_000);
  const windowEnd = new Date(first.marketStartAt.getTime() + 4 * 60_000);
  const assetTicks = ticksByAsset.get(first.asset) ?? [];
  const samples = rows
    .filter((tick) => tick.capturedAt >= windowStart && tick.capturedAt < windowEnd)
    .map((entry) => {
      const volatility24h = estimateVolatility24h(
        assetTicks.filter((tick) => (
          tick.capturedAt >= new Date(entry.capturedAt.getTime() - 30 * 60_000)
          && tick.capturedAt <= entry.capturedAt
        )),
      );
      const remainingHours = (first.marketEndAt.getTime() - entry.capturedAt.getTime()) / 3_600_000;
      const implied = calculateShortTermImpliedSignal({
        marketProbability: entry.probability,
        thresholdReferencePrice: start.tick.referencePrice,
        currentReferencePrice: entry.referencePrice,
        currentHyperliquidPrice: entry.hyperliquidMidPrice,
        volatility24h,
        remainingHours,
      });
      if (!implied) return null;

      const elapsedHours = Math.max(
        (entry.capturedAt.getTime() - first.marketStartAt.getTime()) / 3_600_000,
        1 / 120,
      );
      const momentum = Math.log(entry.hyperliquidMidPrice / start.tick.hyperliquidMidPrice);
      const trendZ = momentum / Math.max(0.0003, volatility24h * Math.sqrt(elapsedHours / 24));
      const marketSide = entry.probability >= 0.5 ? "LONG" as const : "SHORT" as const;
      const baselineSignalZ = (entry.probability - 0.5) / 0.08;
      return {
        entry,
        volatility24h,
        trendZ,
        marketSide,
        baselineSignalZ,
        baselineSelected: Math.abs(baselineSignalZ) >= 1
          && sideMultiplier(marketSide) * trendZ >= 0.15,
        implied,
        impliedSelected: Math.abs(implied.signalZ) >= 1
          && Math.abs(implied.expectedReturnPct) >= roundTripCost
          && sideMultiplier(implied.side) * trendZ >= 0.15,
      };
    })
    .filter((sample): sample is NonNullable<typeof sample> => Boolean(sample));
  const representative = samples[0];
  if (!representative) return null;
  const baselineSample = samples.find((sample) => sample.baselineSelected);
  const impliedSample = samples.find((sample) => sample.impliedSelected);
  const outcome = outcomeByMarket.get(marketId);

  return {
    marketId,
    asset: first.asset,
    marketStartAt: first.marketStartAt.toISOString(),
    probability: representative.entry.probability,
    volatility24h: representative.volatility24h,
    trendZ: representative.trendZ,
    officialResult: outcome?.resolved ? outcome.result : null,
    baseline: {
      selected: Boolean(baselineSample),
      entryAt: baselineSample?.entry.capturedAt.toISOString() ?? null,
      side: (baselineSample ?? representative).marketSide,
      signalZ: (baselineSample ?? representative).baselineSignalZ,
      returnPct: baselineSample
        ? calculateBookReturn(baselineSample.marketSide, baselineSample.entry, exit.tick)
        : 0,
    },
    implied: {
      selected: Boolean(impliedSample),
      entryAt: impliedSample?.entry.capturedAt.toISOString() ?? null,
      side: (impliedSample ?? representative).implied.side,
      signalZ: (impliedSample ?? representative).implied.signalZ,
      expectedReturnPct: (impliedSample ?? representative).implied.expectedReturnPct,
      returnPct: impliedSample
        ? calculateBookReturn(impliedSample.implied.side, impliedSample.entry, exit.tick)
        : 0,
      benchmarks: impliedSample ? {
        polymarketDirection: calculateBookReturn(impliedSample.marketSide, impliedSample.entry, exit.tick),
        alwaysLong: calculateBookReturn("LONG", impliedSample.entry, exit.tick),
        alwaysShort: calculateBookReturn("SHORT", impliedSample.entry, exit.tick),
      } : null,
    },
  };
}).filter((row): row is NonNullable<typeof row> => Boolean(row));

const baselineSummary = summarize(observations, "baseline");
const impliedSummary = summarize(observations, "implied");
const promotionGates = [
  { id: "audited-trades", label: `${minimumVerifiedTrades} complete audits`, passed: impliedSummary.verifiedTrades >= minimumVerifiedTrades },
  { id: "net-positive", label: "positive after costs", passed: impliedSummary.netReturnPct > 0 },
  { id: "benchmark", label: "95% excess-return lower bound above zero", passed: (impliedSummary.excessConfidenceInterval95?.[0] ?? 0) > 0 },
  { id: "drawdown", label: "maximum drawdown at or below 5%", passed: impliedSummary.maxDrawdownPct <= maximumDrawdownPct },
];

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  synchronizationVersion: realtimeSynchronizationVersion,
  decisionWindowSampling: "first actionable 5s tick in [2m, 4m)",
  completeMarkets: observations.length,
  roundTripCost,
  baseline: baselineSummary,
  implied: impliedSummary,
  promotion: {
    ready: promotionGates.every((gate) => gate.passed),
    passedGates: promotionGates.filter((gate) => gate.passed).length,
    totalGates: promotionGates.length,
    gates: promotionGates,
  },
  observations,
}, null, 2));

function summarize(rows: typeof observations, key: "baseline" | "implied") {
  const selected = rows.filter((row) => row[key].selected);
  const resolved = selected.filter((row) => row.officialResult === 0 || row.officialResult === 1);
  const returns = resolved.map((row) => row[key].returnPct);
  const correct = resolved.filter((row) => (
    (row[key].side === "LONG" && row.officialResult === 1)
    || (row[key].side === "SHORT" && row.officialResult === 0)
  ));
  const benchmark = key === "implied" ? summarizeBenchmarks(resolved) : null;
  return {
    selectedTrades: selected.length,
    verifiedTrades: resolved.length,
    profitableTrades: returns.filter((value) => value > 0).length,
    netReturnPct: sum(returns),
    averageReturnPct: average(returns),
    predictionAccuracy: resolved.length ? correct.length / resolved.length : null,
    meanConfidenceInterval95: blockBootstrapMeanConfidenceInterval(returns),
    maxDrawdownPct: maximumDrawdown(returns),
    benchmarkLabel: benchmark?.label ?? null,
    benchmarkReturnPct: benchmark?.returnPct ?? null,
    excessReturnPct: benchmark?.excessReturnPct ?? null,
    excessConfidenceInterval95: benchmark?.confidenceInterval95 ?? null,
  };
}

function summarizeBenchmarks(rows: typeof observations) {
  const verified = rows.flatMap((row) => row.implied.benchmarks ? [{
    model: row.implied.returnPct,
    ...row.implied.benchmarks,
  }] : []);
  const candidates = [
    { label: "Polymarket direction", key: "polymarketDirection" as const },
    { label: "Always long", key: "alwaysLong" as const },
    { label: "Always short", key: "alwaysShort" as const },
  ].map((candidate) => ({
    ...candidate,
    returnPct: sum(verified.map((row) => row[candidate.key])),
  }));
  const best = [...candidates].sort((left, right) => right.returnPct - left.returnPct)[0];
  const excess = verified.map((row) => row.model - row[best.key]);
  return {
    label: best.label,
    returnPct: best.returnPct,
    excessReturnPct: sum(excess),
    confidenceInterval95: blockBootstrapMeanConfidenceInterval(excess),
  };
}

function calculateBookReturn(
  side: "LONG" | "SHORT",
  entry: (typeof ticks)[number],
  exit: (typeof ticks)[number],
) {
  const multiplier = sideMultiplier(side);
  const rawEntry = side === "LONG" ? entry.hyperliquidBestAsk : entry.hyperliquidBestBid;
  const rawExit = side === "LONG" ? exit.hyperliquidBestBid : exit.hyperliquidBestAsk;
  const entryPrice = rawEntry * (1 + multiplier * slippagePerSide);
  const exitPrice = rawExit * (1 - multiplier * slippagePerSide);
  const quantity = 1 / entryPrice;
  const gross = multiplier * quantity * (exitPrice - entryPrice);
  const fees = takerFeePerSide + quantity * exitPrice * takerFeePerSide;
  const holdingDays = Math.max(0, exit.capturedAt.getTime() - entry.capturedAt.getTime()) / 86_400_000;
  const funding24h = (entry.hyperliquidFundingRate ?? 0) * 24 * multiplier;
  return gross - fees - funding24h * holdingDays;
}

function nearest<T>(rows: T[], target: Date, timestamp: (row: T) => Date) {
  let candidate: { tick: T; errorMs: number } | null = null;
  for (const row of rows) {
    const errorMs = Math.abs(timestamp(row).getTime() - target.getTime());
    if (errorMs <= maximumTimingErrorMs && (!candidate || errorMs < candidate.errorMs)) {
      candidate = { tick: row, errorMs };
    }
  }
  return candidate;
}

function uniqueAssetTicks(rows: typeof ticks) {
  const unique = new Map<string, (typeof ticks)[number]>();
  for (const row of rows) unique.set(`${row.asset}:${row.capturedAt.getTime()}`, row);
  return Array.from(unique.values()).sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
}

function estimateVolatility24h(rows: typeof ticks) {
  if (rows.length < 30) return 0.02;
  let variance = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const gapMs = current.capturedAt.getTime() - previous.capturedAt.getTime();
    if (gapMs <= 0 || gapMs > 20_000) continue;
    const value = Math.log(current.hyperliquidMidPrice / previous.hyperliquidMidPrice);
    if (Number.isFinite(value)) variance += value ** 2;
  }
  const durationMs = rows.at(-1)!.capturedAt.getTime() - rows[0]!.capturedAt.getTime();
  if (variance <= 0 || durationMs <= 0) return 0.02;
  return clamp(Math.sqrt(variance * (86_400_000 / durationMs)), 0.005, 0.25);
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}

function sideMultiplier(side: "LONG" | "SHORT") {
  return side === "LONG" ? 1 : -1;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : null;
}

function maximumDrawdown(returns: number[]) {
  let equity = 1;
  let peak = 1;
  let maximum = 0;
  for (const value of returns) {
    equity *= Math.max(0, 1 + value);
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak > 0 ? (peak - equity) / peak : 0);
  }
  return maximum;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
