import type { BacktestRun, HyperliquidSnapshot, PipelineHeartbeat } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

import type { BacktestMetrics } from "@/src/lib/backtest/types";
import {
  evaluateForwardExperiment,
  forwardObservationHorizons,
  forwardControlExperimentKey,
  forwardStrategyExperimentKey,
} from "@/src/lib/combined-trading/forward-evaluation";
import type { CombinedShadowConfig } from "@/src/lib/combined-trading/service";
import {
  evaluateHyperliquidTestnetVerificationReadiness,
  getHyperliquidExecutionReadiness,
} from "@/src/lib/combined-trading/hyperliquid-execution";
import {
  shortTermDirectionControlKey,
  shortTermDirectionSpecification,
  shortTermDirectionStrategyKey,
} from "@/src/lib/combined-trading/short-term-direction";
import type { ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";
import { loadProspectiveSynchronizedData } from "@/src/lib/model-evaluation/prospective-synchronized";
import { prisma } from "@/src/lib/server/prisma";
import { readBackupStatus } from "@/src/lib/monitoring/backup-status";
import { readColumnarArchiveStatus } from "@/src/lib/monitoring/columnar-archive-status";
import {
  evaluateSynchronizedPriceQuality,
  synchronizedDataReadinessStatus,
  synchronizedQualityRequirements,
} from "@/src/lib/monitoring/synchronized-quality";
import { realtimeAssetSynchronizationVersion, realtimeSynchronizationVersion } from "@/src/lib/realtime-market-data/collector";
import { evaluateExactExecutionAudit } from "@/src/lib/realtime-market-data/execution-audit";
import { loadReferenceSettlementAudit } from "@/src/lib/realtime-market-data/settlement-audit";

const monitoredAssets = ["BTC", "ETH", "SOL", "XRP", "HYPE"] as const;
const freshnessMs = 12 * 60 * 1_000;
const researchMetricSchema = z.object({
  trades: z.number(),
  netReturnPct: z.number(),
  averageReturnPct: z.number().nullable(),
  meanConfidenceInterval95: z.tuple([z.number(), z.number()]).nullable(),
  excessReturnPct: z.number().nullable(),
  maxDrawdownPct: z.number(),
});
const researchFoldStabilitySchema = z.object({
  folds: z.number(),
  tradedFolds: z.number(),
  profitableFolds: z.number(),
  requiredProfitableFolds: z.number(),
});
const researchScreeningSchema = z.object({
  status: z.enum(["insufficient", "promising", "rejected"]),
  passedGates: z.number(),
  totalGates: z.number(),
});
const researchHistoryItemSchema = z.object({
  generatedAt: z.string(),
  marketDuration: z.string(),
  lookbackHours: z.number(),
  executionMode: z.string(),
  completeMarkets: z.number(),
  status: z.enum(["insufficient", "promising", "rejected"]),
  trades: z.number(),
  netReturnPct: z.number(),
  averageReturnPct: z.number().nullable(),
  confidenceLowerPct: z.number().nullable(),
  excessReturnPct: z.number().nullable(),
  maxDrawdownPct: z.number(),
  profitableFolds: z.number(),
  totalFolds: z.number(),
  passedGates: z.number(),
  totalGates: z.number(),
});
const researchDiagnosisSliceSchema = z.object({
  key: z.string(),
  label: z.string(),
  trades: z.number(),
  profitableTrades: z.number(),
  afterCostWinRate: z.number().nullable(),
  averageReturnPct: z.number().nullable(),
  netReturnPct: z.number(),
});
const shortTermResearchSchema = z.object({
  generatedAt: z.string(),
  methodology: z.object({
    marketDuration: z.string(),
    executionMode: z.string(),
    period: z.object({ lookbackHours: z.number() }),
  }),
  coverage: z.object({ completeMarkets: z.number() }),
  holdout: z.object({
    baseline: researchMetricSchema,
    implied: researchMetricSchema,
    leadLag: researchMetricSchema,
    crossSectional: researchMetricSchema,
  }),
  walkForward: z.object({
    folds: z.array(z.object({ fold: z.number() })),
    minimumProfitableFolds: z.number(),
    stability: z.object({
      baseline: researchFoldStabilitySchema,
      implied: researchFoldStabilitySchema,
      leadLag: researchFoldStabilitySchema,
      crossSectional: researchFoldStabilitySchema,
    }),
  }),
  screening: z.object({
    baseline: researchScreeningSchema,
    implied: researchScreeningSchema,
    leadLag: researchScreeningSchema,
    crossSectional: researchScreeningSchema,
  }),
  diagnosis: z.object({
    baseline: z.object({
      verdict: z.enum(["no_remaining_move_edge", "cost_barrier", "positive_after_costs"]),
      trades: z.number(),
      binaryOutcomeAccuracy: z.number().nullable(),
      afterCostWinRate: z.number().nullable(),
      estimatedBeforeCostWinRate: z.number().nullable(),
      averageNetReturnPct: z.number().nullable(),
      estimatedBeforeCostAverageReturnPct: z.number().nullable(),
      assumedRoundTripCostPct: z.number(),
      slices: z.object({
        byAsset: z.array(researchDiagnosisSliceSchema),
        bySide: z.array(researchDiagnosisSliceSchema),
        byProbability: z.array(researchDiagnosisSliceSchema),
        byTrendStrength: z.array(researchDiagnosisSliceSchema),
        byJstSession: z.array(researchDiagnosisSliceSchema),
      }),
    }),
    sensitivity: z.object({
      purpose: z.literal("diagnostic_only"),
      selectionPolicy: z.literal("fixed_grid_not_used_for_promotion"),
      testedVariants: z.number(),
      calibrationPositiveVariants: z.number(),
      holdoutPositiveVariants: z.number(),
    }).passthrough(),
  }).optional(),
});
const realtimeReplayMetricSchema = z.object({
  independentWindows: z.number(),
  longTrades: z.number(),
  shortTrades: z.number(),
  longIndependentWindows: z.number(),
  shortIndependentWindows: z.number(),
  trades: z.number(),
  correctTrades: z.number(),
  directionAccuracy: z.number().nullable(),
  equalWeightWinRate: z.number().nullable(),
  equalWeightAverageReturnPct: z.number().nullable(),
  equalWeightNetReturnPct: z.number(),
  equalWeightConfidenceInterval95: z.tuple([z.number(), z.number()]).nullable(),
  deflatedSharpeProbability: z.number().nullable(),
  hyperliquidAverageReturnPct: z.number().nullable(),
  hyperliquidNetReturnPct: z.number(),
  polymarketAverageReturnPct: z.number().nullable(),
  polymarketNetReturnPct: z.number(),
  maximumDrawdownPct: z.number(),
  marketBrierScore: z.number().nullable(),
  modelBrierScore: z.number().nullable(),
  brierImprovement: z.number().nullable(),
  brierSkillScore: z.number().nullable(),
  brierImprovementConfidenceInterval95: z.tuple([z.number(), z.number()]).nullable(),
  marketLogLoss: z.number().nullable(),
  modelLogLoss: z.number().nullable(),
  logLossImprovement: z.number().nullable(),
  logLossImprovementConfidenceInterval95: z.tuple([z.number(), z.number()]).nullable(),
  probabilityEdgePassed: z.boolean(),
  bestBenchmarkId: z.enum(["cash", "polymarket_only", "hyperliquid_only", "always_long", "always_short", "random_median"]).nullable(),
  bestBenchmarkNetReturnPct: z.number().nullable(),
  excessReturnPct: z.number().nullable(),
  excessAverageReturnPct: z.number().nullable(),
  excessConfidenceInterval95: z.tuple([z.number(), z.number()]).nullable(),
  excessDeflatedSharpeProbability: z.number().nullable(),
  benchmarks: z.object({
    cashNetReturnPct: z.number(),
    polymarketOnlyNetReturnPct: z.number(),
    hyperliquidOnlyNetReturnPct: z.number(),
    alwaysLongNetReturnPct: z.number(),
    alwaysShortNetReturnPct: z.number(),
    randomMedianNetReturnPct: z.number(),
  }),
});
const realtimeReplayInputSourceSchema = z.object({
  archiveRows: z.number(),
  sqliteRows: z.number(),
  mergedRows: z.number(),
  duplicatesRemoved: z.number(),
  firstCapturedAt: z.string().nullable(),
  latestCapturedAt: z.string().nullable(),
});
const realtimeReplayInputProvenanceSchema = z.object({
  mode: z.enum(["sqlite", "parquet", "hybrid"]),
  archivePartitions: z.number(),
  lookbackDays: z.number(),
  sinceAt: z.string().nullable(),
  beforeAt: z.string(),
  marketTicks: realtimeReplayInputSourceSchema,
  assetTicks: realtimeReplayInputSourceSchema,
});
const realtimeReplaySchema = z.object({
  generatedAt: z.string(),
  specification: z.object({
    minimumHoldoutWindows: z.number(),
    minimumHoldoutWindowsPerSide: z.number(),
    strategyTrials: z.number(),
  }).passthrough(),
  coverage: z.object({
    completeMarkets: z.number(),
    replayableMarkets: z.number(),
    independentWindows: z.number(),
    selectedTrades: z.number(),
  }).passthrough(),
  selection: z.object({
    status: z.enum(["insufficient", "promising", "rejected"]),
    promotionAllowed: z.literal(false),
    reason: z.string(),
    selectedExploratoryCandidateId: z.string().nullable(),
    strategyTrials: z.number(),
    probabilityEdgePassed: z.boolean(),
    holdoutCoverage: z.object({
      passed: z.boolean(),
      total: z.object({ observed: z.number(), required: z.number(), passed: z.boolean() }),
      long: z.object({ observed: z.number(), required: z.number(), passed: z.boolean() }),
      short: z.object({ observed: z.number(), required: z.number(), passed: z.boolean() }),
    }),
  }),
  variants: z.array(z.object({
    id: z.string(),
    strategy: z.enum(["market_direction", "trend_confirmed", "fair_value", "logit_pool"]),
    entryOffsetSeconds: z.number(),
    calibration: realtimeReplayMetricSchema,
    holdout: realtimeReplayMetricSchema,
    walkForward: z.object({
      profitableFolds: z.number(),
      benchmarkBeatingFolds: z.number(),
      totalFolds: z.number(),
    }).passthrough(),
  })),
  walkForwardSelection: z.object({
    methodology: z.literal("expanding-calibration-next-block"),
    folds: z.array(z.object({
      fold: z.number(),
      calibrationWindows: z.number(),
      validationWindows: z.number(),
      selectedCandidateId: z.string().nullable(),
      validation: realtimeReplayMetricSchema,
    })),
    profitableFolds: z.number(),
    benchmarkBeatingFolds: z.number(),
    totalFolds: z.number(),
  }).optional(),
  reproducibility: z.object({
    runId: z.string(),
    codeRevision: z.string().nullable(),
    specificationSha256: z.string(),
    datasetSha256: z.string(),
  }).passthrough(),
  inputProvenance: realtimeReplayInputProvenanceSchema.optional(),
});
const realtimeReplayHistoryItemSchema = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  status: z.enum(["insufficient", "promising", "rejected"]),
  selectedCandidateId: z.string().nullable(),
  completeMarkets: z.number(),
  replayableMarkets: z.number(),
  independentWindows: z.number(),
  holdoutWindows: z.number(),
  holdoutTrades: z.number(),
  holdoutLongWindows: z.number().optional(),
  holdoutShortWindows: z.number().optional(),
  holdoutEqualWeightNetReturnPct: z.number(),
  holdoutHyperliquidNetReturnPct: z.number(),
  holdoutPolymarketNetReturnPct: z.number(),
  holdoutBestBenchmarkId: z.enum(["cash", "polymarket_only", "hyperliquid_only", "always_long", "always_short", "random_median"]).nullable().optional(),
  holdoutBestBenchmarkNetReturnPct: z.number().nullable().optional(),
  holdoutExcessReturnPct: z.number().nullable().optional(),
  holdoutExcessConfidenceLowerPct: z.number().nullable().optional(),
  holdoutMarketBrierScore: z.number().nullable().optional(),
  holdoutModelBrierScore: z.number().nullable().optional(),
  holdoutBrierImprovement: z.number().nullable().optional(),
  holdoutBrierSkillScore: z.number().nullable().optional(),
  holdoutBrierImprovementConfidenceLower: z.number().nullable().optional(),
  holdoutMarketLogLoss: z.number().nullable().optional(),
  holdoutModelLogLoss: z.number().nullable().optional(),
  holdoutLogLossImprovement: z.number().nullable().optional(),
  holdoutProbabilityEdgePassed: z.boolean().optional(),
  profitableFolds: z.number(),
  benchmarkBeatingFolds: z.number().optional(),
  totalFolds: z.number(),
  inputMode: z.enum(["sqlite", "parquet", "hybrid"]).optional(),
  archivePartitions: z.number().optional(),
  archiveRows: z.number().optional(),
  sqliteRows: z.number().optional(),
}).passthrough();

export type MonitoringSnapshot = Awaited<ReturnType<typeof getMonitoringSnapshot>>;

export async function getMonitoringSnapshot() {
  const now = new Date();
  const shortTermResearch = loadShortTermResearchSummary();
  const realtimeShortTermResearch = loadRealtimeShortTermResearchSummary();
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const [
    polymarketAggregate,
    polymarketLast24Hours,
    synchronizedAggregate,
    synchronizedLast24Hours,
    synchronizedCompleteAggregate,
    synchronizedCompleteLast24Hours,
    marketCount,
    backtestPointCount,
    backtestRunCount,
    backtestRuns,
    aiRows,
    paperRuns,
    paperEquityAggregate,
    paperEquityLast24Hours,
    orderCount,
    fillCount,
    hyperAggregate,
    hyperLast24Hours,
    realtimeAggregate,
    executionAuditRealtimeAggregate,
    realtimeAssetAggregate,
    realtimeAssetLast24Hours,
    realtimeLast24Hours,
    realtimeRecent,
    realtimeArbitrageViolations,
    heartbeats,
    latestHyperliquid,
    latestEvaluation,
    combinedRuns,
    combinedDecisionCount,
    combinedSnapshotAggregate,
    combinedSnapshotsLast24Hours,
    latestTestnetAccount,
    latestTestnetVerification,
  ] = await Promise.all([
    prisma.marketSnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.marketSnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
    prisma.marketSnapshot.aggregate({
      where: {
        bestBid: { not: null },
        bestAsk: { not: null },
        spread: { not: null },
        synchronizationVersion: "fetch-time-v3-orderbook",
        hyperliquidMidPrice: { not: null },
        hyperliquidBestBid: { not: null },
        hyperliquidBestAsk: { not: null },
        hyperliquidSpread: { not: null },
        referencePrice: { not: null },
        priceBasisPct: { not: null },
        captureSkewMs: { lte: 60_000 },
      },
      _count: { _all: true },
      _max: { capturedAt: true, captureSkewMs: true },
    }),
    prisma.marketSnapshot.count({
      where: {
        capturedAt: { gte: last24Hours },
        bestBid: { not: null },
        bestAsk: { not: null },
        spread: { not: null },
        synchronizationVersion: "fetch-time-v3-orderbook",
        hyperliquidMidPrice: { not: null },
        hyperliquidBestBid: { not: null },
        hyperliquidBestAsk: { not: null },
        hyperliquidSpread: { not: null },
        referencePrice: { not: null },
        priceBasisPct: { not: null },
        captureSkewMs: { lte: 60_000 },
      },
    }),
    prisma.marketSnapshot.aggregate({
      where: {
        bestBid: { not: null },
        bestAsk: { not: null },
        spread: { not: null },
        synchronizationVersion: "fetch-time-v3-orderbook",
        hyperliquidMidPrice: { not: null },
        hyperliquidBestBid: { not: null },
        hyperliquidBestAsk: { not: null },
        hyperliquidSpread: { not: null },
        referencePrice: { not: null },
        priceBasisPct: { not: null },
        captureSkewMs: { not: null },
      },
      _count: { _all: true },
      _min: { capturedAt: true },
      _max: { capturedAt: true },
    }),
    prisma.marketSnapshot.count({
      where: {
        capturedAt: { gte: last24Hours },
        bestBid: { not: null },
        bestAsk: { not: null },
        spread: { not: null },
        synchronizationVersion: "fetch-time-v3-orderbook",
        hyperliquidMidPrice: { not: null },
        hyperliquidBestBid: { not: null },
        hyperliquidBestAsk: { not: null },
        hyperliquidSpread: { not: null },
        referencePrice: { not: null },
        priceBasisPct: { not: null },
        captureSkewMs: { not: null },
      },
    }),
    prisma.predictionMarket.count(),
    prisma.backtestPoint.count(),
    prisma.backtestRun.count({ where: { status: "completed" } }),
    prisma.backtestRun.findMany({ where: { status: "completed" }, orderBy: { startedAt: "desc" }, take: 12 }),
    prisma.aiEvaluationSnapshot.findMany({ select: { marketProbability: true, aiProbability: true, resolvedOutcome: true, brierScore: true, recordedAt: true } }),
    prisma.paperTradingRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    prisma.paperEquitySnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.paperEquitySnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
    prisma.paperOrder.count(),
    prisma.paperFill.count(),
    prisma.hyperliquidSnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.hyperliquidSnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
    prisma.realtimeMarketTick.aggregate({
      _count: { _all: true },
      _min: { capturedAt: true },
      _max: { capturedAt: true, captureSkewMs: true },
    }),
    prisma.realtimeMarketTick.aggregate({
      where: { synchronizationVersion: realtimeSynchronizationVersion },
      _count: { _all: true },
      _min: { capturedAt: true },
      _max: { capturedAt: true, captureSkewMs: true },
    }),
    prisma.realtimeAssetTick.aggregate({
      where: { synchronizationVersion: realtimeAssetSynchronizationVersion },
      _count: { _all: true },
      _min: { capturedAt: true },
      _max: { capturedAt: true, captureSkewMs: true },
    }),
    prisma.realtimeAssetTick.count({
      where: { capturedAt: { gte: last24Hours }, synchronizationVersion: realtimeAssetSynchronizationVersion },
    }),
    prisma.realtimeMarketTick.count({
      where: { capturedAt: { gte: last24Hours }, synchronizationVersion: realtimeSynchronizationVersion },
    }),
    prisma.realtimeMarketTick.findMany({
      where: {
        capturedAt: { gte: new Date(now.getTime() - 60_000) },
        synchronizationVersion: realtimeSynchronizationVersion,
      },
      select: { marketId: true, asset: true, capturedAt: true, captureSkewMs: true },
      orderBy: { capturedAt: "desc" },
      take: 2_000,
    }),
    prisma.realtimeMarketTick.count({
      where: {
        capturedAt: { gte: last24Hours },
        arbitrageViolation: true,
        synchronizationVersion: realtimeSynchronizationVersion,
      },
    }),
    prisma.pipelineHeartbeat.findMany({ orderBy: { id: "asc" } }),
    Promise.all(monitoredAssets.map((asset) => prisma.hyperliquidSnapshot.findFirst({ where: { asset }, orderBy: { capturedAt: "desc" } }))),
    prisma.modelEvaluationRun.findFirst({ where: { status: "completed" }, orderBy: { completedAt: "desc" } }),
    prisma.combinedShadowRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
    prisma.combinedShadowDecision.count(),
    prisma.combinedShadowEquitySnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.combinedShadowEquitySnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
    prisma.combinedExecutionAccountSnapshot.findFirst({ where: { environment: "TESTNET" }, orderBy: { capturedAt: "desc" } }),
    prisma.hyperliquidTestnetVerificationRun.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);

  const usableBacktests = backtestRuns
    .map((run) => ({ run, metrics: parseBacktestMetrics(run) }))
    .filter((item): item is { run: BacktestRun; metrics: BacktestMetrics } => Boolean(item.metrics?.observations));
  const latestBacktest = usableBacktests.find((item) => item.run.asset === "BTC" && item.metrics.observations >= 100 && item.metrics.markets >= 10)
    ?? usableBacktests.find((item) => item.metrics.observations >= 100 && item.metrics.markets >= 10)
    ?? usableBacktests[0]
    ?? null;
  const synchronizedQuality = await loadSynchronizedPriceQuality({
    records: synchronizedAggregate._count._all,
    completeRecords: synchronizedCompleteAggregate._count._all,
    windowRecords: synchronizedLast24Hours,
    windowCompleteRecords: synchronizedCompleteLast24Hours,
    startedAt: synchronizedCompleteAggregate._min.capturedAt,
    latestAt: synchronizedCompleteAggregate._max.capturedAt,
  });
  const prospectiveSynchronized = (await loadProspectiveSynchronizedData({ now })).report;
  const evaluation = parseJson<ModelEvaluationMetrics>(latestEvaluation?.metricsJson ?? null);
  const combinedRunConfigs = new Map(combinedRuns.map((run) => [run.id, parseJson<Partial<CombinedShadowConfig>>(run.configJson)]));
  const forwardStrategyRuns = forwardObservationHorizons.flatMap((horizonHours) => {
    const run = combinedRuns.find((candidate) => combinedRunConfigs.get(candidate.id)?.experimentKey === forwardStrategyExperimentKey(horizonHours));
    return run ? [{ horizonHours, run }] : [];
  });
  const forwardControlRuns = forwardObservationHorizons.flatMap((horizonHours) => {
    const run = combinedRuns.find((candidate) => combinedRunConfigs.get(candidate.id)?.experimentKey === forwardControlExperimentKey(horizonHours));
    return run ? [{ horizonHours, run }] : [];
  });
  const shortTermStrategyRun = combinedRuns.find((run) => combinedRunConfigs.get(run.id)?.experimentKey === shortTermDirectionStrategyKey) ?? null;
  const shortTermControlRun = combinedRuns.find((run) => combinedRunConfigs.get(run.id)?.experimentKey === shortTermDirectionControlKey) ?? null;
  const legacyCombinedRun = combinedRuns.find((run) => combinedRunConfigs.get(run.id)?.forwardOnly === true) ?? combinedRuns[0] ?? null;
  const activeCombinedRuns = forwardStrategyRuns.length ? forwardStrategyRuns.map((item) => item.run) : legacyCombinedRun ? [legacyCombinedRun] : [];
  const activeControlRuns = forwardStrategyRuns.length
    ? forwardControlRuns.map((item) => item.run)
    : combinedRuns.filter((run) => combinedRunConfigs.get(run.id)?.experimentKey === "polymarket-only-forward-control-v1").slice(0, 1);
  const combinedRun = activeCombinedRuns[0] ?? null;
  const activeCombinedRunIds = activeCombinedRuns.map((run) => run.id);
  const activeControlRunIds = activeControlRuns.map((run) => run.id);

  const resolvedAiRows = aiRows.filter((row) => row.resolvedOutcome !== null && row.brierScore !== null);
  const averageAiBrier = average(resolvedAiRows.map((row) => row.brierScore as number));
  const averageMarketBrier = average(resolvedAiRows.map((row) => (row.marketProbability - (row.resolvedOutcome as number)) ** 2));
  const aiImprovement = averageAiBrier !== null && averageMarketBrier !== null ? averageMarketBrier - averageAiBrier : null;

  const latestCompletedPaper = paperRuns.find((run) => run.status === "completed" && run.metricsJson) ?? null;
  const latestRunningPaper = paperRuns.find((run) => run.status === "running") ?? null;
  const [latestRunningEquity, runningOpenPositions, runningPaperFills] = latestRunningPaper
    ? await Promise.all([
        prisma.paperEquitySnapshot.findFirst({ where: { runId: latestRunningPaper.id }, orderBy: { capturedAt: "desc" } }),
        prisma.paperPosition.count({ where: { runId: latestRunningPaper.id, status: "OPEN" } }),
        prisma.paperFill.count({ where: { runId: latestRunningPaper.id } }),
      ])
    : [null, 0, 0];
  const [latestCombinedDecision, latestCombinedSnapshot, combinedOpenPositions, combinedClosedTrades, combinedWinningTrades, combinedDecisions, combinedPositions, controlPositions] = activeCombinedRunIds.length
    ? await Promise.all([
        prisma.combinedShadowDecision.findFirst({ where: { runId: { in: activeCombinedRunIds } }, orderBy: { observedAt: "desc" } }),
        prisma.combinedShadowEquitySnapshot.findFirst({ where: { runId: { in: activeCombinedRunIds } }, orderBy: { capturedAt: "desc" } }),
        prisma.combinedShadowPosition.findMany({ where: { runId: { in: activeCombinedRunIds }, status: "OPEN" }, orderBy: { openedAt: "asc" } }),
        prisma.combinedShadowPosition.count({ where: { runId: { in: activeCombinedRunIds }, status: "CLOSED" } }),
        prisma.combinedShadowPosition.count({ where: { runId: { in: activeCombinedRunIds }, status: "CLOSED", realizedPnl: { gt: 0 } } }),
        prisma.combinedShadowDecision.findMany({
          where: { runId: { in: activeCombinedRunIds } },
          select: {
            runId: true,
            action: true,
            horizonHours: true,
            horizonEligibleMarkets: true,
            groupedEvents: true,
            priceReadyEvents: true,
            reason: true,
            nextWindowAt: true,
            observedAt: true,
          },
          orderBy: { observedAt: "desc" },
        }),
        prisma.combinedShadowPosition.findMany({
          where: { runId: { in: activeCombinedRunIds } },
          orderBy: { openedAt: "asc" },
        }),
        activeControlRunIds.length
          ? prisma.combinedShadowPosition.findMany({ where: { runId: { in: activeControlRunIds } }, orderBy: { openedAt: "asc" } })
          : Promise.resolve([]),
      ])
    : [null, null, [], 0, 0, [], [], []];
  const [shortTermDecision, shortTermSnapshot, shortTermPositions, shortTermControlPositions] = shortTermStrategyRun
    ? await Promise.all([
        prisma.combinedShadowDecision.findFirst({ where: { runId: shortTermStrategyRun.id }, orderBy: { observedAt: "desc" } }),
        prisma.combinedShadowEquitySnapshot.findFirst({ where: { runId: shortTermStrategyRun.id }, orderBy: { capturedAt: "desc" } }),
        prisma.combinedShadowPosition.findMany({ where: { runId: shortTermStrategyRun.id }, orderBy: { openedAt: "asc" } }),
        shortTermControlRun
          ? prisma.combinedShadowPosition.findMany({ where: { runId: shortTermControlRun.id }, orderBy: { openedAt: "asc" } })
          : Promise.resolve([]),
      ])
    : [null, null, [], []];
  const exactAuditPositions = [...shortTermPositions, ...shortTermControlPositions]
    .filter((position) => (
      position.status === "CLOSED"
      && position.closedAt
      && executionAuditRealtimeAggregate._min.capturedAt
      && position.openedAt >= executionAuditRealtimeAggregate._min.capturedAt
    ));
  const exactAuditMarketIds = Array.from(new Set(exactAuditPositions.map((position) => position.marketId)));
  const exactAuditStrategyMarketIds = Array.from(new Set(shortTermPositions
    .filter((position) => (
      position.status === "CLOSED"
      && position.closedAt
      && executionAuditRealtimeAggregate._min.capturedAt
      && position.openedAt >= executionAuditRealtimeAggregate._min.capturedAt
    ))
    .map((position) => position.marketId)));
  const exactAuditAssets = Array.from(new Set(exactAuditPositions.map((position) => position.asset)));
  const exactAuditStartedAt = earliestDate(...exactAuditPositions.map((position) => position.openedAt));
  const exactAuditEndedAt = latestDate(...exactAuditPositions.map((position) => position.exitAt));
  const shortTermRealtimeTicks = exactAuditMarketIds.length
    ? await prisma.realtimeMarketTick.findMany({
        where: {
          marketId: { in: exactAuditMarketIds },
          synchronizationVersion: realtimeSynchronizationVersion,
        },
        select: {
          marketId: true,
          asset: true,
          marketStartAt: true,
          marketEndAt: true,
          polymarketBestAsk: true,
          polymarketUpdatedAt: true,
          negativeBestAsk: true,
          negativeUpdatedAt: true,
          hyperliquidBestBid: true,
          hyperliquidBestAsk: true,
          hyperliquidUpdatedAt: true,
          referencePrice: true,
          referenceUpdatedAt: true,
          capturedAt: true,
        },
        orderBy: { capturedAt: "asc" },
      })
    : [];
  const shortTermRealtimeAssetTicks = exactAuditAssets.length && exactAuditStartedAt && exactAuditEndedAt
    ? await prisma.realtimeAssetTick.findMany({
        where: {
          asset: { in: exactAuditAssets },
          synchronizationVersion: realtimeAssetSynchronizationVersion,
          capturedAt: {
            gte: exactAuditStartedAt,
            lte: new Date(exactAuditEndedAt.getTime() + 15_000),
          },
        },
        select: {
          asset: true,
          hyperliquidBestBid: true,
          hyperliquidBestAsk: true,
          hyperliquidUpdatedAt: true,
          capturedAt: true,
        },
        orderBy: { capturedAt: "asc" },
      })
    : [];
  const shortTermResolutions = exactAuditMarketIds.length
    ? await prisma.predictionMarket.findMany({
        where: { id: { in: exactAuditMarketIds } },
        select: { id: true, resolved: true, result: true },
      })
    : [];
  const settlementBasis = summarizeSettlementBasis(combinedPositions);
  const shortTermSettlementBasis = summarizeSettlementBasis(shortTermPositions);
  const combinedConfig = parseJson<Partial<CombinedShadowConfig>>(combinedRun?.configJson ?? null);
  const horizonEvaluations = forwardStrategyRuns.flatMap(({ horizonHours, run }) => {
    const controlRun = forwardControlRuns.find((item) => item.horizonHours === horizonHours)?.run ?? null;
    const config = combinedRunConfigs.get(run.id);
    if (!controlRun || !config) return [];
    const strategyPositions = combinedPositions.filter((position) => position.runId === run.id);
    const horizonControlPositions = controlPositions.filter((position) => position.runId === controlRun.id);
    const evaluation = evaluateForwardExperiment({
      strategyPositions,
      controlPositions: horizonControlPositions,
      strategyStartedAt: run.startedAt,
      controlStartedAt: controlRun.startedAt,
      initialEquity: run.initialEquity,
      takerFeePerSide: config.takerFeePerSide ?? 0.00045,
      slippagePerSide: config.slippagePerSide ?? 0.0002,
      fundingPer24h: config.fundingPer24h ?? 0.0003,
      maxDrawdownPct: run.maxDrawdownPct,
      settlementBasisStatus: summarizeSettlementBasis(strategyPositions).status,
      strategyTrials: forwardObservationHorizons.length,
    });
    const latestDecision = combinedDecisions.find((decision) => decision.runId === run.id) ?? null;
    return [{ horizonHours, run, evaluation, latestDecision }];
  });
  const leadingHorizon = [...horizonEvaluations].sort((left, right) => (
    Number(right.evaluation.status === "promising") - Number(left.evaluation.status === "promising")
    || right.evaluation.independentEvents - left.evaluation.independentEvents
    || (left.latestDecision?.nextWindowAt?.getTime() ?? Number.POSITIVE_INFINITY)
      - (right.latestDecision?.nextWindowAt?.getTime() ?? Number.POSITIVE_INFINITY)
    || left.horizonHours - right.horizonHours
  ))[0] ?? null;
  const displayCombinedDecision = leadingHorizon
    ? await prisma.combinedShadowDecision.findFirst({ where: { runId: leadingHorizon.run.id }, orderBy: { observedAt: "desc" } })
    : latestCombinedDecision;
  const legacyForwardEvaluation = combinedRun && combinedConfig?.forwardOnly === true && !horizonEvaluations.length
    ? evaluateForwardExperiment({
        strategyPositions: combinedPositions,
        controlPositions,
        strategyStartedAt: combinedRun.startedAt,
        controlStartedAt: activeControlRuns[0]?.startedAt ?? null,
        initialEquity: combinedRun.initialEquity,
        takerFeePerSide: combinedConfig.takerFeePerSide ?? 0.00045,
        slippagePerSide: combinedConfig.slippagePerSide ?? 0.0002,
        fundingPer24h: combinedConfig.fundingPer24h ?? 0.0003,
        maxDrawdownPct: combinedRun.maxDrawdownPct,
        settlementBasisStatus: settlementBasis.status,
      })
    : null;
  const forwardEvaluation = leadingHorizon ? {
    ...leadingHorizon.evaluation,
    activeHorizonHours: leadingHorizon.horizonHours,
    totalTrades: horizonEvaluations.reduce((total, item) => total + item.evaluation.trades, 0),
    totalIndependentEvents: horizonEvaluations.reduce((total, item) => total + item.evaluation.independentEvents, 0),
    totalMinimumTrades: horizonEvaluations.length * leadingHorizon.evaluation.minimumTrades,
    totalMinimumIndependentEvents: horizonEvaluations.length * leadingHorizon.evaluation.minimumIndependentEvents,
    horizons: horizonEvaluations.map(({ horizonHours, evaluation: item, latestDecision }) => ({
      horizonHours,
      status: item.status,
      trades: item.trades,
      independentEvents: item.independentEvents,
      minimumTrades: item.minimumTrades,
      minimumIndependentEvents: item.minimumIndependentEvents,
      progressPct: item.progressPct,
      netReturnPct: item.netReturnPct,
      excessReturnPct: item.excessReturnPct,
      maxDrawdownPct: item.maxDrawdownPct,
      passedGates: item.passedGates,
      totalGates: item.totalGates,
      horizonEligibleMarkets: latestDecision?.horizonEligibleMarkets ?? 0,
      priceReadyEvents: latestDecision?.priceReadyEvents ?? 0,
      latestAction: latestDecision?.action ?? null,
      latestReason: latestDecision?.reason ?? "最初の市場確認を待っています",
      nextWindowAt: latestDecision?.nextWindowAt?.toISOString() ?? null,
    })),
  } : legacyForwardEvaluation;
  const shortTermConfig = parseJson<Partial<CombinedShadowConfig>>(shortTermStrategyRun?.configJson ?? null);
  const shortTermEvaluation = shortTermStrategyRun && shortTermControlRun && shortTermConfig
    ? evaluateForwardExperiment({
        strategyPositions: shortTermPositions,
        controlPositions: shortTermControlPositions,
        strategyStartedAt: shortTermStrategyRun.startedAt,
        controlStartedAt: shortTermControlRun.startedAt,
        initialEquity: shortTermStrategyRun.initialEquity,
        takerFeePerSide: shortTermConfig.takerFeePerSide ?? 0.00045,
        slippagePerSide: shortTermConfig.slippagePerSide ?? 0.0002,
        fundingPer24h: shortTermConfig.fundingPer24h ?? 0.0003,
        maxDrawdownPct: shortTermStrategyRun.maxDrawdownPct,
        settlementBasisStatus: shortTermSettlementBasis.status,
        strategyTrials: shortTermDirectionSpecification.strategyTrials,
      })
    : null;
  const shortTermSettlementResolution = await loadReferenceSettlementAudit({
    marketIds: exactAuditStrategyMarketIds,
  });
  const shortTermExecutionAudit = shortTermStrategyRun && shortTermConfig
    ? evaluateExactExecutionAudit({
        positions: shortTermPositions,
        controlPositions: shortTermControlPositions,
        ticks: shortTermRealtimeTicks,
        assetTicks: shortTermRealtimeAssetTicks,
        resolutions: shortTermResolutions.map((resolution) => ({
          marketId: resolution.id,
          resolved: resolution.resolved,
          result: resolution.result,
        })),
        collectionStartedAt: executionAuditRealtimeAggregate._min.capturedAt,
        takerFeePerSide: shortTermConfig.takerFeePerSide ?? 0.00045,
        slippagePerSide: shortTermConfig.slippagePerSide ?? 0.0002,
        fundingPer24h: shortTermConfig.fundingPer24h ?? 0.0003,
        initialEquity: shortTermStrategyRun.initialEquity,
        settlementBasisStatus: shortTermSettlementBasis.status,
        settlementResolutionStatus: shortTermSettlementResolution.status,
        strategyTrials: shortTermDirectionSpecification.strategyTrials,
      })
    : null;
  const latestPaperMetrics = parseJson<Record<string, number | null>>(latestCompletedPaper?.metricsJson ?? null);
  const newestDataAt = latestDate(
    polymarketAggregate._max.capturedAt,
    hyperAggregate._max.capturedAt,
    realtimeAggregate._max.capturedAt,
    realtimeAssetAggregate._max.capturedAt,
    paperEquityAggregate._max.capturedAt,
    combinedSnapshotAggregate._max.capturedAt,
    ...heartbeats.map((heartbeat) => heartbeat.lastSuccessAt),
  );
  const oldestDataAt = earliestDate(
    polymarketAggregate._min.capturedAt,
    hyperAggregate._min.capturedAt,
    realtimeAggregate._min.capturedAt,
    realtimeAssetAggregate._min.capturedAt,
    paperEquityAggregate._min.capturedAt,
  );
  const ageMs = newestDataAt ? now.getTime() - newestDataAt.getTime() : Number.POSITIVE_INFINITY;
  const status = ageMs <= freshnessMs ? "live" : ageMs <= 60 * 60 * 1_000 ? "delayed" : "offline";
  const combinedEdgeConfirmed = shortTermExecutionAudit?.status === "healthy"
    && shortTermExecutionAudit.readinessStatus === "promising";
  const runningPaperReturnPct = latestRunningPaper && latestRunningEquity
    ? latestRunningEquity.equity / latestRunningPaper.initialCash - 1
    : null;
  const executionReadiness = getHyperliquidExecutionReadiness();
  const testnetVerificationReadiness = evaluateHyperliquidTestnetVerificationReadiness({
    executionReady: executionReadiness.ready,
    verification: latestTestnetVerification,
    account: latestTestnetAccount,
    now,
  });
  const testnetVerifiedReady = testnetVerificationReadiness.ready;
  const testnetReconciliation = heartbeats.find((heartbeat) => heartbeat.id === "testnet-reconcile");
  const alertHeartbeat = heartbeats.find((heartbeat) => heartbeat.id === "operational-alerts");
  const realtimeHeartbeat = heartbeats.find((heartbeat) => heartbeat.id === "realtime-market-data");
  const realtimeHeartbeatStatus = operationalStatus(realtimeHeartbeat, now, 30_000);
  const realtimeLatestAt = executionAuditRealtimeAggregate._max.capturedAt;
  const realtimeAssetLatestAt = realtimeAssetAggregate._max.capturedAt;
  const realtimePriceStatus = realtimeHeartbeatStatus === "error"
    ? "error" as const
    : realtimeHeartbeatStatus === "healthy"
      && realtimeLatestAt
      && realtimeAssetLatestAt
      && now.getTime() - realtimeLatestAt.getTime() <= 30_000
      && now.getTime() - realtimeAssetLatestAt.getTime() <= 30_000
      ? "healthy" as const
      : "waiting" as const;
  const realtimeMarketIds = new Set(realtimeRecent.map((row) => row.marketId));
  const realtimeAssets = Array.from(new Set(realtimeRecent.map((row) => row.asset))).sort();
  const tunnelStatus = readTunnelStatus();
  const backupStatus = readBackupStatus();
  const columnarArchiveStatus = readColumnarArchiveStatus(now);
  const combinedShadowRunning = activeCombinedRuns.some((run) => run.status === "running") || shortTermStrategyRun?.status === "running";
  const aggregateInitialEquity = sum(activeCombinedRuns.map((run) => run.initialEquity));
  const aggregateEquity = sum(activeCombinedRuns.map((run) => run.equity));
  const aggregateCash = sum(activeCombinedRuns.map((run) => run.cash));
  const aggregateRealizedPnl = sum(activeCombinedRuns.map((run) => run.realizedPnl));
  const aggregateWins = horizonEvaluations.length
    ? sum(horizonEvaluations.map((item) => item.evaluation.wins))
    : combinedWinningTrades;
  const aggregateTrades = horizonEvaluations.length
    ? sum(horizonEvaluations.map((item) => item.evaluation.trades))
    : combinedClosedTrades;
  const latestHorizonDecisions = forwardStrategyRuns.map(({ run }) => combinedDecisions.find((decision) => decision.runId === run.id)).filter(Boolean);

  const inferredPipelines = pipelineStatuses({
    now,
    heartbeats,
    polymarketAt: polymarketAggregate._max.capturedAt,
    hyperliquidAt: hyperAggregate._max.capturedAt,
    backtestAt: latestBacktest?.run.completedAt ?? null,
    evaluationAt: latestEvaluation?.completedAt ?? null,
    combinedAt: combinedSnapshotAggregate._max.capturedAt,
  });
  const testnetTransportPipeline = inferredPipelines.find((pipeline) => pipeline.id === "testnet-transport") ?? null;

  return {
    status,
    generatedAt: now.toISOString(),
    collection: {
      startedAt: oldestDataAt?.toISOString() ?? null,
      latestAt: newestDataAt?.toISOString() ?? null,
      totalRecords: polymarketAggregate._count._all + hyperAggregate._count._all + realtimeAggregate._count._all + realtimeAssetAggregate._count._all + backtestPointCount + paperEquityAggregate._count._all + aiRows.length + combinedDecisionCount + combinedSnapshotAggregate._count._all,
      last24Hours: polymarketLast24Hours + hyperLast24Hours + realtimeLast24Hours + realtimeAssetLast24Hours + paperEquityLast24Hours + combinedSnapshotsLast24Hours,
      realtimePrices: {
        status: realtimePriceStatus,
        records: executionAuditRealtimeAggregate._count._all,
        last24Hours: realtimeLast24Hours,
        latestAt: executionAuditRealtimeAggregate._max.capturedAt?.toISOString() ?? null,
        maximumSkewMs: executionAuditRealtimeAggregate._max.captureSkewMs ?? null,
        activeMarkets: realtimeMarketIds.size,
        assets: realtimeAssets,
        arbitrageViolations: realtimeArbitrageViolations,
        targetCadenceSeconds: 5,
        synchronizationVersion: realtimeSynchronizationVersion,
        executionRecords: realtimeAssetAggregate._count._all,
        executionLast24Hours: realtimeAssetLast24Hours,
        executionLatestAt: realtimeAssetLatestAt?.toISOString() ?? null,
        executionMaximumSkewMs: realtimeAssetAggregate._max.captureSkewMs ?? null,
        executionSynchronizationVersion: realtimeAssetSynchronizationVersion,
      },
      synchronizedPrices: {
        records: synchronizedAggregate._count._all,
        last24Hours: synchronizedLast24Hours,
        latestAt: synchronizedAggregate._max.capturedAt?.toISOString() ?? null,
        maximumSkewMs: synchronizedAggregate._max.captureSkewMs ?? null,
        targetCadenceMinutes: 1,
        quality: synchronizedQuality,
        prospective: prospectiveSynchronized,
      },
    },
    tradeReadiness: {
      objective: "Polymarketの予測をシグナルにしてHyperliquidで売買する",
      currentStage: combinedShadowRunning ? "shadow" : "backtest",
      realTradingEnabled: false,
      combinedPaperRunning: combinedShadowRunning,
      hyperliquidOrderConnection: testnetVerifiedReady
        ? executionReadiness.autoMirrorEnabled ? "testnet_armed" : "testnet_ready"
        : executionReadiness.installed ? "connector_ready" : "not_installed",
      gates: [
        {
          id: "data",
          label: "同期データ品質",
          status: synchronizedDataReadinessStatus({
            monitoringStatus: status,
            realtimePriceStatus,
            synchronizedQualityStatus: synchronizedQuality.status,
          }),
        },
        { id: "edge", label: "優位性確認", status: combinedEdgeConfirmed ? "ready" : "blocked" },
        { id: "shadow", label: "シャドー検証", status: combinedShadowRunning ? "running" : "not_started" },
        { id: "testnet", label: "テストネット", status: testnetVerifiedReady ? "ready" : executionReadiness.installed ? "attention" : "not_started" },
        { id: "live", label: "実取引", status: "locked" },
      ],
    },
    combinedShadow: {
      status: combinedShadowRunning ? "running" : combinedRun?.status ?? "not_started",
      startedAt: activeCombinedRuns.length ? new Date(Math.min(...activeCombinedRuns.map((run) => run.startedAt.getTime()))).toISOString() : null,
      updatedAt: latestCombinedSnapshot?.capturedAt.toISOString() ?? null,
      initialEquity: activeCombinedRuns.length ? aggregateInitialEquity : null,
      equity: activeCombinedRuns.length ? aggregateEquity : null,
      returnPct: forwardEvaluation?.netReturnPct
        ?? (aggregateInitialEquity > 0 ? aggregateRealizedPnl / aggregateInitialEquity : null),
      cash: activeCombinedRuns.length ? aggregateCash : null,
      realizedPnl: activeCombinedRuns.length ? aggregateRealizedPnl : null,
      openPositions: combinedOpenPositions.map((position) => ({
        asset: position.asset,
        side: position.side,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
        signalZ: position.signalZ,
        polymarketSide: position.polymarketSide,
        entryTrendZ6h: position.entryTrendZ6h,
        entryFunding24h: position.entryFunding24h,
        horizonHours: position.horizonHours,
        priceBasisPct: position.priceBasisPct,
        openedAt: position.openedAt.toISOString(),
        exitAt: position.exitAt.toISOString(),
      })),
      trades: aggregateTrades,
      wins: aggregateWins,
      winRate: aggregateTrades > 0 ? aggregateWins / aggregateTrades : null,
      maxDrawdownPct: activeCombinedRuns.length ? Math.max(...activeCombinedRuns.map((run) => run.maxDrawdownPct)) : null,
      riskStatus: activeCombinedRuns.find((run) => run.riskStatus !== "NORMAL")?.riskStatus ?? combinedRun?.riskStatus ?? "NOT_STARTED",
      emergencyStopped: activeCombinedRuns.some((run) => run.emergencyStopped),
      experimentKey: horizonEvaluations.length ? "forward-v2-6-12-24-48" : combinedConfig?.experimentKey ?? null,
      experimentLabel: horizonEvaluations.length ? "6・12・24・48時間の独立フォワード検証 v2" : combinedConfig?.experimentLabel ?? null,
      forwardOnly: combinedConfig?.forwardOnly === true,
      minimumSignalZ: combinedConfig?.minimumSignalZ ?? null,
      minimumFunding24h: combinedConfig?.minimumFunding24h ?? null,
      signalRule: combinedConfig?.signalRule ?? "polymarket-only",
      modelVersion: horizonEvaluations.length ? "Forward Experiment v2 2026-07-18 / no backfill" : combinedConfig?.modelVersion ?? null,
      forwardEvaluation,
      shortTermDirection: {
        experimentKey: shortTermConfig?.experimentKey ?? null,
        modelVersion: shortTermConfig?.modelVersion ?? null,
        status: shortTermExecutionAudit?.readinessStatus
          ?? shortTermEvaluation?.status
          ?? (shortTermStrategyRun?.status === "running" ? "collecting" : "not_started"),
        running: shortTermStrategyRun?.status === "running" && !shortTermStrategyRun.emergencyStopped,
        startedAt: shortTermStrategyRun?.startedAt.toISOString() ?? null,
        updatedAt: shortTermSnapshot?.capturedAt.toISOString() ?? null,
        trades: shortTermEvaluation?.trades ?? 0,
        controlTrades: shortTermEvaluation?.controlTrades ?? 0,
        minimumTrades: shortTermEvaluation?.minimumTrades ?? 50,
        progressPct: shortTermEvaluation?.progressPct ?? 0,
        netReturnPct: shortTermExecutionAudit?.portfolioNetReturnPct ?? shortTermEvaluation?.netReturnPct ?? null,
        excessReturnPct: shortTermExecutionAudit?.excessReturnPct ?? shortTermEvaluation?.excessReturnPct ?? null,
        confidenceLowerPct: shortTermExecutionAudit?.excessConfidenceInterval95?.[0]
          ?? shortTermEvaluation?.excessConfidenceInterval95?.[0]
          ?? null,
        maxDrawdownPct: shortTermExecutionAudit?.maxDrawdownPct
          ?? shortTermEvaluation?.maxDrawdownPct
          ?? shortTermStrategyRun?.maxDrawdownPct
          ?? null,
        passedGates: shortTermExecutionAudit?.passedReadinessGates ?? shortTermEvaluation?.passedGates ?? 0,
        totalGates: shortTermExecutionAudit?.totalReadinessGates ?? shortTermEvaluation?.totalGates ?? 10,
        openPositions: shortTermPositions.filter((position) => position.status === "OPEN").length,
        scannedMarkets: shortTermDecision?.scannedMarkets ?? 0,
        fifteenMinuteMarkets: shortTermDecision?.structuredMarkets ?? 0,
        decisionWindowMarkets: shortTermDecision?.horizonEligibleMarkets ?? 0,
        priceReadyMarkets: shortTermDecision?.priceReadyEvents ?? 0,
        thresholdSignals: shortTermPositions.length,
        opened: shortTermPositions.length,
        latestAction: shortTermDecision?.action ?? null,
        latestReason: shortTermDecision?.reason ?? "最初の15分市場を確認中",
        nextDecisionAt: shortTermDecision?.nextWindowAt?.toISOString() ?? null,
        observedAt: shortTermDecision?.observedAt.toISOString() ?? null,
        specificationHash: shortTermConfig?.specificationHash ?? null,
        executionAudit: shortTermExecutionAudit,
        settlementResolution: shortTermSettlementResolution,
        research: shortTermResearch,
        realtimeResearch: realtimeShortTermResearch,
        realTradingEnabled: false,
      },
      settlementBasis: {
        status: settlementBasis.status,
        samples: settlementBasis.samples,
        medianAbsolutePct: settlementBasis.medianAbsolutePct,
        maximumAbsolutePct: settlementBasis.maximumAbsolutePct,
        medianReferenceCaptureLagSeconds: settlementBasis.medianReferenceCaptureLagSeconds,
      },
      funnel: {
        scans: Math.ceil(combinedDecisions.length / Math.max(1, activeCombinedRuns.length)),
        scannedMarkets: latestCombinedDecision?.scannedMarkets ?? 0,
        structuredMarkets: latestCombinedDecision?.structuredMarkets ?? 0,
        horizonEligibleMarkets: latestHorizonDecisions.length
          ? sum(latestHorizonDecisions.map((decision) => decision?.horizonEligibleMarkets ?? 0))
          : latestCombinedDecision?.horizonEligibleMarkets ?? 0,
        groupedEvents: latestHorizonDecisions.length
          ? sum(latestHorizonDecisions.map((decision) => decision?.groupedEvents ?? 0))
          : latestCombinedDecision?.groupedEvents ?? 0,
        priceReadyEvents: latestHorizonDecisions.length
          ? sum(latestHorizonDecisions.map((decision) => decision?.priceReadyEvents ?? 0))
          : latestCombinedDecision?.priceReadyEvents ?? 0,
        thresholdSignals: combinedDecisions.filter((decision) => (
          decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT" || decision.action === "SKIP"
        )).length,
        opened: combinedDecisions.filter((decision) => decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT").length,
        closed: combinedClosedTrades,
      },
      latestDecision: displayCombinedDecision ? {
        action: displayCombinedDecision.action,
        reason: displayCombinedDecision.reason,
        asset: displayCombinedDecision.asset,
        signalZ: displayCombinedDecision.signalZ,
        spotPrice: displayCombinedDecision.spotPrice,
        targetPrice: displayCombinedDecision.targetPrice,
        polymarketSide: displayCombinedDecision.polymarketSide,
        strategySide: displayCombinedDecision.strategySide,
        trendZ6h: displayCombinedDecision.trendZ6h,
        hyperliquidFunding24h: displayCombinedDecision.hyperliquidFunding24h,
        horizonHours: displayCombinedDecision.horizonHours,
        marketBestBid: displayCombinedDecision.marketBestBid,
        marketBestAsk: displayCombinedDecision.marketBestAsk,
        marketSpread: displayCombinedDecision.marketSpread,
        polymarketReferencePrice: displayCombinedDecision.polymarketReferencePrice,
        referenceSource: displayCombinedDecision.referenceSource,
        priceBasisPct: displayCombinedDecision.priceBasisPct,
        ladderViolations: displayCombinedDecision.ladderViolations,
        nextWindowAt: displayCombinedDecision.nextWindowAt?.toISOString() ?? null,
        observedAt: displayCombinedDecision.observedAt.toISOString(),
      } : null,
      testnet: {
        ...executionReadiness,
        transport: testnetTransportPipeline,
        verifiedReady: testnetVerifiedReady,
        verification: latestTestnetVerification ? {
          id: latestTestnetVerification.id,
          status: latestTestnetVerification.status,
          asset: latestTestnetVerification.asset,
          requestedNotionalUsd: latestTestnetVerification.requestedNotionalUsd,
          sdkVersion: latestTestnetVerification.sdkVersion,
          connectivityPassed: latestTestnetVerification.connectivityPassed,
          openFillPassed: latestTestnetVerification.openFillPassed,
          closeFillPassed: latestTestnetVerification.closeFillPassed,
          restingOrderPassed: latestTestnetVerification.restingOrderPassed,
          cancelPassed: latestTestnetVerification.cancelPassed,
          deadManSwitchPassed: latestTestnetVerification.deadManSwitchPassed,
          partialFillObserved: latestTestnetVerification.partialFillObserved,
          reconnectPassed: latestTestnetVerification.reconnectPassed,
          reconciliationPassed: latestTestnetVerification.reconciliationPassed,
          emergencyCleanupPassed: latestTestnetVerification.emergencyCleanupPassed,
          orphanOrderCount: latestTestnetVerification.orphanOrderCount,
          positionMismatchCount: latestTestnetVerification.positionMismatchCount,
          startedAt: latestTestnetVerification.startedAt.toISOString(),
          completedAt: latestTestnetVerification.completedAt?.toISOString() ?? null,
          error: latestTestnetVerification.error,
          failedChecks: testnetVerificationReadiness.failedChecks,
        } : null,
        reconciliation: {
          status: testnetReconciliation?.status ?? "not_configured",
          lastSuccessAt: testnetReconciliation?.lastSuccessAt?.toISOString() ?? null,
          message: testnetReconciliation?.message ?? null,
          accountValue: latestTestnetAccount?.accountValue ?? null,
          accountLossPct: latestTestnetAccount?.accountLossPct ?? null,
          healthy: latestTestnetAccount?.healthy ?? false,
          orderMismatchCount: latestTestnetAccount?.orderMismatchCount ?? 0,
          positionMismatchCount: latestTestnetAccount?.positionMismatchCount ?? 0,
          capturedAt: latestTestnetAccount?.capturedAt.toISOString() ?? null,
        },
      },
    },
    polymarket: {
      snapshots: polymarketAggregate._count._all,
      markets: marketCount,
      latestAt: polymarketAggregate._max.capturedAt?.toISOString() ?? null,
      backtestRuns: backtestRunCount,
      backtestPoints: backtestPointCount,
    },
    model: {
      name: latestEvaluation?.modelVersion ?? "Polymarket x Hyperliquid Signal v15",
      selectedCandidate: evaluation?.selectedCandidate.id ?? null,
      selectedCandidateKind: evaluation?.selectedCandidate.kind ?? null,
      combinedStrategy: evaluation?.combinedTrading?.selectedStrategy.id ?? null,
      combinedMinimumSignalZ: evaluation?.combinedTrading?.selectedStrategy.minimumSignalZ ?? null,
      selectedFromValidation: evaluation?.combinedTrading?.selectedFromValidation ?? false,
      totalEligibleSignals: evaluation?.combinedTrading?.totalEligibleSignals ?? 0,
      validationEligibleSignals: evaluation?.combinedTrading?.validationEligibleSignals ?? 0,
      executionStartedAt: evaluation?.combinedTrading?.executionStartedAt ?? null,
      executionEndedAt: evaluation?.combinedTrading?.executionEndedAt ?? null,
      validationStartedAt: evaluation?.combinedTrading?.validationStartedAt ?? null,
      validationEndedAt: evaluation?.combinedTrading?.validationEndedAt ?? null,
      testStartedAt: evaluation?.combinedTrading?.testStartedAt ?? null,
      testEndedAt: evaluation?.combinedTrading?.testEndedAt ?? null,
      closestValidationCandidate: evaluation?.combinedTrading?.closestValidationCandidate ?? null,
      closestHoldoutAudit: evaluation?.combinedTrading?.closestHoldoutAudit ?? null,
      candidateDiagnostics: evaluation?.combinedTrading?.candidateDiagnostics ?? [],
      structuralFeatureCoverage: evaluation?.dataset.testExecutionFeatureCoverage ?? evaluation?.dataset.executionFeatureCoverage ?? evaluation?.dataset.structuralFeatureCoverage ?? null,
      fundingFeatureCoverage: evaluation?.dataset.testFundingFeatureCoverage ?? evaluation?.dataset.fundingFeatureCoverage ?? null,
      synchronizedExecutionCoverage: evaluation?.dataset.synchronizedExecutionCoverage ?? 0,
      testSynchronizedExecutionCoverage: evaluation?.dataset.testSynchronizedExecutionCoverage ?? 0,
      evaluationStatus: evaluation?.quality.status ?? "building",
      latestAsset: evaluation ? Object.keys(evaluation.dataset.assets).join("・") : null,
      latestBrierScore: evaluation?.probability.modelBrierScore ?? null,
      latestAccuracy: evaluation?.combinedTrading?.directionalAccuracy ?? null,
      latestReturnPct: evaluation?.combinedTrading?.netReturnPct ?? null,
      benchmarkReturnPct: evaluation?.combinedTrading?.benchmarkReturnPct ?? null,
      benchmarkReturns: evaluation?.combinedTrading?.benchmarks ?? null,
      horizonStudies: evaluation?.horizonStudies ?? [],
      excessReturnPct: evaluation?.combinedTrading?.excessReturnPct ?? null,
      eligibleSignals: evaluation?.combinedTrading?.eligibleSignals ?? 0,
      testedMarkets: evaluation?.dataset.testMarkets ?? 0,
      testedEvents: evaluation?.dataset.testEvents ?? 0,
      observations: evaluation?.dataset.totalMarkets ?? 0,
      brierImprovement: evaluation?.probability.relativeImprovement ?? null,
      previousBrierScore: evaluation?.probability.marketBrierScore ?? null,
      confidenceInterval95: evaluation?.combinedTrading?.returnConfidenceInterval95 ?? null,
      statisticallyPositive: evaluation?.combinedTrading?.statisticallyPositive ?? false,
      deflatedSharpeProbability: evaluation?.combinedTrading?.deflatedSharpeProbability ?? null,
      strategyTrials: evaluation?.combinedTrading?.strategyTrials ?? 0,
      walkForwardFolds: evaluation?.combinedTrading?.walkForwardFolds ?? 0,
      profitableValidationFolds: evaluation?.combinedTrading?.profitableValidationFolds ?? 0,
      completedAt: latestEvaluation?.completedAt?.toISOString() ?? null,
      datasetStartedAt: evaluation?.dataset.firstEndAt ?? null,
      datasetEndedAt: evaluation?.dataset.lastEndAt ?? null,
      trades: evaluation?.combinedTrading?.trades ?? 0,
      longTrades: evaluation?.combinedTrading?.longTrades ?? 0,
      shortTrades: evaluation?.combinedTrading?.shortTrades ?? 0,
      winRate: evaluation?.combinedTrading?.winRate ?? null,
      averageTradeReturn: evaluation?.combinedTrading?.averageNetTradeReturn ?? null,
      maxDrawdownPct: evaluation?.combinedTrading?.maxDrawdownPct ?? null,
      medianObservationLagMinutes: evaluation?.dataset.medianObservationLagMinutes ?? null,
      medianEntryLagMinutes: evaluation?.dataset.medianEntryLagMinutes ?? null,
      medianExitLeadMinutes: evaluation?.dataset.medianExitLeadMinutes ?? null,
      maximumExecutionTimingErrorMinutes: evaluation?.dataset.maximumExecutionTimingErrorMinutes ?? null,
      probabilityLadderEvents: evaluation?.dataset.probabilityLadderEvents ?? 0,
      probabilityLadderViolationEvents: evaluation?.dataset.probabilityLadderViolationEvents ?? 0,
      aiPredictions: aiRows.length,
      aiResolved: resolvedAiRows.length,
      aiBrierScore: averageAiBrier,
      marketBrierScore: averageMarketBrier,
      aiImprovement,
      paperRuns: paperRuns.length,
      runningPaperRuns: paperRuns.filter((run) => run.status === "running").length,
      paperSnapshots: paperEquityAggregate._count._all,
      paperOrders: orderCount,
      paperFills: fillCount,
      paperReturnPct: typeof latestPaperMetrics?.totalReturnPct === "number" ? latestPaperMetrics.totalReturnPct : null,
    },
    paperExperiment: {
      label: "Polymarket単体の仮想売買",
      strategy: latestRunningPaper?.strategy ?? null,
      status: latestRunningPaper?.status ?? "not_running",
      realMoney: false,
      initialCash: latestRunningPaper?.initialCash ?? null,
      equity: latestRunningEquity?.equity ?? null,
      returnPct: runningPaperReturnPct,
      unrealizedPnl: latestRunningEquity?.unrealizedPnl ?? null,
      openPositions: runningOpenPositions,
      fills: runningPaperFills,
      updatedAt: latestRunningEquity?.capturedAt.toISOString() ?? null,
    },
    backtestQuality: {
      status: evaluation?.quality.status ?? "building",
      checks: evaluation?.quality.gates.map((gate) => ({ label: gate.label, passed: gate.passed })) ?? [],
    },
    hyperliquid: {
      snapshots: hyperAggregate._count._all,
      latestAt: hyperAggregate._max.capturedAt?.toISOString() ?? null,
      assets: latestHyperliquid.filter((item): item is HyperliquidSnapshot => Boolean(item)).map((item) => ({
        asset: item.asset,
        price: item.midPrice,
        change24hPct: item.previousDayPrice > 0 ? item.midPrice / item.previousDayPrice - 1 : null,
        dayVolume: item.dayVolume,
        openInterestUsd: item.openInterest * item.markPrice,
        fundingRate: item.fundingRate,
        capturedAt: item.capturedAt.toISOString(),
      })),
    },
    operations: {
      alerts: {
        status: operationalStatus(alertHeartbeat, now, 5 * 60 * 1_000),
        message: alertHeartbeat?.message ?? "起動待ち",
        lastSuccessAt: alertHeartbeat?.lastSuccessAt?.toISOString() ?? null,
        webhookConfigured: Boolean(process.env.POLYMARKET_ALERT_WEBHOOK_URL?.trim()),
      },
      tunnel: tunnelStatus,
      backup: backupStatus,
      columnarArchive: columnarArchiveStatus,
    },
    pipelines: inferredPipelines,
  };
}

function operationalStatus(heartbeat: PipelineHeartbeat | undefined, now: Date, maximumAgeMs: number) {
  if (!heartbeat) return "waiting" as const;
  if (heartbeat.status === "error") return "error" as const;
  return heartbeat.lastSuccessAt && now.getTime() - heartbeat.lastSuccessAt.getTime() <= maximumAgeMs
    ? "healthy" as const
    : "waiting" as const;
}

function readTunnelStatus() {
  const fallback = {
    mode: "unknown",
    status: "waiting" as const,
    publicUrl: null,
    fixedUrl: false,
    fallback: false,
    publishedAt: null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    updatedAt: null,
  };
  try {
    const path = resolve(homedir(), ".polymarket-watch/tunnel-status.json");
    if (!existsSync(path)) return fallback;
    const value = JSON.parse(readFileSync(path, "utf8")) as Omit<Partial<typeof fallback>, "status"> & { status?: string };
    const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
    const updatedAtMs = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
    const fresh = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= 3 * 60 * 1_000;
    const recordedStatus = value.status === "healthy" || value.status === "waiting" || value.status === "starting"
      ? value.status
      : value.status === "restarting" ? "starting" as const : fallback.status;
    return {
      mode: typeof value.mode === "string" ? value.mode : fallback.mode,
      status: recordedStatus === "healthy" && !fresh ? "waiting" as const : recordedStatus,
      publicUrl: typeof value.publicUrl === "string" ? value.publicUrl : null,
      fixedUrl: value.fixedUrl === true,
      fallback: value.fallback === true,
      publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : null,
      lastCheckedAt: typeof value.lastCheckedAt === "string" ? value.lastCheckedAt : null,
      consecutiveFailures: typeof value.consecutiveFailures === "number" && Number.isFinite(value.consecutiveFailures)
        ? Math.max(0, Math.floor(value.consecutiveFailures))
        : 0,
      updatedAt,
    };
  } catch {
    return fallback;
  }
}

function pipelineStatuses(input: {
  now: Date;
  heartbeats: PipelineHeartbeat[];
  polymarketAt: Date | null;
  hyperliquidAt: Date | null;
  backtestAt: Date | null;
  evaluationAt: Date | null;
  combinedAt: Date | null;
}) {
  const heartbeatMap = new Map(input.heartbeats.map((item) => [item.id, item]));
  return [
    pipeline("polymarket", "価格同期収集", "1分ごと", input.polymarketAt, heartbeatMap.get("polymarket"), input.now),
    pipeline("hyperliquid", "相場データ収集", "1分ごと", input.hyperliquidAt, heartbeatMap.get("hyperliquid"), input.now),
    pipeline("realtime-market-data", "秒単位の板収集", "5秒ごと", null, heartbeatMap.get("realtime-market-data"), input.now, 30_000),
    pipeline("backtest", "モデル再検証", "6時間ごと", input.evaluationAt ?? input.backtestAt, heartbeatMap.get("backtest"), input.now, 30 * 60 * 60 * 1_000),
    pipeline("short-term-backtest", "15分モデル過去検証", "6時間ごと", null, heartbeatMap.get("short-term-backtest"), input.now, 30 * 60 * 60 * 1_000),
    pipeline("realtime-short-term-backtest", "5秒板リプレイ", "30分ごと", null, heartbeatMap.get("realtime-short-term-backtest"), input.now, 2 * 60 * 60 * 1_000),
    pipeline("columnar-archive", "検証データ保存", "6時間ごと", null, heartbeatMap.get("columnar-archive"), input.now, 18 * 60 * 60 * 1_000),
    pipeline("testnet-transport", "testnet API疎通", "10分ごと", null, heartbeatMap.get("testnet-transport"), input.now, 30 * 60 * 1_000),
    pipeline("forward-experiment", "固定フォワード検証", "5分ごと", input.combinedAt, heartbeatMap.get("forward-experiment"), input.now),
    pipeline("short-term-direction", "15分モデル検証", "1分ごと", null, heartbeatMap.get("short-term-direction"), input.now, 5 * 60 * 1_000),
    pipeline("forward-execution-audit-report", "前向き監査の保存", "5分ごと", null, heartbeatMap.get("forward-execution-audit-report"), input.now, 15 * 60 * 1_000),
  ];
}

function pipeline(id: string, label: string, cadence: string, inferredAt: Date | null, heartbeat: PipelineHeartbeat | undefined, now: Date, tolerance = freshnessMs) {
  const lastSuccessAt = heartbeat?.lastSuccessAt ?? inferredAt;
  const fresh = lastSuccessAt ? now.getTime() - lastSuccessAt.getTime() <= tolerance : false;
  return {
    id,
    label,
    cadence,
    status: heartbeat?.status === "error" ? "error" : fresh ? "healthy" : "waiting",
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    records: heartbeat?.records ?? 0,
  };
}

function parseBacktestMetrics(run: BacktestRun) {
  return parseJson<BacktestMetrics>(run.metricsJson);
}

function parseJson<T>(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function loadShortTermResearchSummary() {
  const root = process.env.POLYMARKET_PROJECT_ROOT ?? process.cwd();
  const path = resolve(root, "public/short-term-research.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = shortTermResearchSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const definitions = [
      { id: "baseline", label: "現行15分モデル", metrics: parsed.holdout.baseline, screening: parsed.screening.baseline, stability: parsed.walkForward.stability.baseline },
      { id: "implied", label: "暗黙終値", metrics: parsed.holdout.implied, screening: parsed.screening.implied, stability: parsed.walkForward.stability.implied },
      { id: "leadLag", label: "確率変化", metrics: parsed.holdout.leadLag, screening: parsed.screening.leadLag, stability: parsed.walkForward.stability.leadLag },
      { id: "crossSectional", label: "資産間比較", metrics: parsed.holdout.crossSectional, screening: parsed.screening.crossSectional, stability: parsed.walkForward.stability.crossSectional },
    ];
    return {
      generatedAt: parsed.generatedAt,
      marketDuration: parsed.methodology.marketDuration,
      executionMode: parsed.methodology.executionMode,
      lookbackHours: parsed.methodology.period.lookbackHours,
      completeMarkets: parsed.coverage.completeMarkets,
      walkForwardFolds: parsed.walkForward.folds.length,
      minimumProfitableFolds: parsed.walkForward.minimumProfitableFolds,
      acceptedCandidates: definitions.filter((item) => item.screening.status === "promising").length,
      totalCandidates: definitions.length,
      currentCandidateId: "baseline",
      diagnosis: parsed.diagnosis?.baseline ?? null,
      sensitivity: parsed.diagnosis?.sensitivity ?? null,
      history: loadShortTermResearchHistory(root),
      candidates: definitions.map((item) => ({
        id: item.id,
        label: item.label,
        status: item.screening.status,
        trades: item.metrics.trades,
        netReturnPct: item.metrics.netReturnPct,
        averageReturnPct: item.metrics.averageReturnPct,
        confidenceLowerPct: item.metrics.meanConfidenceInterval95?.[0] ?? null,
        excessReturnPct: item.metrics.excessReturnPct,
        maxDrawdownPct: item.metrics.maxDrawdownPct,
        profitableFolds: item.stability.profitableFolds,
        totalFolds: item.stability.folds,
        passedGates: item.screening.passedGates,
        totalGates: item.screening.totalGates,
      })),
    };
  } catch (error) {
    console.warn(`[monitoring] failed to parse short-term research artifact at ${path}`, error);
    return null;
  }
}

function loadShortTermResearchHistory(root: string) {
  const path = resolve(root, "public/short-term-research-history.json");
  if (!existsSync(path)) return [];
  try {
    return z.object({ items: z.array(researchHistoryItemSchema) })
      .parse(JSON.parse(readFileSync(path, "utf8"))).items;
  } catch {
    return [];
  }
}

function loadRealtimeShortTermResearchSummary() {
  const root = process.env.POLYMARKET_PROJECT_ROOT ?? process.cwd();
  const path = resolve(root, "public/realtime-short-term-research.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = realtimeReplaySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const selected = parsed.variants.find((variant) => variant.id === parsed.selection.selectedExploratoryCandidateId) ?? null;
    const walkForward = parsed.walkForwardSelection ?? selected?.walkForward ?? null;
    return {
      generatedAt: parsed.generatedAt,
      status: parsed.selection.status,
      promotionAllowed: parsed.selection.promotionAllowed,
      completeMarkets: parsed.coverage.completeMarkets,
      replayableMarkets: parsed.coverage.replayableMarkets,
      independentWindows: parsed.coverage.independentWindows,
      minimumHoldoutWindows: parsed.specification.minimumHoldoutWindows,
      minimumHoldoutWindowsPerSide: parsed.specification.minimumHoldoutWindowsPerSide,
      selectedTrades: parsed.coverage.selectedTrades,
      strategyTrials: parsed.selection.strategyTrials,
      holdoutCoverage: parsed.selection.holdoutCoverage,
      calibrationPositiveVariants: parsed.variants.filter((variant) => variant.calibration.equalWeightNetReturnPct > 0).length,
      holdoutPositiveVariants: parsed.variants.filter((variant) => variant.holdout.equalWeightNetReturnPct > 0).length,
      calibrationBenchmarkBeatingVariants: parsed.variants.filter((variant) => (variant.calibration.excessReturnPct ?? 0) > 0).length,
      holdoutBenchmarkBeatingVariants: parsed.variants.filter((variant) => (variant.holdout.excessReturnPct ?? 0) > 0).length,
      selectedCandidate: selected ? {
        id: selected.id,
        strategy: selected.strategy,
        entryOffsetSeconds: selected.entryOffsetSeconds,
        calibration: selected.calibration,
        holdout: selected.holdout,
        profitableFolds: walkForward?.profitableFolds ?? 0,
        benchmarkBeatingFolds: walkForward?.benchmarkBeatingFolds ?? 0,
        totalFolds: walkForward?.totalFolds ?? 0,
      } : null,
      inputProvenance: parsed.inputProvenance ?? null,
      reproducibility: parsed.reproducibility,
      history: loadRealtimeShortTermResearchHistory(root),
    };
  } catch (error) {
    console.warn(`[monitoring] failed to parse realtime short-term artifact at ${path}`, error);
    return null;
  }
}

function loadRealtimeShortTermResearchHistory(root: string) {
  const path = resolve(root, "public/realtime-short-term-research-history.json");
  if (!existsSync(path)) return [];
  try {
    return z.object({ items: z.array(realtimeReplayHistoryItemSchema) })
      .parse(JSON.parse(readFileSync(path, "utf8"))).items;
  } catch {
    return [];
  }
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeSettlementBasis(positions: Array<{
  exitPriceBasisPct: number | null;
  closedAt: Date | null;
  exitReferenceCapturedAt: Date | null;
}>) {
  const measured = positions.filter((position) => typeof position.exitPriceBasisPct === "number");
  const absoluteValues = measured.map((position) => Math.abs(position.exitPriceBasisPct as number));
  const captureLags = measured.flatMap((position) => position.closedAt && position.exitReferenceCapturedAt
    ? [Math.abs(position.closedAt.getTime() - position.exitReferenceCapturedAt.getTime()) / 1_000]
    : []);
  const medianAbsolutePct = median(absoluteValues);
  const medianReferenceCaptureLagSeconds = median(captureLags);
  const timingComplete = captureLags.length === measured.length;
  const status = measured.length < 10
    ? "collecting" as const
    : (medianAbsolutePct ?? Number.POSITIVE_INFINITY) <= 0.001
      && timingComplete
      && (medianReferenceCaptureLagSeconds ?? Number.POSITIVE_INFINITY) <= 60
      ? "healthy" as const
      : "attention" as const;
  return {
    status,
    samples: measured.length,
    medianAbsolutePct,
    maximumAbsolutePct: absoluteValues.length ? Math.max(...absoluteValues) : null,
    medianReferenceCaptureLagSeconds,
  };
}

async function loadSynchronizedPriceQuality(input: {
  records: number;
  completeRecords: number;
  windowRecords: number;
  windowCompleteRecords: number;
  startedAt: Date | null;
  latestAt: Date | null;
}) {
  if (!input.startedAt || !input.latestAt) {
    return evaluateSynchronizedPriceQuality({
      ...input,
      totalRecords: 0,
      continuousStartedAt: null,
      medianSkewMs: null,
      p95SkewMs: null,
      medianSpread: null,
      p95Spread: null,
      medianAbsoluteBasisPct: null,
      p95AbsoluteBasisPct: null,
      maximumCaptureGapMs: null,
      assets: [],
    });
  }

  const qualityStartedAt = new Date(Math.max(input.startedAt.getTime(), input.latestAt.getTime() - 24 * 60 * 60 * 1_000));
  const continuityStartedAt = new Date(Math.max(input.startedAt.getTime(), input.latestAt.getTime() - 48 * 60 * 60 * 1_000));
  const [totalRecords, quantileRows, assetRows, continuityRows] = await Promise.all([
    prisma.marketSnapshot.count({ where: { capturedAt: { gte: qualityStartedAt } } }),
    prisma.$queryRaw<Array<Record<string, number | bigint | null>>>`
      WITH complete AS (
        SELECT
          "captureSkewMs",
          "spread",
          ABS("priceBasisPct") AS "absoluteBasisPct"
        FROM "MarketSnapshot"
        WHERE "capturedAt" >= ${qualityStartedAt}
          AND "synchronizationVersion" = 'fetch-time-v3-orderbook'
          AND "bestBid" IS NOT NULL
          AND "bestAsk" IS NOT NULL
          AND "spread" IS NOT NULL
          AND "hyperliquidMidPrice" IS NOT NULL
          AND "hyperliquidBestBid" IS NOT NULL
          AND "hyperliquidBestAsk" IS NOT NULL
          AND "hyperliquidSpread" IS NOT NULL
          AND "referencePrice" IS NOT NULL
          AND "priceBasisPct" IS NOT NULL
          AND "captureSkewMs" IS NOT NULL
      ), ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (ORDER BY "captureSkewMs") AS "skewRank",
          ROW_NUMBER() OVER (ORDER BY "spread") AS "spreadRank",
          ROW_NUMBER() OVER (ORDER BY "absoluteBasisPct") AS "basisRank",
          COUNT(*) OVER () AS "total"
        FROM complete
      )
      SELECT
        MAX(CASE WHEN "skewRank" = CAST(("total" - 1) * 0.5 AS INTEGER) + 1 THEN "captureSkewMs" END) AS "medianSkewMs",
        MAX(CASE WHEN "skewRank" = CAST(("total" - 1) * 0.95 AS INTEGER) + 1 THEN "captureSkewMs" END) AS "p95SkewMs",
        MAX(CASE WHEN "spreadRank" = CAST(("total" - 1) * 0.5 AS INTEGER) + 1 THEN "spread" END) AS "medianSpread",
        MAX(CASE WHEN "spreadRank" = CAST(("total" - 1) * 0.95 AS INTEGER) + 1 THEN "spread" END) AS "p95Spread",
        MAX(CASE WHEN "basisRank" = CAST(("total" - 1) * 0.5 AS INTEGER) + 1 THEN "absoluteBasisPct" END) AS "medianAbsoluteBasisPct",
        MAX(CASE WHEN "basisRank" = CAST(("total" - 1) * 0.95 AS INTEGER) + 1 THEN "absoluteBasisPct" END) AS "p95AbsoluteBasisPct"
      FROM ranked
    `,
    prisma.$queryRaw<Array<{ asset: string; records: number | bigint }>>`
      SELECT market."asset" AS "asset", COUNT(*) AS "records"
      FROM "MarketSnapshot" snapshot
      INNER JOIN "PredictionMarket" market ON market."id" = snapshot."marketId"
      WHERE snapshot."capturedAt" >= ${qualityStartedAt}
        AND snapshot."synchronizationVersion" = 'fetch-time-v3-orderbook'
        AND snapshot."bestBid" IS NOT NULL
        AND snapshot."bestAsk" IS NOT NULL
        AND snapshot."spread" IS NOT NULL
        AND snapshot."hyperliquidMidPrice" IS NOT NULL
        AND snapshot."hyperliquidBestBid" IS NOT NULL
        AND snapshot."hyperliquidBestAsk" IS NOT NULL
        AND snapshot."hyperliquidSpread" IS NOT NULL
        AND snapshot."referencePrice" IS NOT NULL
        AND snapshot."priceBasisPct" IS NOT NULL
        AND snapshot."captureSkewMs" IS NOT NULL
      GROUP BY market."asset"
      ORDER BY market."asset"
    `,
    prisma.$queryRaw<Array<{
      maximumCaptureGapMs: number | bigint | null;
      firstCaptureAt: Date | number | bigint | null;
      lastLargeGapAt: Date | number | bigint | null;
    }>>`
      WITH cycles AS (
        SELECT DISTINCT "capturedAt"
        FROM "MarketSnapshot"
        WHERE "capturedAt" >= ${continuityStartedAt}
          AND "synchronizationVersion" = 'fetch-time-v3-orderbook'
          AND "bestBid" IS NOT NULL
          AND "bestAsk" IS NOT NULL
          AND "spread" IS NOT NULL
          AND "hyperliquidMidPrice" IS NOT NULL
          AND "hyperliquidBestBid" IS NOT NULL
          AND "hyperliquidBestAsk" IS NOT NULL
          AND "hyperliquidSpread" IS NOT NULL
          AND "referencePrice" IS NOT NULL
          AND "priceBasisPct" IS NOT NULL
          AND "captureSkewMs" IS NOT NULL
      ), gaps AS (
        SELECT
          "capturedAt",
          EXTRACT(EPOCH FROM (
            "capturedAt" - LAG("capturedAt") OVER (ORDER BY "capturedAt")
          )) * 1000 AS "gapMs"
        FROM cycles
      )
      SELECT
        MAX("gapMs") AS "maximumCaptureGapMs",
        MIN("capturedAt") AS "firstCaptureAt",
        MAX(CASE WHEN "gapMs" > ${synchronizedQualityRequirements.maximumCaptureGapMs} THEN "capturedAt" END) AS "lastLargeGapAt"
      FROM gaps
    `,
  ]);
  const quantiles = quantileRows[0] ?? {};
  const continuity = continuityRows[0];
  const continuousStartedAt = dateFromDatabaseValue(continuity?.lastLargeGapAt ?? continuity?.firstCaptureAt);
  return evaluateSynchronizedPriceQuality({
    ...input,
    continuousStartedAt,
    totalRecords,
    medianSkewMs: finiteNumber(quantiles.medianSkewMs),
    p95SkewMs: finiteNumber(quantiles.p95SkewMs),
    medianSpread: finiteNumber(quantiles.medianSpread),
    p95Spread: finiteNumber(quantiles.p95Spread),
    medianAbsoluteBasisPct: finiteNumber(quantiles.medianAbsoluteBasisPct),
    p95AbsoluteBasisPct: finiteNumber(quantiles.p95AbsoluteBasisPct),
    maximumCaptureGapMs: finiteNumber(continuityRows[0]?.maximumCaptureGapMs),
    assets: assetRows.map((row) => ({ asset: row.asset, records: finiteNumber(row.records) ?? 0 })),
  });
}

function dateFromDatabaseValue(value: Date | number | bigint | null | undefined) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const milliseconds = finiteNumber(value);
  if (milliseconds === null) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

function finiteNumber(value: number | bigint | null | undefined) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestDate(...values: Array<Date | null | undefined>) {
  return values.filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

function earliestDate(...values: Array<Date | null | undefined>) {
  return values.filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}
