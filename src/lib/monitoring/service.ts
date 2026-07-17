import type { BacktestRun, HyperliquidSnapshot, PipelineHeartbeat } from "@prisma/client";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { BacktestMetrics } from "@/src/lib/backtest/types";
import {
  evaluateForwardExperiment,
  forwardControlExperimentKey,
  forwardStrategyExperimentKey,
} from "@/src/lib/combined-trading/forward-evaluation";
import type { CombinedShadowConfig } from "@/src/lib/combined-trading/service";
import { getHyperliquidExecutionReadiness } from "@/src/lib/combined-trading/hyperliquid-execution";
import type { ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";
import { evaluateSynchronizedPriceQuality } from "@/src/lib/monitoring/synchronized-quality";

const monitoredAssets = ["BTC", "ETH", "SOL", "XRP", "HYPE"] as const;
const freshnessMs = 12 * 60 * 1_000;

export type MonitoringSnapshot = Awaited<ReturnType<typeof getMonitoringSnapshot>>;

export async function getMonitoringSnapshot() {
  const now = new Date();
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
    heartbeats,
    latestHyperliquid,
    latestEvaluation,
    combinedRuns,
    combinedDecisionCount,
    combinedSnapshotAggregate,
    combinedSnapshotsLast24Hours,
  ] = await Promise.all([
    prisma.marketSnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.marketSnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
    prisma.marketSnapshot.aggregate({
      where: {
        bestBid: { not: null },
        bestAsk: { not: null },
        spread: { not: null },
        synchronizationVersion: "fetch-time-v2",
        hyperliquidMidPrice: { not: null },
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
        synchronizationVersion: "fetch-time-v2",
        hyperliquidMidPrice: { not: null },
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
        synchronizationVersion: "fetch-time-v2",
        hyperliquidMidPrice: { not: null },
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
        synchronizationVersion: "fetch-time-v2",
        hyperliquidMidPrice: { not: null },
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
    prisma.pipelineHeartbeat.findMany({ orderBy: { id: "asc" } }),
    Promise.all(monitoredAssets.map((asset) => prisma.hyperliquidSnapshot.findFirst({ where: { asset }, orderBy: { capturedAt: "desc" } }))),
    prisma.modelEvaluationRun.findFirst({ where: { status: "completed" }, orderBy: { completedAt: "desc" } }),
    prisma.combinedShadowRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    prisma.combinedShadowDecision.count(),
    prisma.combinedShadowEquitySnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.combinedShadowEquitySnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
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
  const evaluation = parseJson<ModelEvaluationMetrics>(latestEvaluation?.metricsJson ?? null);
  const combinedRun = combinedRuns.find((run) => (
    parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.experimentKey === forwardStrategyExperimentKey
  )) ?? combinedRuns.find((run) => (
    parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.forwardOnly === true
  )) ?? combinedRuns[0] ?? null;
  const controlRun = combinedRuns.find((run) => (
    parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.experimentKey === forwardControlExperimentKey
  )) ?? null;

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
  const [latestCombinedDecision, latestCombinedSnapshot, combinedOpenPositions, combinedClosedTrades, combinedWinningTrades, combinedDecisions, combinedPositions, controlPositions] = combinedRun
    ? await Promise.all([
        prisma.combinedShadowDecision.findFirst({ where: { runId: combinedRun.id }, orderBy: { observedAt: "desc" } }),
        prisma.combinedShadowEquitySnapshot.findFirst({ where: { runId: combinedRun.id }, orderBy: { capturedAt: "desc" } }),
        prisma.combinedShadowPosition.findMany({ where: { runId: combinedRun.id, status: "OPEN" }, orderBy: { openedAt: "asc" } }),
        prisma.combinedShadowPosition.count({ where: { runId: combinedRun.id, status: "CLOSED" } }),
        prisma.combinedShadowPosition.count({ where: { runId: combinedRun.id, status: "CLOSED", realizedPnl: { gt: 0 } } }),
        prisma.combinedShadowDecision.findMany({
          where: { runId: combinedRun.id },
          select: { action: true, signalZ: true, threshold: true },
          orderBy: { observedAt: "asc" },
        }),
        prisma.combinedShadowPosition.findMany({
          where: { runId: combinedRun.id },
          orderBy: { openedAt: "asc" },
        }),
        controlRun
          ? prisma.combinedShadowPosition.findMany({ where: { runId: controlRun.id }, orderBy: { openedAt: "asc" } })
          : Promise.resolve([]),
      ])
    : [null, null, [], 0, 0, [], [], []];
  const measuredBasis = combinedPositions.flatMap((position) => (
    typeof position.exitPriceBasisPct === "number" ? [position] : []
  ));
  const absoluteBasisValues = measuredBasis.map((position) => Math.abs(position.exitPriceBasisPct as number));
  const referenceCaptureLags = measuredBasis.flatMap((position) => (
    position.closedAt && position.exitReferenceCapturedAt
      ? [Math.abs(position.closedAt.getTime() - position.exitReferenceCapturedAt.getTime()) / 1_000]
      : []
  ));
  const medianAbsoluteBasisPct = median(absoluteBasisValues);
  const medianReferenceCaptureLagSeconds = median(referenceCaptureLags);
  const referenceTimingComplete = referenceCaptureLags.length === measuredBasis.length;
  const settlementBasisStatus = measuredBasis.length < 10
    ? "collecting" as const
    : (medianAbsoluteBasisPct ?? Number.POSITIVE_INFINITY) <= 0.001
      && referenceTimingComplete
      && (medianReferenceCaptureLagSeconds ?? Number.POSITIVE_INFINITY) <= 60
      ? "healthy" as const
      : "attention" as const;
  const combinedConfig = parseJson<Partial<CombinedShadowConfig>>(combinedRun?.configJson ?? null);
  const forwardEvaluation = combinedRun && combinedConfig?.forwardOnly === true
    ? evaluateForwardExperiment({
        strategyPositions: combinedPositions,
        controlPositions,
        strategyStartedAt: combinedRun.startedAt,
        controlStartedAt: controlRun?.startedAt ?? null,
        initialEquity: combinedRun.initialEquity,
        takerFeePerSide: combinedConfig.takerFeePerSide ?? 0.00045,
        slippagePerSide: combinedConfig.slippagePerSide ?? 0.0002,
        fundingPer24h: combinedConfig.fundingPer24h ?? 0.0003,
        maxDrawdownPct: combinedRun.maxDrawdownPct,
        settlementBasisStatus,
      })
    : null;
  const latestPaperMetrics = parseJson<Record<string, number | null>>(latestCompletedPaper?.metricsJson ?? null);
  const newestDataAt = latestDate(
    polymarketAggregate._max.capturedAt,
    hyperAggregate._max.capturedAt,
    paperEquityAggregate._max.capturedAt,
    combinedSnapshotAggregate._max.capturedAt,
    ...heartbeats.map((heartbeat) => heartbeat.lastSuccessAt),
  );
  const oldestDataAt = earliestDate(polymarketAggregate._min.capturedAt, hyperAggregate._min.capturedAt, paperEquityAggregate._min.capturedAt);
  const ageMs = newestDataAt ? now.getTime() - newestDataAt.getTime() : Number.POSITIVE_INFINITY;
  const status = ageMs <= freshnessMs ? "live" : ageMs <= 60 * 60 * 1_000 ? "delayed" : "offline";
  const historicalCombinedEdgeConfirmed = evaluation?.quality.status === "promising"
    && evaluation.combinedTrading?.selectedStrategy.id !== "no-trade guard"
    && evaluation.combinedTrading?.statisticallyPositive === true;
  const combinedEdgeConfirmed = historicalCombinedEdgeConfirmed || forwardEvaluation?.status === "promising";
  const runningPaperReturnPct = latestRunningPaper && latestRunningEquity
    ? latestRunningEquity.equity / latestRunningPaper.initialCash - 1
    : null;
  const executionReadiness = getHyperliquidExecutionReadiness();
  const testnetReconciliation = heartbeats.find((heartbeat) => heartbeat.id === "testnet-reconcile");
  const alertHeartbeat = heartbeats.find((heartbeat) => heartbeat.id === "operational-alerts");
  const tunnelStatus = readTunnelStatus();
  const backupStatus = readBackupStatus();
  const combinedShadowRunning = combinedRun?.status === "running";

  const inferredPipelines = pipelineStatuses({
    now,
    heartbeats,
    polymarketAt: polymarketAggregate._max.capturedAt,
    hyperliquidAt: hyperAggregate._max.capturedAt,
    backtestAt: latestBacktest?.run.completedAt ?? null,
    evaluationAt: latestEvaluation?.completedAt ?? null,
    paperAt: paperEquityAggregate._max.capturedAt,
    combinedAt: combinedSnapshotAggregate._max.capturedAt,
  });

  return {
    status,
    generatedAt: now.toISOString(),
    collection: {
      startedAt: oldestDataAt?.toISOString() ?? null,
      latestAt: newestDataAt?.toISOString() ?? null,
      totalRecords: polymarketAggregate._count._all + hyperAggregate._count._all + backtestPointCount + paperEquityAggregate._count._all + aiRows.length + combinedDecisionCount + combinedSnapshotAggregate._count._all,
      last24Hours: polymarketLast24Hours + hyperLast24Hours + paperEquityLast24Hours + combinedSnapshotsLast24Hours,
      synchronizedPrices: {
        records: synchronizedAggregate._count._all,
        last24Hours: synchronizedLast24Hours,
        latestAt: synchronizedAggregate._max.capturedAt?.toISOString() ?? null,
        maximumSkewMs: synchronizedAggregate._max.captureSkewMs ?? null,
        targetCadenceMinutes: 1,
        quality: synchronizedQuality,
      },
    },
    tradeReadiness: {
      objective: "Polymarketの予測をシグナルにしてHyperliquidで売買する",
      currentStage: combinedShadowRunning ? "shadow" : "backtest",
      realTradingEnabled: false,
      combinedPaperRunning: combinedShadowRunning,
      hyperliquidOrderConnection: executionReadiness.ready
        ? executionReadiness.autoMirrorEnabled ? "testnet_armed" : "testnet_ready"
        : executionReadiness.installed ? "connector_ready" : "not_installed",
      gates: [
        {
          id: "data",
          label: "同期データ品質",
          status: status !== "live"
            ? "attention" as const
            : synchronizedQuality.status === "healthy"
              ? "ready" as const
              : synchronizedQuality.status === "collecting"
                ? "running" as const
                : "attention" as const,
        },
        { id: "edge", label: "優位性確認", status: combinedEdgeConfirmed ? "ready" : "blocked" },
        { id: "shadow", label: "シャドー検証", status: combinedShadowRunning ? "running" : "not_started" },
        { id: "testnet", label: "テストネット", status: executionReadiness.ready ? "ready" : executionReadiness.installed ? "attention" : "not_started" },
        { id: "live", label: "実取引", status: "locked" },
      ],
    },
    combinedShadow: {
      status: combinedRun?.status ?? "not_started",
      startedAt: combinedRun?.startedAt.toISOString() ?? null,
      updatedAt: latestCombinedSnapshot?.capturedAt.toISOString() ?? null,
      initialEquity: combinedRun?.initialEquity ?? null,
      equity: latestCombinedSnapshot?.equity ?? combinedRun?.equity ?? null,
      returnPct: forwardEvaluation?.netReturnPct
        ?? (combinedRun && combinedRun.initialEquity > 0 ? combinedRun.realizedPnl / combinedRun.initialEquity : null),
      cash: combinedRun?.cash ?? null,
      realizedPnl: combinedRun?.realizedPnl ?? null,
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
      trades: forwardEvaluation?.trades ?? combinedClosedTrades,
      wins: forwardEvaluation?.wins ?? combinedWinningTrades,
      winRate: forwardEvaluation?.winRate ?? (combinedClosedTrades > 0 ? combinedWinningTrades / combinedClosedTrades : null),
      maxDrawdownPct: combinedRun?.maxDrawdownPct ?? null,
      riskStatus: combinedRun?.riskStatus ?? "NOT_STARTED",
      emergencyStopped: combinedRun?.emergencyStopped ?? false,
      experimentKey: combinedConfig?.experimentKey ?? null,
      experimentLabel: combinedConfig?.experimentLabel ?? null,
      forwardOnly: combinedConfig?.forwardOnly === true,
      minimumSignalZ: combinedConfig?.minimumSignalZ ?? null,
      minimumFunding24h: combinedConfig?.minimumFunding24h ?? null,
      signalRule: combinedConfig?.signalRule ?? "polymarket-only",
      modelVersion: combinedConfig?.modelVersion ?? null,
      forwardEvaluation,
      settlementBasis: {
        status: settlementBasisStatus,
        samples: measuredBasis.length,
        medianAbsolutePct: medianAbsoluteBasisPct,
        maximumAbsolutePct: absoluteBasisValues.length ? Math.max(...absoluteBasisValues) : null,
        medianReferenceCaptureLagSeconds,
      },
      funnel: {
        scans: combinedDecisions.length,
        scannedMarkets: latestCombinedDecision?.scannedMarkets ?? 0,
        structuredMarkets: latestCombinedDecision?.structuredMarkets ?? 0,
        horizonEligibleMarkets: latestCombinedDecision?.horizonEligibleMarkets ?? 0,
        groupedEvents: latestCombinedDecision?.groupedEvents ?? 0,
        priceReadyEvents: latestCombinedDecision?.priceReadyEvents ?? 0,
        thresholdSignals: combinedDecisions.filter((decision) => (
          typeof decision.signalZ === "number" && Math.abs(decision.signalZ) >= decision.threshold
        )).length,
        opened: combinedDecisions.filter((decision) => decision.action === "OPEN_LONG" || decision.action === "OPEN_SHORT").length,
        closed: combinedClosedTrades,
      },
      latestDecision: latestCombinedDecision ? {
        action: latestCombinedDecision.action,
        reason: latestCombinedDecision.reason,
        asset: latestCombinedDecision.asset,
        signalZ: latestCombinedDecision.signalZ,
        spotPrice: latestCombinedDecision.spotPrice,
        targetPrice: latestCombinedDecision.targetPrice,
        polymarketSide: latestCombinedDecision.polymarketSide,
        strategySide: latestCombinedDecision.strategySide,
        trendZ6h: latestCombinedDecision.trendZ6h,
        hyperliquidFunding24h: latestCombinedDecision.hyperliquidFunding24h,
        horizonHours: latestCombinedDecision.horizonHours,
        marketBestBid: latestCombinedDecision.marketBestBid,
        marketBestAsk: latestCombinedDecision.marketBestAsk,
        marketSpread: latestCombinedDecision.marketSpread,
        polymarketReferencePrice: latestCombinedDecision.polymarketReferencePrice,
        referenceSource: latestCombinedDecision.referenceSource,
        priceBasisPct: latestCombinedDecision.priceBasisPct,
        ladderViolations: latestCombinedDecision.ladderViolations,
        nextWindowAt: latestCombinedDecision.nextWindowAt?.toISOString() ?? null,
        observedAt: latestCombinedDecision.observedAt.toISOString(),
      } : null,
      testnet: {
        ...executionReadiness,
        reconciliation: {
          status: testnetReconciliation?.status ?? "not_configured",
          lastSuccessAt: testnetReconciliation?.lastSuccessAt?.toISOString() ?? null,
          message: testnetReconciliation?.message ?? null,
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
      latestAccuracy: evaluation?.combinedTrading?.directionalAccuracy ?? evaluation?.probability.modelAccuracy ?? null,
      latestReturnPct: evaluation?.combinedTrading?.netReturnPct ?? evaluation?.trading.netReturnPct ?? null,
      benchmarkReturnPct: evaluation?.combinedTrading?.benchmarkReturnPct ?? null,
      benchmarkReturns: evaluation?.combinedTrading?.benchmarks ?? null,
      horizonStudies: evaluation?.horizonStudies ?? [],
      excessReturnPct: evaluation?.combinedTrading?.excessReturnPct ?? null,
      eligibleSignals: evaluation?.combinedTrading?.eligibleSignals ?? 0,
      testedMarkets: evaluation?.dataset.testMarkets ?? 0,
      testedEvents: evaluation?.combinedTrading?.eligibleSignals ?? evaluation?.dataset.testEvents ?? 0,
      observations: evaluation?.dataset.totalMarkets ?? 0,
      brierImprovement: evaluation?.probability.relativeImprovement ?? null,
      previousBrierScore: evaluation?.probability.marketBrierScore ?? null,
      confidenceInterval95: evaluation?.combinedTrading?.returnConfidenceInterval95 ?? evaluation?.probability.confidenceInterval95 ?? null,
      statisticallyPositive: evaluation?.combinedTrading?.statisticallyPositive ?? evaluation?.probability.statisticallyPositive ?? false,
      deflatedSharpeProbability: evaluation?.combinedTrading?.deflatedSharpeProbability ?? null,
      strategyTrials: evaluation?.combinedTrading?.strategyTrials ?? 0,
      walkForwardFolds: evaluation?.combinedTrading?.walkForwardFolds ?? 0,
      profitableValidationFolds: evaluation?.combinedTrading?.profitableValidationFolds ?? 0,
      completedAt: latestEvaluation?.completedAt?.toISOString() ?? null,
      datasetStartedAt: evaluation?.dataset.firstEndAt ?? null,
      datasetEndedAt: evaluation?.dataset.lastEndAt ?? null,
      trades: evaluation?.combinedTrading?.trades ?? evaluation?.trading.trades ?? 0,
      longTrades: evaluation?.combinedTrading?.longTrades ?? 0,
      shortTrades: evaluation?.combinedTrading?.shortTrades ?? 0,
      winRate: evaluation?.combinedTrading?.winRate ?? evaluation?.trading.winRate ?? null,
      averageTradeReturn: evaluation?.combinedTrading?.averageNetTradeReturn ?? null,
      maxDrawdownPct: evaluation?.combinedTrading?.maxDrawdownPct ?? evaluation?.trading.maxDrawdownPct ?? null,
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

function readBackupStatus() {
  try {
    const directory = resolve(homedir(), ".polymarket-watch/backups");
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".db.enc"))
      .map((name) => ({ modifiedAt: statSync(resolve(directory, name)).mtime }))
      .sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
    return {
      status: files.length ? "healthy" as const : "waiting" as const,
      encrypted: true,
      copies: files.length,
      latestAt: files[0]?.modifiedAt.toISOString() ?? null,
    };
  } catch {
    return { status: "waiting" as const, encrypted: true, copies: 0, latestAt: null };
  }
}

function pipelineStatuses(input: {
  now: Date;
  heartbeats: PipelineHeartbeat[];
  polymarketAt: Date | null;
  hyperliquidAt: Date | null;
  backtestAt: Date | null;
  evaluationAt: Date | null;
  paperAt: Date | null;
  combinedAt: Date | null;
}) {
  const heartbeatMap = new Map(input.heartbeats.map((item) => [item.id, item]));
  return [
    pipeline("polymarket", "価格同期収集", "1分ごと", input.polymarketAt, heartbeatMap.get("polymarket"), input.now),
    pipeline("hyperliquid", "相場データ収集", "1分ごと", input.hyperliquidAt, heartbeatMap.get("hyperliquid"), input.now),
    pipeline("backtest", "モデル再検証", "6時間ごと", input.evaluationAt ?? input.backtestAt, heartbeatMap.get("backtest"), input.now, 30 * 60 * 60 * 1_000),
    pipeline("paper", "Poly仮想運用", "5分ごと", input.paperAt, heartbeatMap.get("paper"), input.now),
    pipeline("combined-shadow", "組み合わせ市場確認", "5分ごと", input.combinedAt, heartbeatMap.get("combined-shadow"), input.now),
    pipeline("forward-experiment", "次期モデル検証", "5分ごと", input.combinedAt, heartbeatMap.get("forward-experiment"), input.now),
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

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
          AND "synchronizationVersion" = 'fetch-time-v2'
          AND "bestBid" IS NOT NULL
          AND "bestAsk" IS NOT NULL
          AND "spread" IS NOT NULL
          AND "hyperliquidMidPrice" IS NOT NULL
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
        AND snapshot."synchronizationVersion" = 'fetch-time-v2'
        AND snapshot."bestBid" IS NOT NULL
        AND snapshot."bestAsk" IS NOT NULL
        AND snapshot."spread" IS NOT NULL
        AND snapshot."hyperliquidMidPrice" IS NOT NULL
        AND snapshot."referencePrice" IS NOT NULL
        AND snapshot."priceBasisPct" IS NOT NULL
        AND snapshot."captureSkewMs" IS NOT NULL
      GROUP BY market."asset"
      ORDER BY market."asset"
    `,
    prisma.$queryRaw<Array<{ maximumCaptureGapMs: number | bigint | null }>>`
      WITH cycles AS (
        SELECT DISTINCT "capturedAt"
        FROM "MarketSnapshot"
        WHERE "capturedAt" >= ${continuityStartedAt}
          AND "synchronizationVersion" = 'fetch-time-v2'
          AND "bestBid" IS NOT NULL
          AND "bestAsk" IS NOT NULL
          AND "spread" IS NOT NULL
          AND "hyperliquidMidPrice" IS NOT NULL
          AND "referencePrice" IS NOT NULL
          AND "priceBasisPct" IS NOT NULL
          AND "captureSkewMs" IS NOT NULL
      ), gaps AS (
        SELECT "capturedAt" - LAG("capturedAt") OVER (ORDER BY "capturedAt") AS "gapMs"
        FROM cycles
      )
      SELECT MAX("gapMs") AS "maximumCaptureGapMs" FROM gaps
    `,
  ]);
  const quantiles = quantileRows[0] ?? {};
  return evaluateSynchronizedPriceQuality({
    ...input,
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
