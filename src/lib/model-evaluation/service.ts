import type { ModelEvaluationRun } from "@prisma/client";

import { discoverHistoricalCryptoEvents, fetchHistoricalProbability } from "@/src/lib/backtest/polymarket";
import { evaluateChronologicalModel, HORIZON_HOURS, MODEL_VERSION } from "@/src/lib/model-evaluation/engine";
import { addPriceStructureFeatures } from "@/src/lib/model-evaluation/price-structure";
import type { EvaluationSample, ModelEvaluationMetrics, ModelEvaluationResult } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";

const maximumEvents = 260;
const maximumObservationAgeHours = 3;

export async function runModelEvaluation(): Promise<ModelEvaluationResult> {
  const id = crypto.randomUUID();
  const startedAt = new Date();
  await prisma.modelEvaluationRun.create({
    data: {
      id,
      modelVersion: MODEL_VERSION,
      status: "running",
      configJson: JSON.stringify({
        horizonHours: HORIZON_HOURS,
        maximumObservationAgeHours,
        split: "60/20/20 chronological events",
        eventWeighting: "equal",
        signal: "Polymarket-implied 24h terminal median",
        execution: "Hyperliquid 8h open-to-close, one non-overlapping position at a time",
        candidateSelection: "validation-only signal threshold with positive 95% net-return interval and long-benchmark excess",
        costs: "0.045% taker and 0.02% slippage per side, plus 0.03% funding per 24h",
        maximumPositionPct: 0.2,
      }),
      startedAt,
    },
  });

  try {
    const samples = await loadEvaluationSamples();
    const metrics = evaluateChronologicalModel(samples);
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

export async function loadEvaluationSamples() {
  const events = await discoverHistoricalCryptoEvents({ maxEvents: maximumEvents, horizonHours: HORIZON_HOURS });
  const markets = events.flatMap((event) => event.markets.map((market) => ({ event, market })));

  const rows = await mapWithConcurrency(markets, 8, async ({ event, market }): Promise<EvaluationSample | null> => {
    const endAt = new Date(event.endDate);
    const targetMs = endAt.getTime() - HORIZON_HOURS * 60 * 60 * 1_000;
    const oldestAllowedMs = targetMs - maximumObservationAgeHours * 60 * 60 * 1_000;
    const history = await fetchHistoricalProbability(market.tokenId, {
      fidelity: 60,
      startTs: Math.floor(oldestAllowedMs / 1_000),
      endTs: Math.floor(targetMs / 1_000),
    });
    const observation = history
      .filter((point) => {
        const timestamp = new Date(point.timestamp).getTime();
        return timestamp <= targetMs && timestamp >= oldestAllowedMs;
      })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    if (!observation) return null;
    return {
      eventId: event.id,
      marketId: market.id,
      asset: market.asset,
      title: market.title,
      endAt: endAt.toISOString(),
      observedAt: observation.timestamp,
      marketProbability: observation.probability,
      outcome: market.result as 0 | 1,
    };
  });

  return addPriceStructureFeatures(rows.filter((row): row is EvaluationSample => Boolean(row)));
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
  return results as R[];
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
