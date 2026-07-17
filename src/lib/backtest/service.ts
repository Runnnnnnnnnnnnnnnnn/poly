import type { BacktestPoint, BacktestRun } from "@prisma/client";

import { prisma } from "@/src/lib/server/prisma";
import { calculateBacktestMetrics } from "@/src/lib/backtest/metrics";
import { discoverCryptoMarkets, fetchCurrentBooks, fetchHistoricalProbability } from "@/src/lib/backtest/polymarket";
import type { BacktestMetrics, BacktestResult, CryptoAsset, CryptoForecast, CryptoMarket } from "@/src/lib/backtest/types";
import {
  calculatePriceBasisPct,
  fetchPolymarketReferencePrices,
  selectReferencePrice,
  type SupportedReferenceAsset,
} from "@/src/lib/combined-trading/polymarket-reference";
import { fetchHyperliquidMarketStates } from "@/src/lib/monitoring/hyperliquid";

const DEFAULT_INITIAL_CAPITAL = 1_000;
const DEFAULT_THRESHOLD = 0.55;

export async function collectCryptoSnapshots(options: { assets?: CryptoAsset[]; limit?: number } = {}) {
  const markets = await discoverCryptoMarkets({ includeResolved: false, limit: options.limit ?? 80 });
  const assets = options.assets?.length ? new Set(options.assets) : null;
  const selected = markets.filter((market) => !assets || assets.has(market.asset));
  const referenceAssets = Array.from(new Set(selected.map((market) => market.asset).filter(isSupportedReferenceAsset)));
  const [books, referencePrices, hyperliquidStates] = await Promise.all([
    fetchCurrentBooks(selected.map((market) => market.tokenId)).catch(() => new Map()),
    fetchPolymarketReferencePrices(referenceAssets).catch(() => []),
    fetchHyperliquidMarketStates().catch(() => []),
  ]);
  const hyperliquidByAsset = new Map(hyperliquidStates.map((state) => [state.asset, state]));
  const capturedAt = new Date();
  let saved = 0;
  let synchronized = 0;

  for (const market of selected) {
    if (market.currentProbability === null) continue;
    const book = books.get(market.tokenId);
    const bestBid = book?.bids[0]?.price ?? null;
    const bestAsk = book?.asks[0]?.price ?? null;
    const probability = bestBid !== null && bestAsk !== null && bestAsk >= bestBid
      ? clamp((bestBid + bestAsk) / 2, 0.0001, 0.9999)
      : market.currentProbability;
    const hyperliquid = hyperliquidByAsset.get(market.asset);
    const reference = isSupportedReferenceAsset(market.asset)
      ? selectReferencePrice(referencePrices, market.asset, market.referenceSource)
      : null;
    const captureSkewMs = calculateCaptureSkewMs([
      book?.capturedAt ?? null,
      hyperliquid?.capturedAt ?? null,
      reference?.capturedAt ? new Date(reference.capturedAt) : null,
    ]);
    await prisma.predictionMarket.upsert({
      where: { id: market.id },
      create: toMarketCreate(market, capturedAt),
      update: {
        tokenId: market.tokenId,
        title: market.title,
        slug: market.slug,
        endDate: toDate(market.endDate),
        lastSeenAt: capturedAt,
      },
    });
    await prisma.marketSnapshot.create({
      data: {
        id: `${market.id}:${capturedAt.getTime()}`,
        marketId: market.id,
        probability,
        yesPrice: probability,
        noPrice: 1 - probability,
        volume: market.volume,
        liquidity: market.liquidity,
        bestBid,
        bestAsk,
        spread: bestBid !== null && bestAsk !== null && bestAsk >= bestBid ? bestAsk - bestBid : null,
        clobCapturedAt: book?.capturedAt ?? null,
        hyperliquidMidPrice: hyperliquid?.midPrice ?? null,
        hyperliquidMarkPrice: hyperliquid?.markPrice ?? null,
        hyperliquidOraclePrice: hyperliquid?.oraclePrice ?? null,
        hyperliquidFundingRate: hyperliquid?.fundingRate ?? null,
        hyperliquidCapturedAt: hyperliquid?.capturedAt ?? null,
        referencePrice: reference?.price ?? null,
        referenceSource: reference?.source ?? null,
        referenceCapturedAt: reference?.capturedAt ? new Date(reference.capturedAt) : null,
        priceBasisPct: hyperliquid && reference ? calculatePriceBasisPct(hyperliquid.midPrice, reference.price) : null,
        captureSkewMs,
        capturedAt,
      },
    });
    saved += 1;
    if (bestBid !== null && bestAsk !== null && hyperliquid && reference && captureSkewMs !== null && captureSkewMs <= 60_000) synchronized += 1;
  }

  return {
    capturedAt: capturedAt.toISOString(),
    discovered: selected.length,
    saved,
    synchronized,
    synchronizationCoverage: saved ? synchronized / saved : 0,
  };
}

export function calculateCaptureSkewMs(values: Array<Date | null>) {
  const timestamps = values.flatMap((value) => value && Number.isFinite(value.getTime()) ? [value.getTime()] : []);
  if (timestamps.length !== values.length || timestamps.length < 2) return null;
  return Math.max(...timestamps) - Math.min(...timestamps);
}

export async function runBacktest(options: {
  asset?: CryptoAsset;
  threshold?: number;
  initialCapital?: number;
  limit?: number;
} = {}) {
  const asset = options.asset ?? "BTC";
  const threshold = clamp(options.threshold ?? DEFAULT_THRESHOLD, 0.5, 0.99);
  const initialCapital = Math.max(1, options.initialCapital ?? DEFAULT_INITIAL_CAPITAL);
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  await prisma.backtestRun.create({
    data: {
      id: runId,
      asset,
      status: "running",
      threshold,
      initialCapital,
      startedAt,
    },
  });

  try {
    const discovered = await discoverCryptoMarkets({ includeResolved: true, asset, limit: options.limit ?? 80 });
    const markets = discovered.filter((market) => market.resolved && market.result !== null);
    const datasets = await Promise.all(markets.map(async (market) => {
      try {
        const history = await fetchHistoricalProbability(market.tokenId);
        const endMs = market.endDate ? new Date(market.endDate).getTime() : Number.POSITIVE_INFINITY;
        return { market, history: history.filter((point) => new Date(point.timestamp).getTime() <= endMs) };
      } catch {
        return { market, history: [] };
      }
    }));
    const usable = datasets.filter((dataset) => dataset.history.length > 0);
    const stake = usable.length > 0 ? initialCapital / usable.length : 0;
    const points: Array<Omit<BacktestPoint, "run">> = [];
    const marketSummaries: BacktestResult["markets"] = [];

    for (const dataset of usable) {
      const result = dataset.market.result as 0 | 1;
      let lastProbability: number | null = null;
      let traded = false;
      for (const observation of dataset.history) {
        const probability = clamp(observation.probability, 0.0001, 0.9999);
        const brierScore = (probability - result) ** 2;
        const logLoss = -(result * Math.log(probability) + (1 - result) * Math.log(1 - probability));
        const position = probability >= threshold ? 1 : probability <= 1 - threshold ? -1 : 0;
        const pnl = !traded && position === 1
          ? stake * ((result === 1 ? 1 / probability : 0) - 1)
          : !traded && position === -1
            ? stake * ((result === 0 ? 1 / (1 - probability) : 0) - 1)
            : 0;
        if (position !== 0) traded = true;
        points.push({
          id: crypto.randomUUID(),
          runId,
          marketId: dataset.market.id,
          observedAt: new Date(observation.timestamp),
          predictedProbability: probability,
          actualOutcome: result,
          brierScore,
          logLoss,
          position,
          pnl,
        });
        lastProbability = probability;
      }
      marketSummaries.push({
        marketId: dataset.market.id,
        title: dataset.market.title,
        result,
        observations: dataset.history.length,
        firstProbability: dataset.history[0]?.probability ?? null,
        lastProbability,
      });
    }

    if (points.length > 0) {
      await prisma.backtestPoint.createMany({ data: points });
    }
    const metrics = calculateBacktestMetrics(points, initialCapital, usable.length);
    const completedAt = new Date();
    const completed = await prisma.backtestRun.update({
      where: { id: runId },
      data: { status: "completed", marketCount: usable.length, metricsJson: JSON.stringify(metrics), completedAt },
    });
    return toResult(completed, marketSummaries, metrics);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const failed = await prisma.backtestRun.update({ where: { id: runId }, data: { status: "failed", error: message, completedAt: new Date() } });
    return toResult(failed, [], null);
  }
}

export async function listBacktests(limit = 20) {
  const runs = await prisma.backtestRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.min(limit, 100) });
  return runs.map((run) => toResult(run, [], parseMetrics(run.metricsJson)));
}

export async function getBacktest(id: string): Promise<BacktestResult | null> {
  const run = await prisma.backtestRun.findUnique({ where: { id }, include: { points: { orderBy: { observedAt: "asc" } } } });
  if (!run) return null;
  const grouped = new Map<string, BacktestPoint[]>();
  for (const point of run.points) grouped.set(point.marketId, [...(grouped.get(point.marketId) ?? []), point]);
  const registry = await prisma.predictionMarket.findMany({ where: { id: { in: Array.from(grouped.keys()) } }, select: { id: true, title: true } });
  const titles = new Map(registry.map((market) => [market.id, market.title]));
  const markets = Array.from(grouped.entries()).map(([marketId, points]) => ({
    marketId,
    title: titles.get(marketId) ?? marketId,
    result: points[0].actualOutcome as 0 | 1,
    observations: points.length,
    firstProbability: points[0].predictedProbability,
    lastProbability: points.at(-1)?.predictedProbability ?? null,
  }));
  return toResult(run, markets, parseMetrics(run.metricsJson));
}

export async function getCryptoForecast(asset: CryptoAsset, targetDate?: string): Promise<CryptoForecast> {
  const discovered = await discoverCryptoMarkets({ includeResolved: false, asset, limit: 100 });
  const candidates = discovered
    .map((market) => ({ market, threshold: parseCryptoThreshold(market.title) }))
    .filter((item): item is { market: CryptoMarket; threshold: number } => item.threshold !== null && item.market.currentProbability !== null);
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const date = candidate.market.endDate ? candidate.market.endDate.slice(0, 10) : "undated";
    groups.set(date, [...(groups.get(date) ?? []), candidate]);
  }
  const selected = targetDate
    ? groups.get(targetDate) ?? []
    : Array.from(groups.values()).sort((a, b) => b.length - a.length)[0] ?? [];
  const selectedDate = selected[0]?.market.endDate?.slice(0, 10) ?? null;
  const dateLabel = selectedDate
    ? new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${selectedDate}T00:00:00Z`))
    : null;
  const dateMatched = dateLabel && selected.some(({ market }) => market.title.includes(dateLabel))
    ? selected.filter(({ market }) => market.title.includes(dateLabel))
    : selected;
  const curve = dateMatched
    .map(({ market, threshold }) => ({ marketId: market.id, title: market.title, threshold, probability: market.currentProbability as number }))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.threshold === item.threshold) === index)
    .sort((a, b) => a.threshold - b.threshold);
  return {
    asset,
    targetDate: selected[0]?.market.endDate?.slice(0, 10) ?? null,
    marketCount: curve.length,
    impliedMedian: quantileFromSurvival(curve, 0.5),
    quantiles: {
      p10: quantileFromSurvival(curve, 0.9),
      p25: quantileFromSurvival(curve, 0.75),
      p75: quantileFromSurvival(curve, 0.25),
      p90: quantileFromSurvival(curve, 0.1),
    },
    curve,
    generatedAt: new Date().toISOString(),
  };
}

function toMarketCreate(market: CryptoMarket, seenAt: Date) {
  return {
    id: market.id,
    asset: market.asset,
    tokenId: market.tokenId,
    title: market.title,
    slug: market.slug,
    endDate: toDate(market.endDate),
    resolved: market.resolved,
    result: market.result,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}

function toResult(run: BacktestRun, markets: BacktestResult["markets"], metrics: BacktestMetrics | null): BacktestResult {
  return {
    id: run.id,
    asset: run.asset as CryptoAsset,
    status: run.status,
    threshold: run.threshold,
    initialCapital: run.initialCapital,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    metrics,
    markets,
    error: run.error,
  };
}

function parseMetrics(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as BacktestMetrics; } catch { return null; }
}

function toDate(value: string | null) { return value && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function isSupportedReferenceAsset(asset: CryptoAsset): asset is SupportedReferenceAsset {
  return asset === "BTC" || asset === "ETH" || asset === "SOL" || asset === "XRP";
}

function parseCryptoThreshold(title: string) {
  const match = title.match(/(?:above|over|reach|at\s+or\s+above|higher\s+than)[^$€£\d]{0,20}[$€£]?\s*([\d,.]+)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function quantileFromSurvival(curve: Array<{ threshold: number; probability: number }>, targetSurvival: number) {
  if (curve.length === 0) return null;
  for (let index = 0; index < curve.length - 1; index += 1) {
    const left = curve[index];
    const right = curve[index + 1];
    if ((left.probability >= targetSurvival && right.probability <= targetSurvival) || (left.probability <= targetSurvival && right.probability >= targetSurvival)) {
      const denominator = right.probability - left.probability;
      if (Math.abs(denominator) < 1e-9) return (left.threshold + right.threshold) / 2;
      const weight = (targetSurvival - left.probability) / denominator;
      return left.threshold + (right.threshold - left.threshold) * weight;
    }
  }
  return targetSurvival >= curve[0].probability ? curve[0].threshold : curve.at(-1)?.threshold ?? null;
}
