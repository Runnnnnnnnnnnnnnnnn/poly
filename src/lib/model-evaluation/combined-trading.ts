import type { CombinedStrategyCandidate, EvaluationSample, ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";

const initialCapital = 10_000;
const takerFeePerSide = 0.00045;
const slippagePerSide = 0.0002;
const fundingPer24h = 0.0003;
const minimumValidationTrades = 12;

const strategyCandidates: CombinedStrategyCandidate[] = [
  { id: "no-trade guard", minimumSignalZ: 0, positionPct: 0.2 },
  { id: "signal z 0.10", minimumSignalZ: 0.1, positionPct: 0.2 },
  { id: "signal z 0.25", minimumSignalZ: 0.25, positionPct: 0.2 },
  { id: "signal z 0.50", minimumSignalZ: 0.5, positionPct: 0.2 },
  { id: "signal z 0.75", minimumSignalZ: 0.75, positionPct: 0.2 },
  { id: "signal z 1.00", minimumSignalZ: 1, positionPct: 0.2 },
];

type TradeSignal = {
  eventId: string;
  asset: string;
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  impliedTarget: number;
  signalZ: number;
  side: 1 | -1;
};

type Simulation = Omit<ModelEvaluationMetrics["combinedTrading"], "selectedStrategy" | "eligibleSignals" | "benchmarkReturnPct" | "excessReturnPct">;

export function evaluateCombinedTrading(
  validationSamples: EvaluationSample[],
  testSamples: EvaluationSample[],
): ModelEvaluationMetrics["combinedTrading"] {
  const validationSignals = buildSignals(validationSamples);
  const selectedStrategy = selectStrategy(validationSignals);
  const testSignals = buildSignals(testSamples);
  const selectedSignals = selectedStrategy.id === "no-trade guard"
    ? []
    : selectNonOverlappingSignals(testSignals, selectedStrategy.minimumSignalZ);
  const strategy = simulate(selectedSignals, selectedStrategy, "signal");
  const benchmark = simulate(selectedSignals, selectedStrategy, "long");

  return {
    selectedStrategy,
    eligibleSignals: testSignals.length,
    ...strategy,
    benchmarkReturnPct: benchmark.netReturnPct,
    excessReturnPct: strategy.netReturnPct - benchmark.netReturnPct,
  };
}

function selectStrategy(validationSignals: TradeSignal[]) {
  const viable = strategyCandidates.slice(1).flatMap((candidate) => {
    const signals = selectNonOverlappingSignals(validationSignals, candidate.minimumSignalZ);
    const result = simulate(signals, candidate, "signal");
    const benchmark = simulate(signals, candidate, "long");
    const excessReturnPct = result.netReturnPct - benchmark.netReturnPct;
    if (result.trades < minimumValidationTrades || !result.statisticallyPositive || excessReturnPct <= 0) return [];
    return [{ candidate, result, excessReturnPct }];
  });

  return viable.sort((left, right) =>
    right.result.netReturnPct - left.result.netReturnPct
    || right.excessReturnPct - left.excessReturnPct
    || right.candidate.minimumSignalZ - left.candidate.minimumSignalZ,
  )[0]?.candidate ?? strategyCandidates[0];
}

function buildSignals(samples: EvaluationSample[]) {
  const groups = new Map<string, EvaluationSample[]>();
  for (const sample of samples) {
    const key = `${sample.eventId}:${sample.asset}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  const assetSignals = Array.from(groups.values()).flatMap((group) => {
    const base = group.find(hasExecutionData);
    if (!base) return [];
    const volatility = clamp(base.realizedVolatility24h as number, 0.002, 1);
    const estimates = group.flatMap((sample) => {
      const estimate = impliedTerminalMedian(sample, volatility);
      if (estimate === null) return [];
      const probability = clamp(sample.marketProbability, 0.01, 0.99);
      return [{ logTarget: Math.log(estimate), weight: probability * (1 - probability) }];
    });
    if (!estimates.length) return [];

    const totalWeight = estimates.reduce((sum, estimate) => sum + estimate.weight, 0);
    const impliedTarget = Math.exp(estimates.reduce((sum, estimate) => sum + estimate.logTarget * estimate.weight, 0) / totalWeight);
    const signalZ = Math.log(impliedTarget / (base.hyperliquidEntryPrice as number)) / volatility;
    const entryAt = new Date(base.hyperliquidEntryAt as string).getTime();
    const exitAt = new Date(base.hyperliquidExitAt as string).getTime();
    if (!Number.isFinite(signalZ) || !Number.isFinite(entryAt) || !Number.isFinite(exitAt) || exitAt <= entryAt) return [];

    return [{
      eventId: base.eventId,
      asset: base.asset,
      entryAt,
      exitAt,
      entryPrice: base.hyperliquidEntryPrice as number,
      exitPrice: base.hyperliquidExitPrice as number,
      impliedTarget,
      signalZ,
      side: signalZ >= 0 ? 1 as const : -1 as const,
    }];
  });

  const byEvent = new Map<string, TradeSignal[]>();
  for (const signal of assetSignals) byEvent.set(signal.eventId, [...(byEvent.get(signal.eventId) ?? []), signal]);
  return Array.from(byEvent.values(), (signals) => [...signals].sort((a, b) => Math.abs(b.signalZ) - Math.abs(a.signalZ))[0]);
}

function selectNonOverlappingSignals(signals: TradeSignal[], minimumSignalZ: number) {
  if (!Number.isFinite(minimumSignalZ)) return [];
  const ordered = signals
    .filter((signal) => Math.abs(signal.signalZ) >= minimumSignalZ)
    .sort((left, right) => left.entryAt - right.entryAt || Math.abs(right.signalZ) - Math.abs(left.signalZ));
  const selected: TradeSignal[] = [];
  let availableAt = Number.NEGATIVE_INFINITY;
  for (const signal of ordered) {
    if (signal.entryAt < availableAt) continue;
    selected.push(signal);
    availableAt = signal.exitAt;
  }
  return selected;
}

function simulate(signals: TradeSignal[], candidate: CombinedStrategyCandidate, direction: "signal" | "long"): Simulation {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let wins = 0;
  let directionallyCorrect = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let totalFees = 0;
  let totalSlippage = 0;
  let totalFunding = 0;
  const netTradeReturns: number[] = [];

  for (const signal of signals) {
    const side = direction === "long" ? 1 : signal.side;
    const holdingDays = Math.max(0, signal.exitAt - signal.entryAt) / (24 * 60 * 60 * 1_000);
    const grossReturn = side * (signal.exitPrice / signal.entryPrice - 1);
    const feeRate = takerFeePerSide * 2;
    const slippageRate = slippagePerSide * 2;
    const fundingRate = fundingPer24h * holdingDays;
    const netTradeReturn = grossReturn - feeRate - slippageRate - fundingRate;
    const notional = capital * candidate.positionPct;

    capital += notional * netTradeReturn;
    totalFees += notional * feeRate;
    totalSlippage += notional * slippageRate;
    totalFunding += notional * fundingRate;
    netTradeReturns.push(netTradeReturn);
    if (netTradeReturn > 0) wins += 1;
    if (grossReturn > 0) directionallyCorrect += 1;
    if (side === 1) longTrades += 1;
    else shortTrades += 1;
    peak = Math.max(peak, capital);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - capital) / peak : 0);
  }

  const returnConfidenceInterval95 = netTradeReturns.length ? meanConfidenceInterval(netTradeReturns) : null;
  return {
    initialCapital,
    endingCapital: capital,
    netReturnPct: capital / initialCapital - 1,
    trades: signals.length,
    longTrades,
    shortTrades,
    wins,
    winRate: signals.length ? wins / signals.length : null,
    directionalAccuracy: signals.length ? directionallyCorrect / signals.length : null,
    averageNetTradeReturn: netTradeReturns.length ? average(netTradeReturns) : null,
    returnConfidenceInterval95,
    statisticallyPositive: returnConfidenceInterval95 !== null && returnConfidenceInterval95[0] > 0,
    maxDrawdownPct,
    totalFees,
    totalSlippage,
    totalFunding,
    assumedTakerFeePerSide: takerFeePerSide,
    assumedSlippagePerSide: slippagePerSide,
    assumedFundingPer24h: fundingPer24h,
  };
}

function impliedTerminalMedian(sample: EvaluationSample, volatility: number) {
  return impliedTerminalMedianForCondition(
    sample.thresholdKind,
    sample.thresholdLower,
    sample.thresholdUpper,
    sample.marketProbability,
    volatility,
  );
}

export function impliedTerminalMedianForCondition(
  kind: EvaluationSample["thresholdKind"],
  lower: number | null | undefined,
  upper: number | null | undefined,
  marketProbability: number,
  volatility: number,
) {
  if (kind !== "above" && kind !== "below") return null;
  const threshold = kind === "above" ? lower : upper;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) return null;
  const probabilityBelow = kind === "above" ? 1 - marketProbability : marketProbability;
  const quantile = inverseNormalCdf(clamp(probabilityBelow, 0.01, 0.99));
  return threshold / Math.exp(volatility * quantile);
}

function hasExecutionData(sample: EvaluationSample) {
  return typeof sample.realizedVolatility24h === "number"
    && Number.isFinite(sample.realizedVolatility24h)
    && typeof sample.hyperliquidEntryPrice === "number"
    && Number.isFinite(sample.hyperliquidEntryPrice)
    && sample.hyperliquidEntryPrice > 0
    && typeof sample.hyperliquidExitPrice === "number"
    && Number.isFinite(sample.hyperliquidExitPrice)
    && sample.hyperliquidExitPrice > 0
    && typeof sample.hyperliquidEntryAt === "string"
    && typeof sample.hyperliquidExitAt === "string";
}

// Peter J. Acklam's rational approximation for the inverse normal CDF.
function inverseNormalCdf(probability: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function meanConfidenceInterval(values: number[]): [number, number] {
  const mean = average(values);
  if (values.length < 2) return [mean, mean];
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = criticalValue95(values.length - 1) * Math.sqrt(variance / values.length);
  return [mean - margin, mean + margin];
}

function criticalValue95(degreesOfFreedom: number) {
  if (degreesOfFreedom <= 4) return 2.776;
  if (degreesOfFreedom <= 9) return 2.262;
  if (degreesOfFreedom <= 14) return 2.145;
  if (degreesOfFreedom <= 19) return 2.093;
  if (degreesOfFreedom <= 29) return 2.045;
  return 1.96;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
