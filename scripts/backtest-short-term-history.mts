import { z } from "zod";

import { calculateShortTermImpliedSignal } from "../src/lib/combined-trading/short-term-implied-signal";
import {
  blockBootstrapMeanConfidenceInterval,
  deflatedSharpeProbability,
} from "../src/lib/model-evaluation/combined-trading";

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
const strategyTrials = Math.round(boundedNumber(process.env.SHORT_TERM_STRATEGY_TRIALS, 6, 1, 100));

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
const endAt = new Date(generatedAt.getTime() - 5 * 60_000);
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
  const implied = samples.find((sample) => sample.impliedSelected);
  const leadLag = samples.find((sample) => sample.leadLagSelected);
  const baselineReturn = baseline
    ? calculateCandleReturn(baseline.baselineSide, baseline.entryCandle, exitCandle, candles) ?? 0
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
    baseline: {
      selected: Boolean(baseline),
      side: (baseline ?? representative).baselineSide,
      returnPct: baselineReturn,
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

const splitIndex = Math.floor(observations.length * calibrationFraction);
const calibration = observations.slice(0, splitIndex);
const holdout = observations.slice(splitIndex);
const calibrationSummary = summarizePeriod(calibration);
const holdoutSummary = summarizePeriod(holdout);
console.log(JSON.stringify({
  generatedAt: generatedAt.toISOString(),
  methodology: {
    status: "screening_only",
    warning: "Aggregated price history has no executable order book and cannot authorize testnet or real trading.",
    period: { startAt: startAt.toISOString(), endAt: endAt.toISOString(), lookbackHours },
    split: "chronological 60% calibration / 40% holdout",
    marketDuration: marketDuration.slug,
    hyperliquidCandleInterval: marketDuration.candleInterval,
    entry: `first actionable one-minute observation in [${marketDuration.decisionStartMs / 60_000}m, ${marketDuration.decisionEndMs / 60_000}m)`,
    exit: `final ${marketDuration.candleInterval} Hyperliquid candle close`,
    executionMode,
    roundTripCost,
    fundingPer24h,
    impliedRule: {
      minimumSignalZ: impliedMinimumSignalZ,
      minimumExpectedReturnPct: roundTripCost * impliedCostMultiplier,
      minimumTrendZ: impliedMinimumTrendZ,
      requireTrend: impliedRequireTrend,
      strategyTrials,
    },
    leadLagRule: {
      minimumOneMinuteProbabilityChange: leadLagMinimumProbabilityChange,
      requireTrend: leadLagRequireTrend,
      strategyTrials,
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
  },
  calibration: calibrationSummary,
  holdout: holdoutSummary,
  screening: {
    implied: screeningVerdict(holdoutSummary.implied),
    leadLag: screeningVerdict(holdoutSummary.leadLag),
  },
}, null, 2));

function summarizePeriod(rows: typeof observations) {
  return {
    markets: rows.length,
    baseline: summarizeModel(rows, "baseline"),
    implied: summarizeModel(rows, "implied"),
    leadLag: summarizeModel(rows, "leadLag"),
  };
}

function summarizeModel(rows: typeof observations, key: "baseline" | "implied" | "leadLag") {
  const selected = rows.filter((row) => row[key].selected);
  const returns = selected.map((row) => row[key].returnPct);
  const correct = selected.filter((row) => (
    (row[key].side === "LONG" && row.officialResult === 1)
    || (row[key].side === "SHORT" && row.officialResult === 0)
  ));
  const benchmark = key === "baseline" ? null : summarizeBenchmarks(selected, key);
  return {
    trades: selected.length,
    profitableTrades: returns.filter((value) => value > 0).length,
    afterCostWinRate: returns.length ? returns.filter((value) => value > 0).length / returns.length : null,
    binaryOutcomeAccuracy: selected.length ? correct.length / selected.length : null,
    netReturnPct: sum(returns),
    averageReturnPct: average(returns),
    meanConfidenceInterval95: blockBootstrapMeanConfidenceInterval(returns),
    deflatedSharpeProbability: deflatedSharpeProbability(returns, strategyTrials),
    maxDrawdownPct: maximumDrawdown(returns),
    benchmarkLabel: benchmark?.label ?? null,
    benchmarkReturnPct: benchmark?.returnPct ?? null,
    excessReturnPct: benchmark?.excessReturnPct ?? null,
    excessConfidenceInterval95: benchmark?.confidenceInterval95 ?? null,
  };
}

function screeningVerdict(model: ReturnType<typeof summarizeModel>) {
  const gates = [
    { id: "trades", label: "50 holdout trades", passed: model.trades >= 50 },
    { id: "net", label: "positive after costs", passed: model.netReturnPct > 0 },
    { id: "confidence", label: "95% mean-return lower bound above zero", passed: (model.meanConfidenceInterval95?.[0] ?? 0) > 0 },
    { id: "benchmark", label: "95% benchmark-excess lower bound above zero", passed: (model.excessConfidenceInterval95?.[0] ?? 0) > 0 },
    { id: "selection", label: "deflated Sharpe probability at least 95%", passed: (model.deflatedSharpeProbability ?? 0) >= 0.95 },
    { id: "drawdown", label: "maximum drawdown at or below 5%", passed: model.trades >= 50 && model.maxDrawdownPct <= 0.05 },
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
  const candidates = [
    { label: "Polymarket direction", key: "polymarketDirection" as const },
    { label: "Always long", key: "alwaysLong" as const },
    { label: "Always short", key: "alwaysShort" as const },
  ].map((candidate) => ({
    ...candidate,
    returnPct: sum(comparable.map((row) => row[candidate.key])),
  }));
  const best = [...candidates].sort((left, right) => right.returnPct - left.returnPct)[0];
  const excess = comparable.map((row) => row.model - row[best.key]);
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
  return clamp(Math.sqrt(sum(returns.map((value) => value ** 2)) * (1_440 / returns.length)), 0.005, 0.25);
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
