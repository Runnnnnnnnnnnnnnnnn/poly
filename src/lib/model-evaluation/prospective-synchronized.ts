import type { MarketSnapshot, PredictionMarket, Prisma } from "@prisma/client";

import { addPriceStructureFeatures, parseTerminalPriceCondition } from "@/src/lib/model-evaluation/price-structure";
import { applySynchronizedExecutionOverlay, synchronizedSnapshotWhere } from "@/src/lib/model-evaluation/synchronized-execution";
import type { EvaluationSample, ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";

export const prospectiveHorizons = [6, 12, 24, 48] as const;
export const prospectiveTargetEvents = 50;
export const prospectiveMinimumEvaluationEvents = 30;
const maximumSignalAgeMs = 5 * 60 * 1_000;
const maximumEntryLagMs = 5 * 60 * 1_000;
const maximumExitLeadMs = 5 * 60 * 1_000;

type ExactSnapshot = Pick<
  MarketSnapshot,
  "marketId" | "capturedAt" | "probability" | "bestBid" | "bestAsk" | "spread" | "hyperliquidMidPrice"
  | "hyperliquidBestBid" | "hyperliquidBestAsk" | "hyperliquidSpread" | "priceBasisPct" | "captureSkewMs"
>;

type RegisteredMarket = Pick<PredictionMarket, "id" | "eventId" | "asset" | "title" | "endDate" | "resolved" | "result">;

export type ProspectiveSynchronizedHorizon = {
  horizonHours: number;
  scheduledMarkets: number;
  upcomingMarkets: number;
  observedMarkets: number;
  missedMarkets: number;
  awaitingExitMarkets: number;
  awaitingResolutionMarkets: number;
  completedMarkets: number;
  completedEvents: number;
  holdoutEvents: number;
  eventGroupingCoverage: number;
  observationCoverage: number;
  targetEvents: number;
  status: "collecting" | "inconclusive" | "underperforming" | "promising";
  modelStatus: ModelEvaluationMetrics["quality"]["status"] | null;
  trades: number;
  netReturnPct: number | null;
  excessReturnPct: number | null;
};

export type ProspectiveSynchronizedReport = {
  methodology: "prospective-1m-orderbook-holdout";
  collectionStartedAt: string | null;
  latestSnapshotAt: string | null;
  generatedAt: string;
  completedEvents: number;
  targetEvents: number;
  horizons: ProspectiveSynchronizedHorizon[];
};

type ProspectiveData = {
  report: ProspectiveSynchronizedReport;
  samplesByHorizon: Map<number, EvaluationSample[]>;
};

export async function loadProspectiveSynchronizedData(options: { enrich?: boolean; now?: Date } = {}): Promise<ProspectiveData> {
  const now = options.now ?? new Date();
  const [bounds, markets, snapshots] = await Promise.all([
    prisma.marketSnapshot.aggregate({
      where: synchronizedSnapshotWhere,
      _min: { capturedAt: true },
      _max: { capturedAt: true },
    }),
    prisma.predictionMarket.findMany({
      where: { endDate: { not: null } },
      select: { id: true, eventId: true, asset: true, title: true, endDate: true, resolved: true, result: true },
    }),
    prisma.marketSnapshot.findMany({
      where: synchronizedSnapshotWhere,
      orderBy: [{ marketId: "asc" }, { capturedAt: "asc" }],
      select: exactSnapshotSelect,
    }),
  ]);
  return buildProspectiveSynchronizedData(markets, snapshots, {
    firstAt: bounds._min.capturedAt,
    lastAt: bounds._max.capturedAt,
    now,
    enrich: options.enrich === true,
  });
}

async function buildProspectiveSynchronizedData(
  markets: RegisteredMarket[],
  snapshots: ExactSnapshot[],
  options: { firstAt: Date | null; lastAt: Date | null; now: Date; enrich: boolean },
): Promise<ProspectiveData> {
  const snapshotsByMarket = new Map<string, ExactSnapshot[]>();
  for (const snapshot of snapshots) snapshotsByMarket.set(snapshot.marketId, [...(snapshotsByMarket.get(snapshot.marketId) ?? []), snapshot]);
  const firstAtMs = options.firstAt?.getTime() ?? null;
  const lastAtMs = options.lastAt?.getTime() ?? null;
  const baseSamplesByHorizon = new Map<number, EvaluationSample[]>();
  const triplets = new Map<string, ReturnType<typeof selectProspectiveExecutionTriplet>>();

  const horizons = prospectiveHorizons.map((horizonHours): ProspectiveSynchronizedHorizon => {
    const counters = {
      scheduledMarkets: 0,
      upcomingMarkets: 0,
      observedMarkets: 0,
      missedMarkets: 0,
      awaitingExitMarkets: 0,
      awaitingResolutionMarkets: 0,
      completedMarkets: 0,
    };
    const completedEventIds = new Set<string>();
    const observedEventIds = new Set<string>();
    let observedWithEventId = 0;
    const samples: EvaluationSample[] = [];

    if (firstAtMs !== null && lastAtMs !== null) {
      for (const market of markets) {
        const condition = parseTerminalPriceCondition(market.title);
        if (!condition || condition.kind === "between") continue;
        const endAt = market.endDate?.getTime();
        if (endAt === undefined) continue;
        const targetAt = endAt - horizonHours * 60 * 60 * 1_000;
        if (targetAt < firstAtMs) continue;
        counters.scheduledMarkets += 1;
        if (targetAt > lastAtMs) {
          counters.upcomingMarkets += 1;
          continue;
        }
        const triplet = selectProspectiveExecutionTriplet(snapshotsByMarket.get(market.id) ?? [], targetAt, endAt);
        if (!triplet.signal || !triplet.entry) {
          if (targetAt + maximumEntryLagMs <= lastAtMs) counters.missedMarkets += 1;
          continue;
        }
        counters.observedMarkets += 1;
        observedEventIds.add(market.eventId ?? market.id);
        if (market.eventId) observedWithEventId += 1;
        if (!triplet.exit) {
          counters.awaitingExitMarkets += 1;
          continue;
        }
        if (!market.resolved || market.result === null) {
          counters.awaitingResolutionMarkets += 1;
          continue;
        }
        counters.completedMarkets += 1;
        const eventId = market.eventId ?? market.id;
        completedEventIds.add(eventId);
        const sample: EvaluationSample = {
          eventId,
          marketId: market.id,
          asset: market.asset as EvaluationSample["asset"],
          title: market.title,
          endAt: new Date(endAt).toISOString(),
          observedAt: triplet.signal.capturedAt.toISOString(),
          horizonHours,
          marketProbability: triplet.signal.probability,
          outcome: market.result as 0 | 1,
        };
        samples.push(sample);
        triplets.set(sampleKey(sample), triplet);
      }
    }
    baseSamplesByHorizon.set(horizonHours, samples);
    const completedEvents = completedEventIds.size;
    const holdoutEvents = completedEvents >= prospectiveMinimumEvaluationEvents ? Math.max(5, Math.ceil(completedEvents * 0.2)) : 0;
    const elapsedWindows = counters.observedMarkets + counters.missedMarkets;
    return {
      horizonHours,
      ...counters,
      completedEvents,
      holdoutEvents,
      eventGroupingCoverage: counters.observedMarkets ? observedWithEventId / counters.observedMarkets : 0,
      observationCoverage: elapsedWindows ? counters.observedMarkets / elapsedWindows : 0,
      targetEvents: prospectiveTargetEvents,
      status: "collecting",
      modelStatus: null,
      trades: 0,
      netReturnPct: null,
      excessReturnPct: null,
    };
  });

  let samplesByHorizon = baseSamplesByHorizon;
  if (options.enrich && horizons.some((horizon) => horizon.completedEvents >= prospectiveMinimumEvaluationEvents)) {
    const allSamples = prospectiveHorizons.flatMap((horizon) => baseSamplesByHorizon.get(horizon) ?? []);
    const enriched = await addPriceStructureFeatures(allSamples);
    const exact = enriched.map((sample) => {
      const triplet = triplets.get(sampleKey(sample));
      const targetAt = new Date(sample.endAt).getTime() - (sample.horizonHours ?? 24) * 60 * 60 * 1_000;
      return triplet?.signal && triplet.entry && triplet.exit
        ? applySynchronizedExecutionOverlay(sample, {
            signal: triplet.signal,
            entry: triplet.entry,
            exit: triplet.exit,
            targetAt,
            endAt: new Date(sample.endAt).getTime(),
          })
        : sample;
    });
    samplesByHorizon = new Map(prospectiveHorizons.map((horizon) => [
      horizon,
      exact.filter((sample) => sample.horizonHours === horizon),
    ]));
  }

  return {
    report: {
      methodology: "prospective-1m-orderbook-holdout",
      collectionStartedAt: options.firstAt?.toISOString() ?? null,
      latestSnapshotAt: options.lastAt?.toISOString() ?? null,
      generatedAt: options.now.toISOString(),
      completedEvents: Math.max(0, ...horizons.map((horizon) => horizon.completedEvents)),
      targetEvents: prospectiveTargetEvents,
      horizons,
    },
    samplesByHorizon,
  };
}

export function selectProspectiveExecutionTriplet(snapshots: ExactSnapshot[], targetAt: number, endAt: number) {
  let signal: ExactSnapshot | null = null;
  let entry: ExactSnapshot | null = null;
  let exit: ExactSnapshot | null = null;
  for (const snapshot of snapshots) {
    const capturedAt = snapshot.capturedAt.getTime();
    if (capturedAt >= targetAt - maximumSignalAgeMs && capturedAt <= targetAt) signal = snapshot;
    if (!entry && capturedAt > targetAt && capturedAt <= Math.min(endAt, targetAt + maximumEntryLagMs)) entry = snapshot;
    if (capturedAt >= endAt - maximumExitLeadMs && capturedAt <= endAt) exit = snapshot;
  }
  return { signal, entry, exit };
}

export function attachProspectiveModelEvaluation(
  report: ProspectiveSynchronizedReport,
  horizonHours: number,
  metrics: ModelEvaluationMetrics,
) {
  const horizon = report.horizons.find((item) => item.horizonHours === horizonHours);
  if (!horizon) return;
  horizon.modelStatus = metrics.quality.status;
  horizon.status = horizon.completedEvents < prospectiveTargetEvents ? "collecting" : metrics.quality.status;
  horizon.trades = metrics.combinedTrading.trades;
  horizon.netReturnPct = metrics.combinedTrading.trades ? metrics.combinedTrading.netReturnPct : null;
  horizon.excessReturnPct = metrics.combinedTrading.trades ? metrics.combinedTrading.excessReturnPct : null;
}

const exactSnapshotSelect = {
  marketId: true,
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

function sampleKey(sample: EvaluationSample) {
  return `${sample.marketId}:${sample.horizonHours ?? 24}`;
}
