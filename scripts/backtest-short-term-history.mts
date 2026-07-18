import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateShortTermImpliedSignal } from "../src/lib/combined-trading/short-term-implied-signal";
import {
  blockBootstrapMeanConfidenceInterval,
  deflatedSharpeProbability,
} from "../src/lib/model-evaluation/combined-trading";
import { annualizeRealizedVolatility } from "../src/lib/model-evaluation/volatility";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const HYPERLIQUID_API = "https://api.hyperliquid.xyz/info";
const supportedAssets = ["BTC", "ETH", "SOL", "XRP"] as const;
const marketDuration = process.env.SHORT_TERM_MARKET_DURATION === "4h"
  ? { slug: "4h", milliseconds: 4 * 60 * 60_000, decisionStartMs: 15 * 60_000, decisionEndMs: 30 * 60_000, warmupMs: 24 * 60 * 60_000, candleInterval: "15m", candleMs: 15 * 60_000, maximumLookbackHours: 720 }
  : { slug: "15m", milliseconds: 15 * 60_000, decisionStartMs: 2 * 60_000, decisionEndMs: 4 * 60_000, warmupMs: 30 * 60_000, candleInterval: "1m", candleMs: 60_000, maximumLookbackHours: 72 };
const lookbackHours = boundedNumber(process.env.SHORT_TERM_HISTORY_HOURS, 48, 12, marketDuration.maximumLookbackHours);
const calibrationFraction = 0.6;
const takerFeePerSide = 0.00045;
const makerFeePerSide = 0.00015;
const slippagePerSide = 0.0002;
const fundingPer24h = 0.0003;
const positionPct = 0.05;
const maximumConcurrentPositions = 3;
const executionMode = process.env.SHORT_TERM_EXECUTION_MODE === "maker-entry" ? "maker-entry" as const : "taker" as const;
const makerLimitOffset = 0.0001;
const roundTripCost = executionMode === "maker-entry"
  ? makerFeePerSide + takerFeePerSide + slippagePerSide
  : 2 * (takerFeePerSide + slippagePerSide);
const impliedMinimumSignalZ = boundedNumber(process.env.SHORT_TERM_IMPLIED_MIN_Z, 0, 0, 3);
const impliedCostMultiplier = boundedNumber(process.env.SHORT_TERM_IMPLIED_COST_MULTIPLIER, 1, 1, 5);
const impliedMinimumTrendZ = boundedNumber(process.env.SHORT_TERM_IMPLIED_MIN_TREND_Z, 0.15, 0, 3);
const impliedRequireTrend = process.env.SHORT_TERM_IMPLIED_REQUIRE_TREND === "1";
const leadLagMinimumProbabilityChange = boundedNumber(process.env.SHORT_TERM_LEAD_LAG_MIN_CHANGE, 0.1, 0.01, 0.5);
const leadLagRequireTrend = process.env.SHORT_TERM_LEAD_LAG_REQUIRE_TREND === "1";
const strategyTrials = Math.round(boundedNumber(process.env.SHORT_TERM_STRATEGY_TRIALS, 11, 1, 100));
const randomBenchmarkTrials = Math.round(boundedNumber(process.env.SHORT_TERM_RANDOM_TRIALS, 200, 20, 1_000));
const walkForwardFolds = Math.round(boundedNumber(process.env.SHORT_TERM_WALK_FORWARD_FOLDS, 4, 3, 8));
const minimumProfitableFolds = Math.ceil(walkForwardFolds * 0.75);

const marketSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string().nullable().optional(),
  eventStartTime: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  clobTokenIds: z.unknown().optional(),
  outcomePrices: z.unknown().optional(),
}).passthrough();
const historyResponseSchema = z.object({
  history: z.record(z.string(), z.array(z.object({ t: z.number(), p: z.number() }))).default({}),
});
const candleSchema = z.object({
  t: z.number(),
  T: z.number(),
  o: z.string(),
  c: z.string(),
  h: z.string(),
  l: z.string(),
});

type Asset = (typeof supportedAssets)[number];
type HistoryPoint = z.infer<typeof historyResponseSchema>["history"][string][number];
type Candle = z.infer<typeof candleSchema>;
type DirectionMarket = {
  id: string;
  asset: Asset;
  tokenId: string;
  startAt: Date;
  endAt: Date;
  officialResult: 0 | 1;
};

const generatedAt = new Date();
const latestSafeEndAtMs = generatedAt.getTime() - 5 * 60_000;
const requestedEndAtMs = Date.parse(process.env.SHORT_TERM_HISTORY_END_AT ?? "");
const endAt = new Date(Number.isFinite(requestedEndAtMs)
  ? Math.min(requestedEndAtMs, latestSafeEndAtMs)
  : latestSafeEndAtMs);
const startAt = new Date(endAt.getTime() - lookbackHours * 60 * 60_000);
const candleStartAt = new Date(startAt.getTime() - marketDuration.warmupMs);
const markets = await fetchDirectionMarkets(startAt, endAt);
const [historyByToken, candlesByAsset] = await Promise.all([
  fetchPolymarketHistory(markets, startAt, endAt),
  fetchHyperliquidCandles(candleStartAt, endAt),
]);

const skipCounts = new Map<string, number>();
const impliedDiagnostics: Array<{ expectedReturnPct: number; signalZ: number; trendZ: number; probabilityChange: number }> = [];
const observations = markets.flatMap((market) => {
  const history = historyByToken.get(market.tokenId) ?? [];
  const candles = candlesByAsset.get(market.asset) ?? [];
  const startCandle = candleAt(candles, market.startAt.getTime());
  const exitCandle = candleAt(candles, market.endAt.getTime() - marketDuration.candleMs);
  if (!history.length) return skipped("Polymarket history missing");
  if (!startCandle || !exitCandle) return skipped("Hyperliquid boundary candle missing");

  const samples = history
    .filter((point) => point.t * 1_000 >= market.startAt.getTime() + marketDuration.decisionStartMs)
    .filter((point) => point.t * 1_000 < market.startAt.getTime() + marketDuration.decisionEndMs)
    .flatMap((point) => {
      const entryTime = Math.floor((point.t * 1_000) / marketDuration.candleMs) * marketDuration.candleMs;
      const entryCandle = candleAt(candles, entryTime);
      if (!entryCandle) return [];
      const prior = candles.filter((candle) => (
        candle.t >= entryTime - marketDuration.warmupMs && candle.t < entryTime
      ));
      const volatility24h = estimateVolatility24h(prior);
      const elapsedHours = Math.max((entryTime - market.startAt.getTime()) / 3_600_000, 1 / 120);
      const remainingHours = Math.max((market.endAt.getTime() - entryTime) / 3_600_000, 1 / 120);
      const startPrice = number(startCandle.o);
      const entryPrice = number(entryCandle.o);
      if (!startPrice || !entryPrice) return [];
      const trendZ = Math.log(entryPrice / startPrice)
        / Math.max(0.0003, volatility24h * Math.sqrt(elapsedHours / 24));
      const baselineSide = point.p >= 0.5 ? "LONG" as const : "SHORT" as const;
      const baselineSignalZ = (point.p - 0.5) / 0.08;
      const controlSelected = Math.abs(baselineSignalZ) >= 1
        && hasEntryExecution(baselineSide, entryCandle, candles);
      const previousPoint = [...history].reverse().find((candidate) => candidate.t < point.t);
      const probabilityChange = previousPoint ? point.p - previousPoint.p : 0;
      const leadLagSide = probabilityChange >= 0 ? "LONG" as const : "SHORT" as const;
      const implied = calculateShortTermImpliedSignal({
        marketProbability: point.p,
        thresholdReferencePrice: startPrice,
        currentReferencePrice: entryPrice,
        currentHyperliquidPrice: entryPrice,
        volatility24h,
        remainingHours,
      });
      if (!implied) return [];
      return [{
        point,
        entryCandle,
        trendZ,
        baselineSide,
        baselineSignalZ,
        controlSelected,
        baselineSelected: Math.abs(baselineSignalZ) >= 1
          && sideMultiplier(baselineSide) * trendZ >= 0.15
          && hasEntryExecution(baselineSide, entryCandle, candles),
        probabilityChange,
        leadLagSide,
        leadLagSelected: Math.abs(probabilityChange) >= leadLagMinimumProbabilityChange
          && (!leadLagRequireTrend || sideMultiplier(leadLagSide) * trendZ >= 0.15)
          && hasEntryExecution(leadLagSide, entryCandle, candles),
        implied,
        impliedSelected: Math.abs(implied.signalZ) >= impliedMinimumSignalZ
          && Math.abs(implied.expectedReturnPct) >= roundTripCost * impliedCostMultiplier
          && (!impliedRequireTrend || sideMultiplier(implied.side) * trendZ >= impliedMinimumTrendZ)
          && hasEntryExecution(implied.side, entryCandle, candles),
      }];
    });
  if (!samples.length) return skipped("decision-window sample missing");
  impliedDiagnostics.push(...samples.map((sample) => ({
    expectedReturnPct: sample.implied.expectedReturnPct,
    signalZ: sample.implied.signalZ,
    trendZ: sample.trendZ,
    probabilityChange: sample.probabilityChange,
  })));
  const representative = samples[0];
  const baseline = samples.find((sample) => sample.baselineSelected);
  const control = samples.find((sample) => sample.controlSelected);
  const implied = samples.find((sample) => sample.impliedSelected);
  const leadLag = samples.find((sample) => sample.leadLagSelected);
  const baselineReturn = baseline
    ? calculateCandleReturn(baseline.baselineSide, baseline.entryCandle, exitCandle, candles) ?? 0
    : 0;
  const controlReturn = control
    ? calculateCandleReturn(control.baselineSide, control.entryCandle, exitCandle, candles) ?? 0
    : 0;
  const impliedReturn = implied
    ? calculateCandleReturn(implied.implied.side, implied.entryCandle, exitCandle, candles) ?? 0
    : 0;
  const leadLagReturn = leadLag
    ? calculateCandleReturn(leadLag.leadLagSide, leadLag.entryCandle, exitCandle, candles) ?? 0
    : 0;
  return [{
    marketId: market.id,
    asset: market.asset,
    startAt: market.startAt.toISOString(),
    officialResult: market.officialResult,
    crossSection: {
      probability: representative.point.p,
      expectedReturnPct: representative.implied.expectedReturnPct,
      trendZ: representative.trendZ,
      longReturnPct: calculateCandleReturn("LONG", representative.entryCandle, exitCandle, candles),
      shortReturnPct: calculateCandleReturn("SHORT", representative.entryCandle, exitCandle, candles),
    },
    baseline: {
      selected: Boolean(baseline),
      side: (baseline ?? representative).baselineSide,
      returnPct: baselineReturn,
      signalStrength: Math.abs((baseline ?? representative).baselineSignalZ),
    },
    control: {
      selected: Boolean(control),
      side: (control ?? representative).baselineSide,
      returnPct: controlReturn,
      signalStrength: Math.abs((control ?? representative).baselineSignalZ),
      alwaysLongReturnPct: control
        ? calculateCandleReturn("LONG", control.entryCandle, exitCandle, candles) ?? 0
        : 0,
      alwaysShortReturnPct: control
        ? calculateCandleReturn("SHORT", control.entryCandle, exitCandle, candles) ?? 0
        : 0,
    },
    implied: {
      selected: Boolean(implied),
      side: (implied ?? representative).implied.side,
      returnPct: impliedReturn,
      benchmarks: implied ? {
        polymarketDirection: calculateCandleReturn(implied.baselineSide, implied.entryCandle, exitCandle, candles) ?? 0,
        alwaysLong: calculateCandleReturn("LONG", implied.entryCandle, exitCandle, candles) ?? 0,
        alwaysShort: calculateCandleReturn("SHORT", implied.entryCandle, exitCandle, candles) ?? 0,
      } : null,
    },
    leadLag: {
      selected: Boolean(leadLag),
      side: (leadLag ?? representative).leadLagSide,
      returnPct: leadLagReturn,
      benchmarks: leadLag ? {
        polymarketDirection: calculateCandleReturn(leadLag.baselineSide, leadLag.entryCandle, exitCandle, candles) ?? 0,
        alwaysLong: calculateCandleReturn("LONG", leadLag.entryCandle, exitCandle, candles) ?? 0,
        alwaysShort: calculateCandleReturn("SHORT", leadLag.entryCandle, exitCandle, candles) ?? 0,
      } : null,
    },
  }];
}).sort((left, right) => left.startAt.localeCompare(right.startAt));

applyConcurrentPositionLimit(observations, "baseline");
applyConcurrentPositionLimit(observations, "control");

const observationTimes = Array.from(new Set(observations.map((row) => row.startAt))).sort();
const splitIndex = Math.floor(observationTimes.length * calibrationFraction);
const calibrationTimes = new Set(observationTimes.slice(0, splitIndex));
const calibration = observations.filter((row) => calibrationTimes.has(row.startAt));
const holdout = observations.filter((row) => !calibrationTimes.has(row.startAt));
const crossSections = buildCrossSectionalTrades(observations);
const calibrationCrossSections = crossSections.filter((row) => calibrationTimes.has(row.startAt));
const holdoutCrossSections = crossSections.filter((row) => !calibrationTimes.has(row.startAt));
const calibrationSummary = summarizePeriod(calibration);
const holdoutSummary = summarizePeriod(holdout);
const calibrationCrossSectional = summarizeCrossSectional(calibrationCrossSections);
const holdoutCrossSectional = summarizeCrossSectional(holdoutCrossSections);
const walkForward = buildWalkForwardValidation(observationTimes, observations, crossSections);
const modelSpecification = {
  version: "short-term-history-v2",
  marketDuration: marketDuration.slug,
  hyperliquidCandleInterval: marketDuration.candleInterval,
  decisionWindowMs: [marketDuration.decisionStartMs, marketDuration.decisionEndMs],
  validation: {
    calibrationFraction,
    walkForwardFolds,
    minimumProfitableFolds,
  },
  execution: {
    mode: executionMode,
    takerFeePerSide,
    makerFeePerSide,
    slippagePerSide,
    fundingPer24h,
    roundTripCost,
    positionPct,
    maximumConcurrentPositions,
    makerLimitOffset,
  },
  rules: {
    baselineMinimumProbability: 0.58,
    baselineMinimumTrendZ: 0.15,
    impliedMinimumSignalZ,
    impliedCostMultiplier,
    impliedMinimumTrendZ,
    impliedRequireTrend,
    leadLagMinimumProbabilityChange,
    leadLagRequireTrend,
    crossSectionalMinimumExpectedPairReturnPct: roundTripCost,
  },
  trials: {
    strategyTrials,
    randomBenchmarkTrials,
  },
};
const reproducibilityRows = researchDatasetRows(observations);
const serializedObservations = researchObservationsCsv(reproducibilityRows);
const runId = generatedAt.toISOString().replaceAll(":", "-");
const reproducibility = {
  runId,
  codeRevision: process.env.POLYMARKET_MODEL_REVISION?.trim() || null,
  hashAlgorithm: "sha256",
  scriptSha256: await sha256File(fileURLToPath(import.meta.url)),
  specificationSha256: sha256Json(modelSpecification),
  datasetSha256: sha256Json(reproducibilityRows),
  observationsCsvSha256: sha256Text(serializedObservations),
  observationRows: reproducibilityRows.length,
  randomSeedPolicy: "deterministic FNV-1a seed by window and trial",
  replayEnvironment: {
    SHORT_TERM_HISTORY_END_AT: endAt.toISOString(),
    SHORT_TERM_HISTORY_HOURS: String(lookbackHours),
    SHORT_TERM_MARKET_DURATION: marketDuration.slug,
    SHORT_TERM_EXECUTION_MODE: executionMode,
    SHORT_TERM_STRATEGY_TRIALS: String(strategyTrials),
    SHORT_TERM_RANDOM_TRIALS: String(randomBenchmarkTrials),
    SHORT_TERM_WALK_FORWARD_FOLDS: String(walkForwardFolds),
    SHORT_TERM_IMPLIED_MIN_Z: String(impliedMinimumSignalZ),
    SHORT_TERM_IMPLIED_COST_MULTIPLIER: String(impliedCostMultiplier),
    SHORT_TERM_IMPLIED_MIN_TREND_Z: String(impliedMinimumTrendZ),
    SHORT_TERM_IMPLIED_REQUIRE_TREND: impliedRequireTrend ? "1" : "0",
    SHORT_TERM_LEAD_LAG_MIN_CHANGE: String(leadLagMinimumProbabilityChange),
    SHORT_TERM_LEAD_LAG_REQUIRE_TREND: leadLagRequireTrend ? "1" : "0",
  },
};
const report = {
  generatedAt: generatedAt.toISOString(),
  reproducibility,
  methodology: {
    status: "screening_only",
    warning: "Aggregated price history has no executable order book and cannot authorize testnet or real trading.",
    period: { startAt: startAt.toISOString(), endAt: endAt.toISOString(), lookbackHours },
    split: "chronological 60% calibration / 40% holdout",
    walkForward: `anchored expanding window / ${walkForwardFolds} non-overlapping validation folds`,
    marketDuration: marketDuration.slug,
    hyperliquidCandleInterval: marketDuration.candleInterval,
    entry: `first actionable one-minute observation in [${marketDuration.decisionStartMs / 60_000}m, ${marketDuration.decisionEndMs / 60_000}m)`,
    exit: `final ${marketDuration.candleInterval} Hyperliquid candle close`,
    executionMode,
    roundTripCost,
    fundingPer24h,
    positionPct,
    maximumConcurrentPositions,
    fixedRule: "Polymarket probability at least 58% in either direction, confirmed by same-side Hyperliquid trend",
    controlRule: "same Polymarket probability threshold without the Hyperliquid trend filter",
    impliedRule: {
      minimumSignalZ: impliedMinimumSignalZ,
      minimumExpectedReturnPct: roundTripCost * impliedCostMultiplier,
      minimumTrendZ: impliedMinimumTrendZ,
      requireTrend: impliedRequireTrend,
      strategyTrials,
      randomBenchmarkTrials,
    },
    leadLagRule: {
      minimumOneMinuteProbabilityChange: leadLagMinimumProbabilityChange,
      requireTrend: leadLagRequireTrend,
      strategyTrials,
      randomBenchmarkTrials,
    },
    crossSectionalRule: {
      construction: "50% long highest implied residual / 50% short lowest implied residual",
      minimumExpectedPairReturnPct: roundTripCost,
      strategyTrials,
      randomBenchmarkTrials,
    },
  },
  coverage: {
    discoveredMarkets: markets.length,
    completeMarkets: observations.length,
    skipped: Object.fromEntries(skipCounts),
  },
  diagnostics: {
    samples: impliedDiagnostics.length,
    absoluteExpectedReturnPct: distribution(impliedDiagnostics.map((row) => Math.abs(row.expectedReturnPct))),
    absoluteSignalZ: distribution(impliedDiagnostics.map((row) => Math.abs(row.signalZ))),
    absoluteTrendZ: distribution(impliedDiagnostics.map((row) => Math.abs(row.trendZ))),
    absoluteOneMinuteProbabilityChange: distribution(impliedDiagnostics.map((row) => Math.abs(row.probabilityChange))),
    crossSectionalExpectedPairReturnPct: distribution(crossSections.map((row) => row.expectedReturnPct)),
  },
  calibration: { ...calibrationSummary, crossSectional: calibrationCrossSectional },
  holdout: { ...holdoutSummary, crossSectional: holdoutCrossSectional },
  walkForward,
  screening: {
    baseline: screeningVerdict(holdoutSummary.baseline, walkForward.stability.baseline),
    implied: screeningVerdict(holdoutSummary.implied, walkForward.stability.implied),
    leadLag: screeningVerdict(holdoutSummary.leadLag, walkForward.stability.leadLag),
    crossSectional: screeningVerdict(holdoutCrossSectional, walkForward.stability.crossSectional),
  },
};
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.SHORT_TERM_HISTORY_OUTPUT) {
  await writeAtomic(resolve(process.env.SHORT_TERM_HISTORY_OUTPUT), serializedReport);
}
await persistResearchArtifacts(report, serializedReport, serializedObservations);
if (process.env.SHORT_TERM_HISTORY_QUIET !== "1") console.log(serializedReport.trimEnd());

function buildCrossSectionalTrades(rows: typeof observations) {
  const groups = new Map<string, typeof observations>();
  for (const row of rows) groups.set(row.startAt, [...(groups.get(row.startAt) ?? []), row]);
  return Array.from(groups, ([startAt, group]) => {
    if (group.length < 3) return null;
    const impliedRank = [...group].sort((left, right) => (
      right.crossSection.expectedReturnPct - left.crossSection.expectedReturnPct
    ));
    const long = impliedRank[0];
    const short = impliedRank.at(-1)!;
    const expectedReturnPct = 0.5 * (
      long.crossSection.expectedReturnPct - short.crossSection.expectedReturnPct
    );
    const modelReturn = pairReturn(long, short);
    const probabilityRank = [...group].sort((left, right) => (
      right.crossSection.probability - left.crossSection.probability
    ));
    const trendRank = [...group].sort((left, right) => (
      right.crossSection.trendZ - left.crossSection.trendZ
    ));
    return {
      startAt,
      selected: expectedReturnPct >= roundTripCost && modelReturn !== null,
      expectedReturnPct,
      returnPct: modelReturn ?? 0,
      longAsset: long.asset,
      shortAsset: short.asset,
      benchmarks: {
        polymarketProbabilityRank: pairReturn(probabilityRank[0], probabilityRank.at(-1)!) ?? 0,
        hyperliquidMomentumRank: pairReturn(trendRank[0], trendRank.at(-1)!) ?? 0,
        randomPairReturns: Array.from({ length: randomBenchmarkTrials }, (_, trial) => {
          const random = createSeededRandom(stableHash(startAt) + trial + 1);
          const longIndex = Math.floor(random() * group.length);
          let shortIndex = Math.floor(random() * (group.length - 1));
          if (shortIndex >= longIndex) shortIndex += 1;
          return pairReturn(group[longIndex], group[shortIndex]) ?? 0;
        }),
      },
    };
  }).filter((row): row is NonNullable<typeof row> => Boolean(row));
}

function pairReturn(long: (typeof observations)[number], short: (typeof observations)[number]) {
  const longReturn = long.crossSection.longReturnPct;
  const shortReturn = short.crossSection.shortReturnPct;
  return longReturn !== null && shortReturn !== null ? 0.5 * (longReturn + shortReturn) : null;
}

function summarizeCrossSectional(rows: ReturnType<typeof buildCrossSectionalTrades>) {
  const selected = rows.filter((row) => row.selected);
  const returns = selected.map((row) => row.returnPct);
  const portfolioReturns = returns.map((value) => value * positionPct);
  const randomBenchmark = medianTrial(Array.from({ length: randomBenchmarkTrials }, (_, trial) => (
    selected.map((row) => row.benchmarks.randomPairReturns[trial])
  )));
  const benchmarkCandidates = [
    { label: "Polymarket probability rank", returns: selected.map((row) => row.benchmarks.polymarketProbabilityRank) },
    { label: "Hyperliquid momentum rank", returns: selected.map((row) => row.benchmarks.hyperliquidMomentumRank) },
    { label: `Random pair median (${randomBenchmarkTrials} trials)`, returns: randomBenchmark },
  ].map((candidate) => ({ ...candidate, returnPct: sum(candidate.returns) * positionPct }));
  const best = [...benchmarkCandidates].sort((left, right) => right.returnPct - left.returnPct)[0];
  const excess = selected.map((row, index) => (row.returnPct - best.returns[index]) * positionPct);
  return {
    intervals: rows.length,
    trades: selected.length,
    profitableTrades: returns.filter((value) => value > 0).length,
    afterCostWinRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    binaryOutcomeAccuracy: null,
    netReturnPct: sum(portfolioReturns),
    averageReturnPct: average(returns),
    meanConfidenceInterval95: blockBootstrapMeanConfidenceInterval(portfolioReturns),
    deflatedSharpeProbability: deflatedSharpeProbability(excess, strategyTrials),
    maxDrawdownPct: maximumDrawdown(portfolioReturns),
    benchmarkLabel: best.label,
    benchmarkReturnPct: best.returnPct,
    excessReturnPct: sum(excess),
    excessConfidenceInterval95: blockBootstrapMeanConfidenceInterval(excess),
  };
}

function buildWalkForwardValidation(
  times: string[],
  rows: typeof observations,
  crossSectionRows: ReturnType<typeof buildCrossSectionalTrades>,
) {
  const initialWindow = Math.floor(times.length / (walkForwardFolds + 1));
  const folds = Array.from({ length: walkForwardFolds }, (_, index) => {
    const validationStartIndex = initialWindow * (index + 1);
    const validationEndIndex = index === walkForwardFolds - 1
      ? times.length
      : initialWindow * (index + 2);
    const validationTimes = new Set(times.slice(validationStartIndex, validationEndIndex));
    const validationRows = rows.filter((row) => validationTimes.has(row.startAt));
    const validationCrossSections = crossSectionRows.filter((row) => validationTimes.has(row.startAt));
    const summary = summarizePeriod(validationRows);
    return {
      fold: index + 1,
      calibration: {
        startAt: times[0] ?? null,
        endAt: times[validationStartIndex - 1] ?? null,
        intervals: validationStartIndex,
      },
      validation: {
        startAt: times[validationStartIndex] ?? null,
        endAt: times[validationEndIndex - 1] ?? null,
        intervals: validationTimes.size,
        ...summary,
        crossSectional: summarizeCrossSectional(validationCrossSections),
      },
    };
  });
  return {
    folds,
    minimumProfitableFolds,
    stability: {
      baseline: summarizeFoldStability(folds.map((fold) => fold.validation.baseline)),
      implied: summarizeFoldStability(folds.map((fold) => fold.validation.implied)),
      leadLag: summarizeFoldStability(folds.map((fold) => fold.validation.leadLag)),
      crossSectional: summarizeFoldStability(folds.map((fold) => fold.validation.crossSectional)),
    },
  };
}

function summarizeFoldStability(folds: Array<{ trades: number; netReturnPct: number }>) {
  return {
    folds: folds.length,
    tradedFolds: folds.filter((fold) => fold.trades > 0).length,
    profitableFolds: folds.filter((fold) => fold.trades > 0 && fold.netReturnPct > 0).length,
    requiredProfitableFolds: minimumProfitableFolds,
  };
}

function summarizePeriod(rows: typeof observations) {
  return {
    markets: rows.length,
    baseline: summarizeBaseline(rows),
    control: summarizeModel(rows, "control"),
    implied: summarizeModel(rows, "implied"),
    leadLag: summarizeModel(rows, "leadLag"),
  };
}

function summarizeModel(rows: typeof observations, key: "control" | "implied" | "leadLag") {
  const selected = rows.filter((row) => row[key].selected);
  const returns = selected.map((row) => row[key].returnPct);
  const portfolioReturns = groupWindowReturns(selected, (row) => row[key].returnPct * positionPct);
  const correct = selected.filter((row) => (
    (row[key].side === "LONG" && row.officialResult === 1)
    || (row[key].side === "SHORT" && row.officialResult === 0)
  ));
  const benchmark = key === "control" ? null : summarizeBenchmarks(selected, key);
  return {
    trades: selected.length,
    profitableTrades: returns.filter((value) => value > 0).length,
    afterCostWinRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    binaryOutcomeAccuracy: selected.length ? correct.length / selected.length : null,
    netReturnPct: sum(portfolioReturns),
    averageReturnPct: average(returns),
    meanConfidenceInterval95: blockBootstrapMeanConfidenceInterval(portfolioReturns),
    deflatedSharpeProbability: deflatedSharpeProbability(portfolioReturns, strategyTrials),
    maxDrawdownPct: maximumDrawdown(portfolioReturns),
    benchmarkLabel: benchmark?.label ?? null,
    benchmarkReturnPct: benchmark?.returnPct ?? null,
    excessReturnPct: benchmark?.excessReturnPct ?? null,
    excessConfidenceInterval95: benchmark?.confidenceInterval95 ?? null,
  };
}

function summarizeBaseline(rows: typeof observations) {
  const selected = rows.filter((row) => row.baseline.selected);
  const comparable = rows.filter((row) => row.baseline.selected || row.control.selected);
  const returns = selected.map((row) => row.baseline.returnPct);
  const strategyContributions = comparable.map((row) => row.baseline.selected ? row.baseline.returnPct * positionPct : 0);
  const controlContributions = comparable.map((row) => row.control.selected ? row.control.returnPct * positionPct : 0);
  const longContributions = comparable.map((row) => row.control.selected ? row.control.alwaysLongReturnPct * positionPct : 0);
  const shortContributions = comparable.map((row) => row.control.selected ? row.control.alwaysShortReturnPct * positionPct : 0);
  const randomMedian = medianTrial(Array.from({ length: randomBenchmarkTrials }, (_, trial) => {
    const random = createSeededRandom(trial + 1);
    return comparable.map((_, index) => random() < 0.5 ? longContributions[index] : shortContributions[index]);
  }));
  const candidates = [
    { label: "Polymarket direction", returns: controlContributions },
    { label: "Always long", returns: longContributions },
    { label: "Always short", returns: shortContributions },
    { label: `Random median (${randomBenchmarkTrials} trials)`, returns: randomMedian },
  ].map((candidate) => ({ ...candidate, returnPct: sum(candidate.returns) }));
  const best = [...candidates].sort((left, right) => right.returnPct - left.returnPct)[0];
  const excessContributions = comparable.map((_, index) => strategyContributions[index] - best.returns[index]);
  const strategyWindowReturns = groupWindowReturns(comparable, (_, index) => strategyContributions[index]);
  const excessWindowReturns = groupWindowReturns(comparable, (_, index) => excessContributions[index]);
  const correct = selected.filter((row) => (
    (row.baseline.side === "LONG" && row.officialResult === 1)
    || (row.baseline.side === "SHORT" && row.officialResult === 0)
  ));
  return {
    trades: selected.length,
    profitableTrades: returns.filter((value) => value > 0).length,
    afterCostWinRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    binaryOutcomeAccuracy: selected.length ? correct.length / selected.length : null,
    netReturnPct: sum(strategyContributions),
    averageReturnPct: average(returns),
    meanConfidenceInterval95: blockBootstrapMeanConfidenceInterval(strategyWindowReturns),
    deflatedSharpeProbability: deflatedSharpeProbability(excessWindowReturns, strategyTrials),
    maxDrawdownPct: maximumDrawdown(strategyWindowReturns),
    benchmarkLabel: best.label,
    benchmarkReturnPct: best.returnPct,
    excessReturnPct: sum(excessContributions),
    excessConfidenceInterval95: blockBootstrapMeanConfidenceInterval(excessWindowReturns),
  };
}

function screeningVerdict(model: {
  trades: number;
  netReturnPct: number;
  meanConfidenceInterval95: [number, number] | null;
  excessConfidenceInterval95: [number, number] | null;
  deflatedSharpeProbability: number | null;
  maxDrawdownPct: number;
}, stability: ReturnType<typeof summarizeFoldStability>) {
  const gates = [
    { id: "trades", label: "50 holdout trades", passed: model.trades >= 50 },
    { id: "net", label: "positive after costs", passed: model.netReturnPct > 0 },
    { id: "confidence", label: "95% mean-return lower bound above zero", passed: (model.meanConfidenceInterval95?.[0] ?? 0) > 0 },
    { id: "benchmark", label: "95% benchmark-excess lower bound above zero", passed: (model.excessConfidenceInterval95?.[0] ?? 0) > 0 },
    { id: "selection", label: "deflated Sharpe probability at least 95%", passed: (model.deflatedSharpeProbability ?? 0) >= 0.95 },
    { id: "drawdown", label: "maximum drawdown at or below 5%", passed: model.trades >= 50 && model.maxDrawdownPct <= 0.05 },
    { id: "walk-forward", label: `${stability.requiredProfitableFolds}/${stability.folds} sequential validation periods positive`, passed: stability.profitableFolds >= stability.requiredProfitableFolds },
  ];
  return {
    status: model.trades < 50 ? "insufficient" : gates.every((gate) => gate.passed) ? "promising" : "rejected",
    passedGates: gates.filter((gate) => gate.passed).length,
    totalGates: gates.length,
    gates,
  };
}

function summarizeBenchmarks(rows: typeof observations, key: "implied" | "leadLag") {
  const comparable = rows.flatMap((row) => row[key].benchmarks ? [{
    model: row[key].returnPct,
    ...row[key].benchmarks,
  }] : []);
  const randomBenchmark = medianTrial(Array.from({ length: randomBenchmarkTrials }, (_, trial) => {
    const random = createSeededRandom(trial + 1);
    return comparable.map((row) => random() < 0.5 ? row.alwaysLong : row.alwaysShort);
  }));
  const candidates = [
    { label: "Polymarket direction", returns: comparable.map((row) => row.polymarketDirection) },
    { label: "Always long", returns: comparable.map((row) => row.alwaysLong) },
    { label: "Always short", returns: comparable.map((row) => row.alwaysShort) },
    { label: `Random median (${randomBenchmarkTrials} trials)`, returns: randomBenchmark },
  ].map((candidate) => ({ ...candidate, returnPct: sum(candidate.returns) * positionPct }));
  const best = [...candidates].sort((left, right) => right.returnPct - left.returnPct)[0];
  const excess = comparable.map((row, index) => (row.model - best.returns[index]) * positionPct);
  return {
    label: best.label,
    returnPct: best.returnPct,
    excessReturnPct: sum(excess),
    confidenceInterval95: blockBootstrapMeanConfidenceInterval(excess),
  };
}

async function fetchDirectionMarkets(windowStart: Date, windowEnd: Date) {
  const found: DirectionMarket[] = [];
  const firstStart = Math.ceil(windowStart.getTime() / marketDuration.milliseconds) * marketDuration.milliseconds;
  const slugs: string[] = [];
  for (let timestamp = firstStart; timestamp + marketDuration.milliseconds <= windowEnd.getTime(); timestamp += marketDuration.milliseconds) {
    for (const asset of supportedAssets) slugs.push(`${asset.toLowerCase()}-updown-${marketDuration.slug}-${timestamp / 1_000}`);
  }
  for (let index = 0; index < slugs.length; index += 100) {
    const batch = slugs.slice(index, index + 100);
    const url = new URL(`${GAMMA_API}/markets`);
    url.searchParams.set("closed", "true");
    url.searchParams.set("limit", String(batch.length));
    for (const slug of batch) url.searchParams.append("slug", slug);
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Polymarket markets ${response.status}`);
    const page = z.array(marketSchema).parse(await response.json());
    for (const market of page) {
      const normalized = normalizeDirectionMarket(market);
      if (normalized) found.push(normalized);
    }
    await sleep(50);
  }
  return Array.from(new Map(found.map((market) => [market.id, market])).values())
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime());
}

function normalizeDirectionMarket(market: z.infer<typeof marketSchema>): DirectionMarket | null {
  const slug = market.slug ?? "";
  const match = new RegExp(`^(btc|eth|sol|xrp)-updown-${marketDuration.slug}-`).exec(slug);
  if (!match || !market.eventStartTime || !market.endDate) return null;
  const asset = match[1].toUpperCase() as Asset;
  const startAt = new Date(market.eventStartTime);
  const endAt = new Date(market.endDate);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) return null;
  if (Math.abs(endAt.getTime() - startAt.getTime() - marketDuration.milliseconds) > 5_000) return null;
  const tokens = stringArray(market.clobTokenIds);
  const outcomes = numberArray(market.outcomePrices);
  if (!tokens[0] || outcomes.length < 2) return null;
  const officialResult = outcomes[0] >= 0.99 ? 1 : outcomes[1] >= 0.99 ? 0 : null;
  if (officialResult === null) return null;
  return { id: String(market.id), asset, tokenId: tokens[0], startAt, endAt, officialResult };
}

function applyConcurrentPositionLimit(rows: typeof observations, key: "baseline" | "control") {
  const groups = new Map<string, typeof observations>();
  for (const row of rows) groups.set(row.startAt, [...(groups.get(row.startAt) ?? []), row]);
  for (const group of groups.values()) {
    const ranked = group
      .filter((row) => row[key].selected)
      .sort((left, right) => right[key].signalStrength - left[key].signalStrength);
    for (const row of ranked.slice(maximumConcurrentPositions)) row[key].selected = false;
  }
}

async function fetchPolymarketHistory(markets: DirectionMarket[], _windowStart: Date, _windowEnd: Date) {
  const history = new Map<string, HistoryPoint[]>();
  for (let index = 0; index < markets.length; index += 20) {
    const batch = markets.slice(index, index + 20);
    const tokenIds = batch.map((market) => market.tokenId);
    const batchStart = Math.min(...batch.map((market) => market.startAt.getTime())) - 60_000;
    const batchEnd = Math.max(...batch.map((market) => market.endAt.getTime())) + 60_000;
    const response = await fetch(`${CLOB_API}/batch-prices-history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markets: tokenIds,
        start_ts: Math.floor(batchStart / 1_000),
        end_ts: Math.ceil(batchEnd / 1_000),
        fidelity: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Polymarket history ${response.status}`);
    const parsed = historyResponseSchema.parse(await response.json());
    for (const tokenId of tokenIds) history.set(tokenId, parsed.history[tokenId] ?? []);
    await sleep(75);
  }
  return history;
}

async function fetchHyperliquidCandles(windowStart: Date, windowEnd: Date) {
  const entries = await Promise.all(supportedAssets.map(async (asset) => {
    const response = await fetch(HYPERLIQUID_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin: asset, interval: marketDuration.candleInterval, startTime: windowStart.getTime(), endTime: windowEnd.getTime() },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Hyperliquid ${asset} candles ${response.status}`);
    return [asset, z.array(candleSchema).parse(await response.json())] as const;
  }));
  return new Map(entries);
}

function estimateVolatility24h(candles: Candle[]) {
  if (candles.length < 10) return 0.02;
  const returns = candles.slice(1).flatMap((candle, index) => {
    const previous = number(candles[index].c);
    const current = number(candle.c);
    return previous && current ? [Math.log(current / previous)] : [];
  });
  if (!returns.length) return 0.02;
  return clamp(annualizeRealizedVolatility(returns, marketDuration.candleMs) ?? 0.02, 0.005, 0.25);
}

function calculateCandleReturn(side: "LONG" | "SHORT", entry: Candle, exit: Candle, candles: Candle[]) {
  const execution = entryExecution(side, entry, candles);
  const rawExit = number(exit.c) ?? 0;
  if (!execution || rawExit <= 0) return null;
  const multiplier = sideMultiplier(side);
  const entryPrice = execution.price;
  const exitPrice = rawExit * (1 - multiplier * slippagePerSide);
  const quantity = 1 / entryPrice;
  const gross = multiplier * quantity * (exitPrice - entryPrice);
  const entryFee = executionMode === "maker-entry" ? makerFeePerSide : takerFeePerSide;
  const fees = entryFee + quantity * exitPrice * takerFeePerSide;
  const holdingDays = Math.max(0, exit.T - execution.openedAt) / 86_400_000;
  return gross - fees - fundingPer24h * holdingDays;
}

function hasEntryExecution(side: "LONG" | "SHORT", entry: Candle, candles: Candle[]) {
  return entryExecution(side, entry, candles) !== null;
}

function entryExecution(side: "LONG" | "SHORT", entry: Candle, candles: Candle[]) {
  const rawEntry = number(entry.o);
  if (!rawEntry) return null;
  const multiplier = sideMultiplier(side);
  if (executionMode === "taker") {
    return { price: rawEntry * (1 + multiplier * slippagePerSide), openedAt: entry.t };
  }
  const next = candleAt(candles, entry.t + marketDuration.candleMs);
  if (!next) return null;
  const limitPrice = rawEntry * (1 - multiplier * makerLimitOffset);
  const reached = side === "LONG"
    ? (number(next.l) ?? Number.POSITIVE_INFINITY) <= limitPrice
    : (number(next.h) ?? Number.NEGATIVE_INFINITY) >= limitPrice;
  return reached ? { price: limitPrice, openedAt: next.t } : null;
}

function candleAt(candles: Candle[], timestamp: number) {
  return candles.find((candle) => candle.t === timestamp) ?? null;
}

function skipped(reason: string): [] {
  skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
  return [];
}

function stringArray(value: unknown) {
  return parsedArray(value).filter((item): item is string => typeof item === "string");
}

function numberArray(value: unknown) {
  return parsedArray(value).flatMap((item) => {
    const parsed = Number(item);
    return Number.isFinite(parsed) ? [parsed] : [];
  });
}

function parsedArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function number(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sideMultiplier(side: "LONG" | "SHORT") {
  return side === "LONG" ? 1 : -1;
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

function groupWindowReturns<T extends { startAt: string }>(
  rows: T[],
  valueFor: (row: T, index: number) => number,
) {
  const grouped = new Map<string, number>();
  rows.forEach((row, index) => grouped.set(row.startAt, (grouped.get(row.startAt) ?? 0) + valueFor(row, index)));
  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : null;
}

function distribution(values: number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((left, right) => left - right);
  return {
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    maximum: sorted.at(-1) ?? null,
  };
}

function quantile(sorted: number[], probability: number) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function medianTrial(trials: number[][]) {
  if (!trials.length) return [];
  return [...trials]
    .sort((left, right) => sum(left) - sum(right))[Math.floor((trials.length - 1) / 2)];
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

async function persistResearchArtifacts(
  value: typeof report,
  serialized: string,
  observationsCsv: string,
) {
  const historyPath = process.env.SHORT_TERM_HISTORY_INDEX_OUTPUT
    ? resolve(process.env.SHORT_TERM_HISTORY_INDEX_OUTPUT)
    : null;
  const historyItem = researchHistoryItem(value);
  let history = historyPath
    ? await readJson<{ items?: ReturnType<typeof researchHistoryItem>[] }>(historyPath).catch(() => null)
    : null;
  const items = [historyItem, ...(history?.items ?? [])]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.generatedAt === item.generatedAt) === index)
    .slice(0, 24);
  if (historyPath) await writeAtomic(historyPath, `${JSON.stringify({ items }, null, 2)}\n`);

  const artifactRoot = process.env.SHORT_TERM_ARTIFACT_ROOT
    ? resolve(process.env.SHORT_TERM_ARTIFACT_ROOT.replace(/^~(?=\/)/, homedir()))
    : null;
  if (!artifactRoot) return;
  const runDirectory = resolve(artifactRoot, value.reproducibility.runId);
  await mkdir(runDirectory, { recursive: true });
  await writeAtomic(resolve(runDirectory, "report.json"), serialized);
  await writeAtomic(resolve(runDirectory, "metrics.csv"), researchMetricsCsv(value));
  await writeAtomic(resolve(runDirectory, "observations.csv"), observationsCsv);
  await writeAtomic(resolve(artifactRoot, "latest.json"), serialized);
  await writeAtomic(resolve(artifactRoot, "latest-observations.csv"), observationsCsv);
  await writeAtomic(resolve(artifactRoot, "history.json"), `${JSON.stringify({ items }, null, 2)}\n`);
}

function researchHistoryItem(value: typeof report) {
  const baseline = value.holdout.baseline;
  const screening = value.screening.baseline;
  const stability = value.walkForward.stability.baseline;
  return {
    runId: value.reproducibility.runId,
    generatedAt: value.generatedAt,
    codeRevision: value.reproducibility.codeRevision,
    scriptSha256: value.reproducibility.scriptSha256,
    specificationSha256: value.reproducibility.specificationSha256,
    datasetSha256: value.reproducibility.datasetSha256,
    observationsCsvSha256: value.reproducibility.observationsCsvSha256,
    marketDuration: value.methodology.marketDuration,
    lookbackHours: value.methodology.period.lookbackHours,
    executionMode: value.methodology.executionMode,
    completeMarkets: value.coverage.completeMarkets,
    status: screening.status,
    trades: baseline.trades,
    netReturnPct: baseline.netReturnPct,
    averageReturnPct: baseline.averageReturnPct,
    confidenceLowerPct: baseline.meanConfidenceInterval95?.[0] ?? null,
    excessReturnPct: baseline.excessReturnPct,
    maxDrawdownPct: baseline.maxDrawdownPct,
    profitableFolds: stability.profitableFolds,
    totalFolds: stability.folds,
    passedGates: screening.passedGates,
    totalGates: screening.totalGates,
  };
}

function researchMetricsCsv(value: typeof report) {
  const definitions = [
    ["baseline", value.holdout.baseline, value.screening.baseline, value.walkForward.stability.baseline],
    ["implied", value.holdout.implied, value.screening.implied, value.walkForward.stability.implied],
    ["leadLag", value.holdout.leadLag, value.screening.leadLag, value.walkForward.stability.leadLag],
    ["crossSectional", value.holdout.crossSectional, value.screening.crossSectional, value.walkForward.stability.crossSectional],
  ] as const;
  const header = "run_id,code_revision,dataset_sha256,observations_csv_sha256,specification_sha256,script_sha256,candidate,status,trades,net_return_pct,average_return_pct,confidence_lower_pct,excess_return_pct,max_drawdown_pct,profitable_folds,total_folds,passed_gates,total_gates";
  const rows = definitions.map(([id, metrics, screening, stability]) => [
    value.reproducibility.runId,
    value.reproducibility.codeRevision ?? "",
    value.reproducibility.datasetSha256,
    value.reproducibility.observationsCsvSha256,
    value.reproducibility.specificationSha256,
    value.reproducibility.scriptSha256,
    id,
    screening.status,
    metrics.trades,
    metrics.netReturnPct,
    metrics.averageReturnPct ?? "",
    metrics.meanConfidenceInterval95?.[0] ?? "",
    metrics.excessReturnPct ?? "",
    metrics.maxDrawdownPct,
    stability.profitableFolds,
    stability.folds,
    screening.passedGates,
    screening.totalGates,
  ].join(","));
  return `${header}\n${rows.join("\n")}\n`;
}

function researchDatasetRows(rows: typeof observations) {
  return rows.map((row) => ({
    marketId: row.marketId,
    asset: row.asset,
    startAt: row.startAt,
    officialResult: row.officialResult,
    polymarketProbability: row.crossSection.probability,
    impliedExpectedReturnPct: row.crossSection.expectedReturnPct,
    trendZ: row.crossSection.trendZ,
    baselineSelected: row.baseline.selected,
    baselineSide: row.baseline.side,
    baselineReturnPct: row.baseline.returnPct,
    controlSelected: row.control.selected,
    controlSide: row.control.side,
    controlReturnPct: row.control.returnPct,
    alwaysLongReturnPct: row.control.alwaysLongReturnPct,
    alwaysShortReturnPct: row.control.alwaysShortReturnPct,
    impliedSelected: row.implied.selected,
    impliedSide: row.implied.side,
    impliedReturnPct: row.implied.returnPct,
    leadLagSelected: row.leadLag.selected,
    leadLagSide: row.leadLag.side,
    leadLagReturnPct: row.leadLag.returnPct,
  }));
}

function researchObservationsCsv(rows: ReturnType<typeof researchDatasetRows>) {
  const keys = [
    "marketId",
    "asset",
    "startAt",
    "officialResult",
    "polymarketProbability",
    "impliedExpectedReturnPct",
    "trendZ",
    "baselineSelected",
    "baselineSide",
    "baselineReturnPct",
    "controlSelected",
    "controlSide",
    "controlReturnPct",
    "alwaysLongReturnPct",
    "alwaysShortReturnPct",
    "impliedSelected",
    "impliedSide",
    "impliedReturnPct",
    "leadLagSelected",
    "leadLagSide",
    "leadLagReturnPct",
  ] as const;
  const header = keys.map(toSnakeCase).join(",");
  const lines = rows.map((row) => keys.map((key) => csvCell(row[key])).join(","));
  return `${header}\n${lines.join("\n")}\n`;
}

function toSnakeCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function csvCell(value: string | number | boolean) {
  const serialized = String(value);
  return /[",\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
}

function sha256Json(value: unknown) {
  return sha256Text(JSON.stringify(value));
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readJson<T>(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
