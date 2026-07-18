import type { ModelEvaluationRun } from "@prisma/client";

import { discoverHistoricalCryptoEvents, fetchHistoricalProbability, type HistoricalCryptoEvent } from "@/src/lib/backtest/polymarket";
import { evaluateChronologicalModel, HORIZON_HOURS, MODEL_VERSION } from "@/src/lib/model-evaluation/engine";
import { addPriceStructureFeatures } from "@/src/lib/model-evaluation/price-structure";
import { attachProspectiveModelEvaluation, loadProspectiveSynchronizedData, prospectiveMinimumEvaluationEvents } from "@/src/lib/model-evaluation/prospective-synchronized";
import { overlaySynchronizedExecution } from "@/src/lib/model-evaluation/synchronized-execution";
import type { EvaluationSample, ModelEvaluationMetrics, ModelEvaluationResult } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";

const maximumEvents = 300;
const priceHistoryFidelityMinutes = 1;
const maximumObservationAgeMinutes = 90;
export const PREDECLARED_HORIZONS = [6, 12, 24, 48] as const;

export async function runModelEvaluation(): Promise<ModelEvaluationResult> {
  const id = crypto.randomUUID();
  const startedAt = new Date();
  await prisma.modelEvaluationRun.create({
    data: {
      id,
      modelVersion: MODEL_VERSION,
      status: "running",
      configJson: JSON.stringify({
        predeclaredHorizonHours: PREDECLARED_HORIZONS,
        primaryHorizonHours: HORIZON_HOURS,
        priceHistoryFidelityMinutes,
        maximumObservationAgeMinutes,
        eventSampling: "up to 300 events: 80% latest asset-balanced terminal-price events and 20% long-history audit events",
        split: "probability 60/20/20; execution-eligible signals 60/40 chronological with a holding-period embargo; development data uses expanding-history selection followed by four untouched walk-forward folds",
        eventWeighting: "equal",
        signal: "Polymarket-implied terminal median with predeclared price-momentum, mean-reversion, funding-carry, and funding-momentum rules, evaluated independently by horizon",
        execution: "synchronized 1m signal/next-snapshot entry/pre-settlement exit with directional Hyperliquid best bid/ask when available; otherwise Hyperliquid 1h is retained as non-promotable reference data",
        candidateSelection: "ten predeclared candidates reselected from past-only data in each walk-forward fold, with block-bootstrap interval, deflated Sharpe, temporal stability, and same-period best-of-four benchmark excess",
        benchmarks: "always long, always short, raw Polymarket direction, and the median of 200 deterministic random-direction trials",
        costs: "observed Hyperliquid bid/ask spread when synchronized, plus 0.045% taker and 0.02% residual slippage per side, and realized hourly funding with a conservative 0.03% per 24h fallback",
        maximumPositionPctPerAsset: 0.05,
        maximumGrossExposurePct: 0.2,
      }),
      startedAt,
    },
  });

  try {
    const [datasets, prospective] = await Promise.all([
      loadEvaluationSamplesByHorizon([...PREDECLARED_HORIZONS]),
      loadProspectiveSynchronizedData({ enrich: true }),
    ]);
    const evaluations = new Map<number, ModelEvaluationMetrics>();
    const horizonStudies: NonNullable<ModelEvaluationMetrics["horizonStudies"]> = [];

    for (const horizonHours of PREDECLARED_HORIZONS) {
      const samples = datasets.get(horizonHours) ?? [];
      try {
        const metrics = evaluateChronologicalModel(samples, { horizonHours });
        evaluations.set(horizonHours, metrics);
        horizonStudies.push(toHorizonStudy(metrics));
      } catch (error) {
        horizonStudies.push({
          horizonHours,
          status: "unavailable",
          totalEvents: new Set(samples.map((sample) => sample.eventId)).size,
          testEvents: 0,
          eligibleSignals: 0,
          trades: 0,
          netReturnPct: null,
          bestBenchmarkReturnPct: null,
          excessReturnPct: null,
          deflatedSharpeProbability: null,
          testExecutionFeatureCoverage: null,
          testSynchronizedExecutionCoverage: null,
          maximumExecutionTimingErrorMinutes: null,
          error: error instanceof Error ? error.message : "horizon evaluation failed",
        });
      }
    }

    for (const horizonHours of PREDECLARED_HORIZONS) {
      const horizon = prospective.report.horizons.find((item) => item.horizonHours === horizonHours);
      if (!horizon || horizon.completedEvents < prospectiveMinimumEvaluationEvents) continue;
      try {
        const prospectiveMetrics = evaluateChronologicalModel(prospective.samplesByHorizon.get(horizonHours) ?? [], { horizonHours });
        attachProspectiveModelEvaluation(prospective.report, horizonHours, prospectiveMetrics);
      } catch {
        // Collection progress remains visible until a full chronological split is available.
      }
    }

    const metrics = evaluations.get(HORIZON_HOURS);
    if (!metrics) throw new Error(`primary ${HORIZON_HOURS}h evaluation is unavailable`);
    metrics.horizonStudies = horizonStudies;
    metrics.prospectiveSynchronized = prospective.report;
    const completed = await prisma.modelEvaluationRun.update({
      where: { id },
      data: {
        status: "completed",
        datasetHash: metrics.dataset.hash,
        metricsJson: JSON.stringify(metrics),
        completedAt: new Date(),
      },
    });
    return toResult(completed, metrics);
  } catch (error) {
    const message = error instanceof Error ? error.message : "model evaluation failed";
    const failed = await prisma.modelEvaluationRun.update({
      where: { id },
      data: { status: "failed", error: message, completedAt: new Date() },
    });
    return toResult(failed, null);
  }
}

export async function getLatestModelEvaluation() {
  const run = await prisma.modelEvaluationRun.findFirst({ where: { status: "completed" }, orderBy: { completedAt: "desc" } });
  return run ? toResult(run, parseMetrics(run.metricsJson)) : null;
}

export async function listModelEvaluations(limit = 12) {
  const runs = await prisma.modelEvaluationRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.min(50, Math.max(1, limit)) });
  return runs.map((run) => toResult(run, parseMetrics(run.metricsJson)));
}

export async function loadEvaluationSamples(horizonHours = HORIZON_HOURS) {
  const datasets = await loadEvaluationSamplesByHorizon([horizonHours]);
  return datasets.get(horizonHours) ?? [];
}

export async function loadEvaluationSamplesByHorizon(horizons: number[]) {
  const normalizedHorizons = Array.from(new Set(horizons.map((horizon) => Math.max(1, Math.round(horizon))))).sort((a, b) => a - b);
  if (!normalizedHorizons.length) return new Map<number, EvaluationSample[]>();
  const events = await discoverHistoricalCryptoEvents({ maxEvents: maximumEvents, horizonHours: normalizedHorizons[0] });
  const markets = events.flatMap((event) => event.markets.map((market) => ({ event, market })));

  const rows = await mapWithConcurrency(markets, 8, async ({ event, market }): Promise<EvaluationSample[]> => {
    const endAt = new Date(event.endDate);
    const eligibleHorizons = normalizedHorizons.filter((horizon) => eventSupportsHorizon(event, horizon));
    if (!eligibleHorizons.length) return [];
    const targets = eligibleHorizons.map((horizonHours) => ({
      horizonHours,
      targetMs: endAt.getTime() - horizonHours * 60 * 60 * 1_000,
    }));
    const earliestMs = Math.min(...targets.map((target) => target.targetMs)) - maximumObservationAgeMinutes * 60 * 1_000;
    const latestMs = Math.max(...targets.map((target) => target.targetMs));
    const history = await fetchHistoricalProbability(market.tokenId, {
      fidelity: priceHistoryFidelityMinutes,
      startTs: Math.floor(earliestMs / 1_000),
      endTs: Math.floor(latestMs / 1_000),
    });

    return targets.flatMap(({ horizonHours, targetMs }) => {
      const oldestAllowedMs = targetMs - maximumObservationAgeMinutes * 60 * 1_000;
      const observation = history
        .filter((point) => {
          const timestamp = new Date(point.timestamp).getTime();
          return timestamp <= targetMs && timestamp >= oldestAllowedMs;
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
      if (!observation) return [];
      return [{
        eventId: event.id,
        marketId: market.id,
        asset: market.asset,
        title: market.title,
        endAt: endAt.toISOString(),
        observedAt: observation.timestamp,
        horizonHours,
        marketProbability: observation.probability,
        observationLagMinutes: Math.max(0, targetMs - new Date(observation.timestamp).getTime()) / (60 * 1_000),
        outcome: market.result as 0 | 1,
      }];
    });
  });

  const rawSamples = rows.flatMap((row) => row ?? []);
  const hourlyEnriched = await addPriceStructureFeatures(rawSamples);
  const enriched = await overlaySynchronizedExecution(hourlyEnriched);
  return new Map(normalizedHorizons.map((horizonHours) => [
    horizonHours,
    enriched.filter((sample) => sample.horizonHours === horizonHours),
  ]));
}

function eventSupportsHorizon(event: HistoricalCryptoEvent, horizonHours: number) {
  const decisionAt = new Date(event.endDate).getTime() - horizonHours * 60 * 60 * 1_000;
  const startAt = new Date(event.startDate).getTime();
  const closedAt = event.closedTime ? new Date(event.closedTime).getTime() : Number.POSITIVE_INFINITY;
  return startAt < decisionAt && closedAt > decisionAt;
}

export function toHorizonStudy(metrics: ModelEvaluationMetrics): NonNullable<ModelEvaluationMetrics["horizonStudies"]>[number] {
  return {
    horizonHours: metrics.horizonHours,
    status: metrics.quality.status,
    totalEvents: metrics.dataset.totalEvents,
    testEvents: metrics.dataset.testEvents,
    eligibleSignals: metrics.combinedTrading.eligibleSignals,
    trades: metrics.combinedTrading.trades,
    netReturnPct: metrics.combinedTrading.netReturnPct,
    bestBenchmarkReturnPct: metrics.combinedTrading.benchmarks.bestReturnPct,
    excessReturnPct: metrics.combinedTrading.excessReturnPct,
    deflatedSharpeProbability: metrics.combinedTrading.deflatedSharpeProbability,
    testExecutionFeatureCoverage: metrics.dataset.testExecutionFeatureCoverage,
    testSynchronizedExecutionCoverage: metrics.dataset.testSynchronizedExecutionCoverage,
    maximumExecutionTimingErrorMinutes: metrics.dataset.maximumExecutionTimingErrorMinutes,
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R | null>(items.length).fill(null);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try { results[index] = await mapper(items[index]); } catch { results[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function toResult(run: ModelEvaluationRun, metrics: ModelEvaluationMetrics | null): ModelEvaluationResult {
  return {
    id: run.id,
    modelVersion: run.modelVersion,
    status: run.status,
    datasetHash: run.datasetHash,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    metrics,
    error: run.error,
  };
}

function parseMetrics(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as ModelEvaluationMetrics; } catch { return null; }
}
