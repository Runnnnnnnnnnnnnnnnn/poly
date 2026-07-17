import type { BacktestRun, HyperliquidSnapshot, PipelineHeartbeat } from "@prisma/client";

import type { BacktestMetrics } from "@/src/lib/backtest/types";
import type { ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";

const monitoredAssets = ["BTC", "ETH", "SOL", "XRP", "HYPE"] as const;
const freshnessMs = 12 * 60 * 1_000;

export type MonitoringSnapshot = Awaited<ReturnType<typeof getMonitoringSnapshot>>;

export async function getMonitoringSnapshot() {
  const now = new Date();
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const [
    polymarketAggregate,
    polymarketLast24Hours,
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
  ] = await Promise.all([
    prisma.marketSnapshot.aggregate({ _count: { _all: true }, _min: { capturedAt: true }, _max: { capturedAt: true } }),
    prisma.marketSnapshot.count({ where: { capturedAt: { gte: last24Hours } } }),
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
  ]);

  const usableBacktests = backtestRuns
    .map((run) => ({ run, metrics: parseBacktestMetrics(run) }))
    .filter((item): item is { run: BacktestRun; metrics: BacktestMetrics } => Boolean(item.metrics?.observations));
  const latestBacktest = usableBacktests.find((item) => item.run.asset === "BTC" && item.metrics.observations >= 100 && item.metrics.markets >= 10)
    ?? usableBacktests.find((item) => item.metrics.observations >= 100 && item.metrics.markets >= 10)
    ?? usableBacktests[0]
    ?? null;
  const evaluation = parseJson<ModelEvaluationMetrics>(latestEvaluation?.metricsJson ?? null);

  const resolvedAiRows = aiRows.filter((row) => row.resolvedOutcome !== null && row.brierScore !== null);
  const averageAiBrier = average(resolvedAiRows.map((row) => row.brierScore as number));
  const averageMarketBrier = average(resolvedAiRows.map((row) => (row.marketProbability - (row.resolvedOutcome as number)) ** 2));
  const aiImprovement = averageAiBrier !== null && averageMarketBrier !== null ? averageMarketBrier - averageAiBrier : null;

  const latestCompletedPaper = paperRuns.find((run) => run.status === "completed" && run.metricsJson) ?? null;
  const latestPaperMetrics = parseJson<Record<string, number | null>>(latestCompletedPaper?.metricsJson ?? null);
  const newestDataAt = latestDate(polymarketAggregate._max.capturedAt, hyperAggregate._max.capturedAt, paperEquityAggregate._max.capturedAt);
  const oldestDataAt = earliestDate(polymarketAggregate._min.capturedAt, hyperAggregate._min.capturedAt, paperEquityAggregate._min.capturedAt);
  const ageMs = newestDataAt ? now.getTime() - newestDataAt.getTime() : Number.POSITIVE_INFINITY;
  const status = ageMs <= freshnessMs ? "live" : ageMs <= 60 * 60 * 1_000 ? "delayed" : "offline";

  const inferredPipelines = pipelineStatuses({
    now,
    heartbeats,
    polymarketAt: polymarketAggregate._max.capturedAt,
    hyperliquidAt: hyperAggregate._max.capturedAt,
    backtestAt: latestBacktest?.run.completedAt ?? null,
    evaluationAt: latestEvaluation?.completedAt ?? null,
    paperAt: paperEquityAggregate._max.capturedAt,
  });

  return {
    status,
    generatedAt: now.toISOString(),
    collection: {
      startedAt: oldestDataAt?.toISOString() ?? null,
      latestAt: newestDataAt?.toISOString() ?? null,
      totalRecords: polymarketAggregate._count._all + hyperAggregate._count._all + backtestPointCount + paperEquityAggregate._count._all + aiRows.length,
      last24Hours: polymarketLast24Hours + hyperLast24Hours + paperEquityLast24Hours,
    },
    polymarket: {
      snapshots: polymarketAggregate._count._all,
      markets: marketCount,
      latestAt: polymarketAggregate._max.capturedAt?.toISOString() ?? null,
      backtestRuns: backtestRunCount,
      backtestPoints: backtestPointCount,
    },
    model: {
      name: latestEvaluation?.modelVersion ?? "Polymarket x Hyperliquid Signal v6",
      selectedCandidate: evaluation?.selectedCandidate.id ?? null,
      selectedCandidateKind: evaluation?.selectedCandidate.kind ?? null,
      combinedStrategy: evaluation?.combinedTrading?.selectedStrategy.id ?? null,
      combinedMinimumSignalZ: evaluation?.combinedTrading?.selectedStrategy.minimumSignalZ ?? null,
      structuralFeatureCoverage: evaluation?.dataset.executionFeatureCoverage ?? evaluation?.dataset.structuralFeatureCoverage ?? null,
      evaluationStatus: evaluation?.quality.status ?? "building",
      latestAsset: evaluation ? Object.keys(evaluation.dataset.assets).join("・") : null,
      latestBrierScore: evaluation?.probability.modelBrierScore ?? null,
      latestAccuracy: evaluation?.combinedTrading?.directionalAccuracy ?? evaluation?.probability.modelAccuracy ?? null,
      latestReturnPct: evaluation?.combinedTrading?.netReturnPct ?? evaluation?.trading.netReturnPct ?? null,
      benchmarkReturnPct: evaluation?.combinedTrading?.benchmarkReturnPct ?? null,
      excessReturnPct: evaluation?.combinedTrading?.excessReturnPct ?? null,
      eligibleSignals: evaluation?.combinedTrading?.eligibleSignals ?? 0,
      testedMarkets: evaluation?.dataset.testMarkets ?? 0,
      testedEvents: evaluation?.dataset.testEvents ?? 0,
      observations: evaluation?.dataset.totalMarkets ?? 0,
      brierImprovement: evaluation?.probability.relativeImprovement ?? null,
      previousBrierScore: evaluation?.probability.marketBrierScore ?? null,
      confidenceInterval95: evaluation?.combinedTrading?.returnConfidenceInterval95 ?? evaluation?.probability.confidenceInterval95 ?? null,
      statisticallyPositive: evaluation?.combinedTrading?.statisticallyPositive ?? evaluation?.probability.statisticallyPositive ?? false,
      completedAt: latestEvaluation?.completedAt?.toISOString() ?? null,
      datasetStartedAt: evaluation?.dataset.firstEndAt ?? null,
      datasetEndedAt: evaluation?.dataset.lastEndAt ?? null,
      trades: evaluation?.combinedTrading?.trades ?? evaluation?.trading.trades ?? 0,
      longTrades: evaluation?.combinedTrading?.longTrades ?? 0,
      shortTrades: evaluation?.combinedTrading?.shortTrades ?? 0,
      winRate: evaluation?.combinedTrading?.winRate ?? evaluation?.trading.winRate ?? null,
      averageTradeReturn: evaluation?.combinedTrading?.averageNetTradeReturn ?? null,
      maxDrawdownPct: evaluation?.combinedTrading?.maxDrawdownPct ?? evaluation?.trading.maxDrawdownPct ?? null,
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
    pipelines: inferredPipelines,
  };
}

function pipelineStatuses(input: {
  now: Date;
  heartbeats: PipelineHeartbeat[];
  polymarketAt: Date | null;
  hyperliquidAt: Date | null;
  backtestAt: Date | null;
  evaluationAt: Date | null;
  paperAt: Date | null;
}) {
  const heartbeatMap = new Map(input.heartbeats.map((item) => [item.id, item]));
  return [
    pipeline("polymarket", "Polymarket収集", "5分ごと", input.polymarketAt, heartbeatMap.get("polymarket"), input.now),
    pipeline("hyperliquid", "相場データ収集", "5分ごと", input.hyperliquidAt, heartbeatMap.get("hyperliquid"), input.now),
    pipeline("backtest", "モデル再検証", "6時間ごと", input.evaluationAt ?? input.backtestAt, heartbeatMap.get("backtest"), input.now, 30 * 60 * 60 * 1_000),
    pipeline("paper", "仮想運用", "5分ごと", input.paperAt, heartbeatMap.get("paper"), input.now),
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

function latestDate(...values: Array<Date | null | undefined>) {
  return values.filter((value): value is Date => Boolean(value)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

function earliestDate(...values: Array<Date | null | undefined>) {
  return values.filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}
