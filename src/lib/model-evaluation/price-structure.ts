import { z } from "zod";

import { fetchWithTimeout } from "@/lib/utils";
import type { CryptoAsset } from "@/src/lib/backtest/types";
import type { EvaluationSample } from "@/src/lib/model-evaluation/types";

const HYPERLIQUID_INFO_API = "https://api.hyperliquid.xyz/info";
const candleInterval = "1h";
const candleIntervalHours = 1;
const minimumReturnCount = 72;
const volatilityLookbackCandles = 24 * 45;
const volatilityHalfLifeCandles = 24 * 7;
const candleChunkMs = 120 * 24 * 60 * 60 * 1_000;
const fundingChunkMs = 14 * 24 * 60 * 60 * 1_000;

const candleSchema = z.array(z.object({
  t: z.number(),
  T: z.number(),
  s: z.string(),
  i: z.string(),
  o: z.string(),
  c: z.string(),
}));

const fundingHistorySchema = z.array(z.object({
  fundingRate: z.union([z.string(), z.number()]),
  time: z.number(),
}));

type Candle = {
  openedAt: number;
  closedAt: number;
  open: number;
  close: number;
};

export type FundingPoint = {
  time: number;
  rate: number;
};

export type TerminalPriceCondition = {
  kind: "above" | "below" | "between";
  lower: number | null;
  upper: number | null;
};

export function parseTerminalPriceCondition(title: string): TerminalPriceCondition | null {
  const text = title.toLowerCase();
  if (/\b(dip|hit|reach|touch|before|during)\b|\ball[- ]time high\b|\bby\s/.test(text)) return null;

  const values = Array.from(text.matchAll(/\$\s*([0-9][0-9,.]*)(?:\s*([kmb]))?/gi), (match) => {
    const value = Number(match[1].replaceAll(",", ""));
    const multiplier = match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "b" ? 1_000_000_000 : 1;
    return value * multiplier;
  }).filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;

  if (/\bbetween\b/.test(text) && values.length >= 2) {
    const [lower, upper] = [values[0], values[1]].sort((a, b) => a - b);
    return { kind: "between", lower, upper };
  }
  if (/\b(below|lower than|less than|under)\b/.test(text)) return { kind: "below", lower: null, upper: values[0] };
  if (/\b(above|higher than|greater than|over)\b/.test(text)) return { kind: "above", lower: values[0], upper: null };
  return null;
}

export async function addPriceStructureFeatures(samples: EvaluationSample[]): Promise<EvaluationSample[]> {
  if (!samples.length) return samples;
  const assets = Array.from(new Set(samples.map((sample) => sample.asset))).filter(isSupportedAsset);
  const firstObservedAt = Math.min(...samples.map((sample) => new Date(sample.observedAt).getTime()));
  const lastEndAt = Math.max(...samples.map((sample) => new Date(sample.endAt).getTime()));
  const startTime = firstObservedAt - 45 * 24 * 60 * 60 * 1_000;
  const candlesByAsset = new Map(await Promise.all(assets.map(async (asset) => [
    asset,
    await fetchCandles(asset, startTime, lastEndAt),
  ] as const)));
  const fundingBounds = new Map(assets.flatMap((asset) => {
    const candles = candlesByAsset.get(asset) ?? [];
    const relevant = samples.filter((sample) => {
      if (sample.asset !== asset || !parseTerminalPriceCondition(sample.title)) return false;
      const observedAt = new Date(sample.observedAt).getTime();
      const endAt = new Date(sample.endAt).getTime();
      const currentIndex = findLatestClosedCandle(candles, observedAt);
      const entry = candles.find((candle) => candle.openedAt >= observedAt && candle.openedAt < endAt);
      const exitIndex = findLatestClosedCandle(candles, endAt);
      return currentIndex >= minimumReturnCount && Boolean(entry) && exitIndex >= 0;
    });
    if (!relevant.length) return [];
    return [[asset, {
      startTime: Math.min(...relevant.map((sample) => new Date(sample.observedAt).getTime())) - 24 * 60 * 60 * 1_000,
      endTime: Math.max(...relevant.map((sample) => new Date(sample.endAt).getTime())),
    }] as const];
  }));
  const fundingByAsset = new Map<CryptoAsset, FundingPoint[]>();
  for (const asset of assets) {
    const bounds = fundingBounds.get(asset);
    fundingByAsset.set(asset, bounds ? await fetchFundingHistory(asset, bounds.startTime, bounds.endTime).catch(() => []) : []);
    await sleep(250);
  }

  return samples.map((sample) => {
    const condition = parseTerminalPriceCondition(sample.title);
    if (!condition || !isSupportedAsset(sample.asset)) return sample;
    const candles = candlesByAsset.get(sample.asset);
    if (!candles?.length) return sample;
    const observedAt = new Date(sample.observedAt).getTime();
    const endAt = new Date(sample.endAt).getTime();
    const targetAt = endAt - (sample.horizonHours ?? 24) * 60 * 60 * 1_000;
    const currentIndex = findLatestClosedCandle(candles, observedAt);
    if (currentIndex < minimumReturnCount) return sample;
    const current = candles[currentIndex];
    const entry = candles.find((candle) => candle.openedAt >= targetAt && candle.openedAt < endAt);
    const exitIndex = findLatestClosedCandle(candles, endAt);
    const exit = exitIndex >= 0 ? candles[exitIndex] : null;
    const funding = summarizeFundingAt(fundingByAsset.get(sample.asset) ?? [], observedAt, entry?.openedAt ?? null, exit?.closedAt ?? null);
    const priceWindow = candles.slice(Math.max(0, currentIndex - volatilityLookbackCandles), currentIndex + 1);
    const returns = priceWindow
      .slice(1)
      .map((candle, index) => Math.log(candle.close / priceWindow[index].close))
      .filter(Number.isFinite);
    if (returns.length < minimumReturnCount) return sample;

    const variancePerCandle = exponentiallyWeightedVariance(returns);
    const horizonHours = Math.max(1, (endAt - current.closedAt) / (60 * 60 * 1_000));
    const horizonVariance = variancePerCandle * horizonHours / candleIntervalHours;
    const horizonVolatility = Math.sqrt(Math.max(1e-8, horizonVariance));
    const structuralProbability = probabilityForCondition(current.close, horizonVolatility, condition);

    return {
      ...sample,
      structuralProbability,
      spotPrice: current.close,
      realizedVolatility24h: Math.sqrt(Math.max(1e-8, variancePerCandle * 24 / candleIntervalHours)),
      hyperliquidEntryAt: entry ? new Date(entry.openedAt).toISOString() : null,
      hyperliquidEntryPrice: entry?.open ?? null,
      hyperliquidExitAt: exit ? new Date(exit.closedAt).toISOString() : null,
      hyperliquidExitPrice: exit?.close ?? null,
      hyperliquidEntryLagMinutes: entry ? Math.max(0, entry.openedAt - targetAt) / (60 * 1_000) : null,
      hyperliquidExitLeadMinutes: exit ? Math.max(0, endAt - exit.closedAt) / (60 * 1_000) : null,
      hyperliquidMomentum6h: trailingLogReturn(candles, currentIndex, 6),
      hyperliquidMomentum24h: trailingLogReturn(candles, currentIndex, 24),
      hyperliquidFunding24h: funding.prior24h,
      hyperliquidFundingDuringTrade: funding.duringTrade,
      executionPriceSource: "hyperliquid-1h" as const,
      thresholdKind: condition.kind,
      thresholdLower: condition.lower,
      thresholdUpper: condition.upper,
    };
  });
}

export function summarizeFundingAt(
  points: FundingPoint[],
  observedAt: number,
  entryAt: number | null,
  exitAt: number | null,
) {
  return {
    prior24h: sumFundingWindow(points, observedAt - 24 * 60 * 60 * 1_000, observedAt),
    duringTrade: entryAt !== null && exitAt !== null && exitAt > entryAt
      ? sumFundingWindow(points, entryAt, exitAt)
      : null,
  };
}

function trailingLogReturn(candles: Candle[], currentIndex: number, hours: number) {
  const current = candles[currentIndex];
  const targetAt = current.closedAt - hours * 60 * 60 * 1_000;
  const priorIndex = findLatestClosedCandle(candles, targetAt);
  if (priorIndex < 0) return null;
  const prior = candles[priorIndex];
  const timingErrorHours = Math.abs(targetAt - prior.closedAt) / (60 * 60 * 1_000);
  if (timingErrorHours > 1.1 || prior.close <= 0) return null;
  const value = Math.log(current.close / prior.close);
  return Number.isFinite(value) ? value : null;
}

export function probabilityForCondition(spot: number, horizonVolatility: number, condition: TerminalPriceCondition) {
  const volatility = Math.max(0.001, horizonVolatility);
  const cdf = (threshold: number) => normalCdf(Math.log(threshold / spot) / volatility);
  if (condition.kind === "above" && condition.lower) return clamp(1 - cdf(condition.lower), 0.001, 0.999);
  if (condition.kind === "below" && condition.upper) return clamp(cdf(condition.upper), 0.001, 0.999);
  if (condition.kind === "between" && condition.lower && condition.upper) {
    return clamp(cdf(condition.upper) - cdf(condition.lower), 0.001, 0.999);
  }
  return 0.5;
}

async function fetchCandles(asset: CryptoAsset, startTime: number, endTime: number): Promise<Candle[]> {
  const chunks: Array<{ startTime: number; endTime: number }> = [];
  for (let chunkStart = startTime; chunkStart < endTime; chunkStart += candleChunkMs) {
    chunks.push({ startTime: chunkStart, endTime: Math.min(endTime, chunkStart + candleChunkMs) });
  }
  const rows: Candle[] = [];
  for (const chunk of chunks) rows.push(...await fetchCandleChunk(asset, chunk.startTime, chunk.endTime));
  return Array.from(new Map(rows.map((candle) => [candle.openedAt, candle])).values())
    .sort((left, right) => left.closedAt - right.closedAt);
}

async function fetchCandleChunk(asset: CryptoAsset, startTime: number, endTime: number): Promise<Candle[]> {
  const response = await fetchWithTimeout(HYPERLIQUID_INFO_API, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin: asset, interval: candleInterval, startTime, endTime },
    }),
  }, 30_000);
  if (!response.ok) throw new Error(`Hyperliquid candle history ${asset}: ${response.status}`);
  return candleSchema.parse(await response.json())
    .map((candle) => ({ openedAt: candle.t, closedAt: candle.T, open: Number(candle.o), close: Number(candle.c) }))
    .filter((candle) => Number.isFinite(candle.open) && candle.open > 0 && Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => a.closedAt - b.closedAt);
}

async function fetchFundingHistory(asset: CryptoAsset, startTime: number, endTime: number): Promise<FundingPoint[]> {
  const rows: FundingPoint[] = [];
  for (let chunkStart = startTime; chunkStart <= endTime; chunkStart += fundingChunkMs) {
    const chunkEnd = Math.min(endTime, chunkStart + fundingChunkMs - 1);
    rows.push(...await fetchFundingChunk(asset, chunkStart, chunkEnd));
    await sleep(150);
  }
  return Array.from(new Map(rows.map((point) => [point.time, point])).values())
    .sort((left, right) => left.time - right.time);
}

async function fetchFundingChunk(asset: CryptoAsset, startTime: number, endTime: number) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetchWithTimeout(HYPERLIQUID_INFO_API, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "fundingHistory", coin: asset, startTime, endTime }),
    }, 30_000);
    if (response.ok) {
      return fundingHistorySchema.parse(await response.json())
        .map((point) => ({ time: point.time, rate: Number(point.fundingRate) }))
        .filter((point) => Number.isFinite(point.rate) && Number.isFinite(point.time))
        .sort((left, right) => left.time - right.time);
    }
    if (response.status !== 429 || attempt === 3) throw new Error(`Hyperliquid funding history ${asset}: ${response.status}`);
    await sleep(1_000 * (attempt + 1));
  }
  return [];
}

function sumFundingWindow(points: FundingPoint[], startExclusive: number, endInclusive: number) {
  const expectedHours = Math.max(1, (endInclusive - startExclusive) / (60 * 60 * 1_000));
  const values = points.filter((point) => point.time > startExclusive && point.time <= endInclusive);
  if (values.length < Math.max(1, Math.ceil(expectedHours * 0.75))) return null;
  return values.reduce((sum, point) => sum + point.rate, 0);
}

function findLatestClosedCandle(candles: Candle[], observedAt: number) {
  let low = 0;
  let high = candles.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closedAt <= observedAt) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function exponentiallyWeightedVariance(returns: number[]) {
  const decay = Math.exp(-Math.log(2) / volatilityHalfLifeCandles);
  let weight = 1;
  let weightedSquares = 0;
  let totalWeight = 0;
  for (let index = returns.length - 1; index >= 0; index -= 1) {
    weightedSquares += weight * returns[index] ** 2;
    totalWeight += weight;
    weight *= decay;
  }
  return weightedSquares / totalWeight;
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function isSupportedAsset(asset: CryptoAsset): asset is "BTC" | "ETH" | "SOL" | "XRP" {
  return asset === "BTC" || asset === "ETH" || asset === "SOL" || asset === "XRP";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
