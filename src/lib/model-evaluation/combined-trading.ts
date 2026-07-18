import { fitMonotonicProbabilityLadder } from "@/src/lib/model-evaluation/probability-ladder";
import { hasExecutableSynchronizedOrderBook } from "@/src/lib/model-evaluation/execution-evidence";
import type { CombinedCandidateDiagnostic, CombinedHoldoutSlice, CombinedStrategyCandidate, EvaluationSample, ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";

const initialCapital = 10_000;
const takerFeePerSide = 0.00045;
const slippagePerSide = 0.0002;
const fundingPer24h = 0.0003;
const minimumValidationTrades = 12;
const walkForwardFolds = 4;
const minimumProfitableFolds = 3;
const minimumDeflatedSharpeProbability = 0.95;
const randomBenchmarkTrials = 200;
// Includes unique rule and threshold combinations explored in earlier model versions.
const cumulativeStrategyTrials = 19;

const strategyCandidates: CombinedStrategyCandidate[] = [
  { id: "no-trade guard", minimumSignalZ: 0, signalRule: "polymarket-only", minimumTrendZ: 0, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "signal z 0.25", minimumSignalZ: 0.25, signalRule: "polymarket-only", minimumTrendZ: 0, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "signal z 0.50", minimumSignalZ: 0.5, signalRule: "polymarket-only", minimumTrendZ: 0, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "hl momentum z 0.25", minimumSignalZ: 0.25, signalRule: "hyperliquid-momentum", minimumTrendZ: 0.1, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "hl momentum z 0.50", minimumSignalZ: 0.5, signalRule: "hyperliquid-momentum", minimumTrendZ: 0.1, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "hl reversion z 0.25", minimumSignalZ: 0.25, signalRule: "hyperliquid-reversion", minimumTrendZ: 0.1, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "hl reversion z 0.50", minimumSignalZ: 0.5, signalRule: "hyperliquid-reversion", minimumTrendZ: 0.1, minimumFunding24h: 0, positionPct: 0.05 },
  { id: "hl funding carry 0.03%", minimumSignalZ: 0.25, signalRule: "hyperliquid-funding-carry", minimumTrendZ: 0, minimumFunding24h: 0.0003, positionPct: 0.05 },
  { id: "hl funding carry 0.06%", minimumSignalZ: 0.25, signalRule: "hyperliquid-funding-carry", minimumTrendZ: 0, minimumFunding24h: 0.0006, positionPct: 0.05 },
  { id: "hl funding momentum 0.03%", minimumSignalZ: 0.25, signalRule: "hyperliquid-funding-momentum", minimumTrendZ: 0, minimumFunding24h: 0.0003, positionPct: 0.05 },
  { id: "hl funding momentum 0.06%", minimumSignalZ: 0.25, signalRule: "hyperliquid-funding-momentum", minimumTrendZ: 0, minimumFunding24h: 0.0006, positionPct: 0.05 },
];

type TradeSignal = {
  eventId: string;
  asset: string;
  entryAt: number;
  exitAt: number;
  entryPrice: number;
  exitPrice: number;
  entryBestBid: number | null;
  entryBestAsk: number | null;
  exitBestBid: number | null;
  exitBestAsk: number | null;
  impliedTarget: number;
  signalZ: number;
  trendZ6h: number | null;
  funding24h: number | null;
  realizedFunding: number | null;
  side: 1 | -1;
};

type CombinedMetrics = ModelEvaluationMetrics["combinedTrading"];
type Simulation = Omit<CombinedMetrics,
  | "selectedStrategy"
  | "selectedFromValidation"
  | "totalEligibleSignals"
  | "validationEligibleSignals"
  | "executionStartedAt"
  | "executionEndedAt"
  | "validationStartedAt"
  | "validationEndedAt"
  | "testStartedAt"
  | "testEndedAt"
  | "closestValidationCandidate"
  | "closestHoldoutAudit"
  | "candidateDiagnostics"
  | "eligibleSignals"
  | "benchmarkReturnPct"
  | "excessReturnPct"
  | "benchmarks"
  | "strategyTrials"
  | "walkForwardFolds"
  | "profitableValidationFolds"
  | "walkForwardChronologyValid"
  | "walkForwardSelections"
  | "minimumRequiredTrades"
> & { tradeReturns: number[] };

export function evaluateCombinedTrading(
  samples: EvaluationSample[],
): ModelEvaluationMetrics["combinedTrading"] {
  const allSignals = buildSignals(samples)
    .sort((left, right) => left.entryAt - right.entryAt || left.eventId.localeCompare(right.eventId));
  const splitIndex = allSignals.length > 1
    ? Math.min(allSignals.length - 1, Math.max(1, Math.floor(allSignals.length * 0.6)))
    : allSignals.length;
  const validationSignals = allSignals.slice(0, splitIndex);
  const validationBoundary = validationSignals.reduce((latest, signal) => Math.max(latest, signal.exitAt), Number.NEGATIVE_INFINITY);
  const testSignals = allSignals.slice(splitIndex).filter((signal) => signal.entryAt >= validationBoundary);
  const walkForward = evaluateWalkForwardSelection(validationSignals);
  const selection = selectStrategy(validationSignals);
  const selectedStrategy = selection.candidate;
  const selectedSignals = selectedStrategy.id === "no-trade guard"
    ? []
    : selectSignalsForCandidate(testSignals, selectedStrategy);
  const strategy = simulate(selectedSignals, selectedStrategy, "signal");
  const benchmarkSignals = selectedStrategy.id === "no-trade guard"
    ? selectNonOverlappingSignals(testSignals, 0)
    : selectedSignals;
  const benchmarks = evaluateBenchmarks(benchmarkSignals, selectedStrategy);
  const closestHoldoutAudit = selection.closestCandidate
    ? auditClosestCandidate(testSignals, selection.closestCandidate.strategy)
    : null;
  const { tradeReturns, ...publicStrategy } = strategy;
  void tradeReturns;

  return {
    selectedStrategy,
    selectedFromValidation: selectedStrategy.id !== "no-trade guard",
    totalEligibleSignals: allSignals.length,
    validationEligibleSignals: selection.validationEligibleSignals,
    executionStartedAt: signalTime(allSignals[0], "entryAt"),
    executionEndedAt: signalTime(allSignals.at(-1), "exitAt"),
    validationStartedAt: signalTime(validationSignals[0], "entryAt"),
    validationEndedAt: signalTime(validationSignals.at(-1), "exitAt"),
    testStartedAt: signalTime(testSignals[0], "entryAt"),
    testEndedAt: signalTime(testSignals.at(-1), "exitAt"),
    closestValidationCandidate: selection.closestCandidate?.strategy ?? null,
    closestHoldoutAudit,
    candidateDiagnostics: selection.diagnostics,
    eligibleSignals: testSignals.length,
    ...publicStrategy,
    benchmarkReturnPct: benchmarks.bestReturnPct,
    excessReturnPct: strategy.netReturnPct - benchmarks.bestReturnPct,
    benchmarks,
    strategyTrials: cumulativeStrategyTrials,
    walkForwardFolds: walkForward.selections.length,
    profitableValidationFolds: walkForward.selections.filter((fold) => fold.netReturnPct > 0).length,
    walkForwardChronologyValid: walkForward.chronologyValid,
    walkForwardSelections: walkForward.selections,
    minimumRequiredTrades: minimumValidationTrades,
  };
}

function evaluateWalkForwardSelection(validationSignals: TradeSignal[]) {
  if (validationSignals.length <= walkForwardFolds) {
    return { chronologyValid: false, selections: [] as CombinedMetrics["walkForwardSelections"] };
  }
  const initialTrainingCount = Math.min(
    validationSignals.length - walkForwardFolds,
    Math.max(minimumValidationTrades, Math.floor(validationSignals.length * 0.4)),
  );
  const evaluationSignals = validationSignals.slice(initialTrainingCount);
  const selections = Array.from({ length: walkForwardFolds }, (_, index) => {
    const start = Math.floor(index * evaluationSignals.length / walkForwardFolds);
    const end = Math.floor((index + 1) * evaluationSignals.length / walkForwardFolds);
    const rawTestSignals = evaluationSignals.slice(start, end);
    const firstTestEntryAt = rawTestSignals[0]?.entryAt ?? Number.POSITIVE_INFINITY;
    const trainingSignals = validationSignals
      .slice(0, initialTrainingCount + start)
      .filter((signal) => signal.exitAt <= firstTestEntryAt);
    const trainingEndedAt = trainingSignals.reduce(
      (latest, signal) => Math.max(latest, signal.exitAt),
      Number.NEGATIVE_INFINITY,
    );
    const foldSignals = rawTestSignals.filter((signal) => signal.entryAt >= trainingEndedAt);
    const selection = selectStrategy(trainingSignals);
    const selectedStrategy = selection.candidate;
    const selectedSignals = selectedStrategy.id === "no-trade guard"
      ? []
      : selectSignalsForCandidate(foldSignals, selectedStrategy);
    const result = simulate(selectedSignals, selectedStrategy, "signal");
    const benchmarkSignals = selectedStrategy.id === "no-trade guard"
      ? selectNonOverlappingSignals(foldSignals, 0)
      : selectedSignals;
    const benchmark = evaluateBenchmarks(benchmarkSignals, selectedStrategy);
    const chronologyValid = trainingSignals.length > 0
      && foldSignals.length > 0
      && Number.isFinite(trainingEndedAt)
      && trainingEndedAt <= Math.min(...foldSignals.map((signal) => signal.entryAt));
    return {
      fold: index + 1,
      trainingStartedAt: signalTime(trainingSignals[0], "entryAt"),
      trainingEndedAt: Number.isFinite(trainingEndedAt) ? new Date(trainingEndedAt).toISOString() : null,
      testStartedAt: signalTime(foldSignals[0], "entryAt"),
      testEndedAt: signalTime(foldSignals.at(-1), "exitAt"),
      trainingSignals: trainingSignals.length,
      testSignals: foldSignals.length,
      selectedStrategy,
      selectedFromPastOnly: chronologyValid,
      trades: result.trades,
      netReturnPct: result.netReturnPct,
      benchmarkReturnPct: benchmark.bestReturnPct,
      excessReturnPct: result.netReturnPct - benchmark.bestReturnPct,
    };
  });
  return {
    chronologyValid: selections.length === walkForwardFolds
      && selections.every((selection) => selection.selectedFromPastOnly),
    selections,
  };
}

function auditClosestCandidate(testSignals: TradeSignal[], candidate: CombinedStrategyCandidate): CombinedMetrics["closestHoldoutAudit"] {
  const signals = selectSignalsForCandidate(testSignals, candidate);
  const result = simulate(signals, candidate, "signal");
  const benchmark = evaluateBenchmarks(signals, candidate);
  return {
    strategy: candidate,
    trades: result.trades,
    wins: result.wins,
    winRate: result.winRate,
    netReturnPct: result.netReturnPct,
    benchmarkReturnPct: benchmark.bestReturnPct,
    excessReturnPct: result.netReturnPct - benchmark.bestReturnPct,
    returnConfidenceInterval95: result.returnConfidenceInterval95,
    statisticallyPositive: result.statisticallyPositive,
    deflatedSharpeProbability: result.deflatedSharpeProbability,
    maxDrawdownPct: result.maxDrawdownPct,
    attribution: {
      byAsset: summarizeHoldoutSlices(signals, candidate, (signal) => ({ key: signal.asset, label: signal.asset })),
      bySide: summarizeHoldoutSlices(signals, candidate, (signal) => {
        const side = resolveStrategySide(signal, candidate.signalRule);
        return side === 1 ? { key: "long", label: "ロング" } : { key: "short", label: "ショート" };
      }),
      byFundingStrength: summarizeHoldoutSlices(signals, candidate, fundingStrengthSlice),
      byConsensus: summarizeHoldoutSlices(signals, candidate, (signal) => (
        resolveStrategySide(signal, candidate.signalRule) === signal.side
          ? { key: "agree", label: "Poly方向と一致" }
          : { key: "disagree", label: "Poly方向と不一致" }
      )),
    },
  };
}

function summarizeHoldoutSlices(
  signals: TradeSignal[],
  candidate: CombinedStrategyCandidate,
  classify: (signal: TradeSignal) => { key: string; label: string },
): CombinedHoldoutSlice[] {
  const groups = new Map<string, { label: string; signals: TradeSignal[] }>();
  for (const signal of signals) {
    const { key, label } = classify(signal);
    const group = groups.get(key) ?? { label, signals: [] };
    group.signals.push(signal);
    groups.set(key, group);
  }
  return Array.from(groups, ([key, group]) => {
    const result = simulate(group.signals, candidate, "signal", { calculateStatistics: false });
    return {
      key,
      label: group.label,
      trades: result.trades,
      wins: result.wins,
      winRate: result.winRate,
      netReturnPct: result.netReturnPct,
      averageNetTradeReturn: result.averageNetTradeReturn,
    };
  }).sort((left, right) => right.trades - left.trades || left.label.localeCompare(right.label));
}

function fundingStrengthSlice(signal: TradeSignal) {
  if (signal.funding24h === null) return { key: "missing", label: "資金調達率なし" };
  const absoluteFunding = Math.abs(signal.funding24h);
  if (absoluteFunding >= 0.0006) return { key: "gte-006", label: "0.06%以上" };
  if (absoluteFunding >= 0.0003) return { key: "003-006", label: "0.03〜0.06%" };
  return { key: "lt-003", label: "0.03%未満" };
}

function signalTime(signal: TradeSignal | undefined, field: "entryAt" | "exitAt") {
  return signal ? new Date(signal[field]).toISOString() : null;
}

function selectStrategy(validationSignals: TradeSignal[]) {
  const allEligible = selectNonOverlappingSignals(validationSignals, 0);
  const evaluations = strategyCandidates.slice(1).map((candidate) => {
    const signals = selectSignalsForCandidate(validationSignals, candidate);
    const result = simulate(signals, candidate, "signal");
    const benchmark = evaluateBenchmarks(signals, candidate);
    const excessReturnPct = result.netReturnPct - benchmark.bestReturnPct;
    const folds = splitChronologically(signals, walkForwardFolds).map((fold) => simulate(fold, candidate, "signal"));
    const profitableFolds = folds.filter((fold) => fold.netReturnPct > 0).length;
    const gates: CombinedCandidateDiagnostic["gates"] = [
      { id: "trades", label: `${minimumValidationTrades}取引以上`, passed: result.trades >= minimumValidationTrades },
      { id: "significance", label: "95%区間がプラス", passed: result.statisticallyPositive },
      { id: "benchmark", label: "単純戦略を上回る", passed: excessReturnPct > 0 },
      { id: "folds", label: `${walkForwardFolds}期間の安定性確認で${minimumProfitableFolds}期間以上プラス`, passed: profitableFolds >= minimumProfitableFolds },
      { id: "selection-bias", label: "試行補正後95%以上", passed: (result.deflatedSharpeProbability ?? 0) >= minimumDeflatedSharpeProbability },
    ];
    const diagnostic: CombinedCandidateDiagnostic = {
      strategy: candidate,
      validationSignals: signals.length,
      trades: result.trades,
      netReturnPct: result.netReturnPct,
      benchmarkReturnPct: benchmark.bestReturnPct,
      excessReturnPct,
      profitableFolds,
      deflatedSharpeProbability: result.deflatedSharpeProbability,
      confidenceInterval95: result.returnConfidenceInterval95,
      passed: gates.every((gate) => gate.passed),
      gates,
    };
    return { candidate, result, excessReturnPct, profitableFolds, diagnostic };
  });

  const viable = evaluations.filter(({ diagnostic }) => diagnostic.passed);
  const selected = viable.sort((left, right) =>
    right.result.netReturnPct - left.result.netReturnPct
    || right.excessReturnPct - left.excessReturnPct
    || right.candidate.minimumSignalZ - left.candidate.minimumSignalZ,
  )[0];
  const closest = [...evaluations].sort((left, right) =>
    right.diagnostic.gates.filter((gate) => gate.passed).length - left.diagnostic.gates.filter((gate) => gate.passed).length
    || right.result.netReturnPct - left.result.netReturnPct
    || right.excessReturnPct - left.excessReturnPct
    || right.result.trades - left.result.trades,
  )[0];

  return {
    candidate: selected?.candidate ?? strategyCandidates[0],
    profitableFolds: selected?.profitableFolds ?? closest?.profitableFolds ?? 0,
    validationEligibleSignals: allEligible.length,
    closestCandidate: selected?.diagnostic ?? closest?.diagnostic ?? null,
    diagnostics: evaluations.map(({ diagnostic }) => diagnostic),
  };
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
    const ladder = fitMonotonicProbabilityLadder(group.flatMap((sample) => {
      if (sample.thresholdKind !== "above" && sample.thresholdKind !== "below") return [];
      const threshold = sample.thresholdKind === "above" ? sample.thresholdLower : sample.thresholdUpper;
      if (typeof threshold !== "number") return [];
      return [{
        id: sample.marketId,
        kind: sample.thresholdKind,
        threshold,
        probability: sample.marketProbability,
        weight: sample.marketProbability * (1 - sample.marketProbability),
      }];
    }));
    const correctedProbability = new Map(ladder.points.map((point) => [point.id, point.correctedProbability]));
    const estimates = group.flatMap((sample) => {
      const probability = correctedProbability.get(sample.marketId);
      if (probability === undefined) return [];
      const estimate = impliedTerminalMedian(sample, volatility, probability);
      if (estimate === null) return [];
      return [{ logTarget: Math.log(estimate), weight: probability * (1 - probability) }];
    });
    if (!estimates.length) return [];

    const totalWeight = estimates.reduce((sum, estimate) => sum + estimate.weight, 0);
    const impliedTarget = Math.exp(estimates.reduce((sum, estimate) => sum + estimate.logTarget * estimate.weight, 0) / totalWeight);
    const signalZ = Math.log(impliedTarget / (base.hyperliquidEntryPrice as number)) / volatility;
    const trendVolatility6h = volatility * Math.sqrt(6 / 24);
    const trendZ6h = typeof base.hyperliquidMomentum6h === "number" && Number.isFinite(base.hyperliquidMomentum6h)
      ? base.hyperliquidMomentum6h / Math.max(0.001, trendVolatility6h)
      : null;
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
      entryBestBid: finitePositive(base.hyperliquidEntryBestBid),
      entryBestAsk: finitePositive(base.hyperliquidEntryBestAsk),
      exitBestBid: finitePositive(base.hyperliquidExitBestBid),
      exitBestAsk: finitePositive(base.hyperliquidExitBestAsk),
      impliedTarget,
      signalZ,
      trendZ6h,
      funding24h: typeof base.hyperliquidFunding24h === "number" && Number.isFinite(base.hyperliquidFunding24h)
        ? base.hyperliquidFunding24h
        : null,
      realizedFunding: typeof base.hyperliquidFundingDuringTrade === "number" && Number.isFinite(base.hyperliquidFundingDuringTrade)
        ? base.hyperliquidFundingDuringTrade
        : null,
      side: signalZ >= 0 ? 1 as const : -1 as const,
    }];
  });

  const byEvent = new Map<string, TradeSignal[]>();
  for (const signal of assetSignals) byEvent.set(signal.eventId, [...(byEvent.get(signal.eventId) ?? []), signal]);
  return Array.from(byEvent.values(), (signals) => [...signals].sort((a, b) => Math.abs(b.signalZ) - Math.abs(a.signalZ))[0]);
}

function selectSignalsForCandidate(signals: TradeSignal[], candidate: CombinedStrategyCandidate) {
  const ruleEligible = candidate.signalRule === "trend-confirmed"
    ? signals.filter((signal) => signal.trendZ6h !== null && signal.side * signal.trendZ6h >= candidate.minimumTrendZ)
    : candidate.signalRule === "hyperliquid-momentum" || candidate.signalRule === "hyperliquid-reversion"
      ? signals.filter((signal) => signal.trendZ6h !== null && Math.abs(signal.trendZ6h) >= candidate.minimumTrendZ)
    : isFundingSignalRule(candidate.signalRule)
      ? signals.filter((signal) => (
          signal.funding24h !== null
          && Math.abs(signal.funding24h) >= candidate.minimumFunding24h
          && (candidate.signalRule !== "polymarket-funding-consensus" || resolveStrategySide(signal, candidate.signalRule) === signal.side)
        ))
      : signals;
  return selectNonOverlappingSignals(ruleEligible, candidate.minimumSignalZ);
}

function selectNonOverlappingSignals(signals: TradeSignal[], minimumSignalZ: number) {
  if (!Number.isFinite(minimumSignalZ)) return [];
  const ordered = signals
    .filter((signal) => Math.abs(signal.signalZ) >= minimumSignalZ)
    .sort((left, right) => left.entryAt - right.entryAt || Math.abs(right.signalZ) - Math.abs(left.signalZ));
  const selected: TradeSignal[] = [];
  const availableAtByAsset = new Map<string, number>();
  for (const signal of ordered) {
    if (signal.entryAt < (availableAtByAsset.get(signal.asset) ?? Number.NEGATIVE_INFINITY)) continue;
    selected.push(signal);
    availableAtByAsset.set(signal.asset, signal.exitAt);
  }
  return selected;
}

function evaluateBenchmarks(signals: TradeSignal[], candidate: CombinedStrategyCandidate): CombinedMetrics["benchmarks"] {
  const periods = selectNonOverlappingSignals(signals, 0);
  const simulationOptions = { calculateStatistics: false } as const;
  const randomReturns = Array.from({ length: randomBenchmarkTrials }, (_, index) => (
    simulate(periods, candidate, "random", { ...simulationOptions, randomSeed: index + 1 }).netReturnPct
  )).sort((left, right) => left - right);
  const results = [
    { label: "常時ロング" as const, value: simulate(periods, candidate, "long", simulationOptions).netReturnPct },
    { label: "常時ショート" as const, value: simulate(periods, candidate, "short", simulationOptions).netReturnPct },
    { label: "Polymarket方向" as const, value: simulate(periods, candidate, "polymarket", simulationOptions).netReturnPct },
    { label: "ランダム中央値" as const, value: median(randomReturns) },
  ];
  const best = [...results].sort((left, right) => right.value - left.value)[0];
  return {
    alwaysLongReturnPct: results[0].value,
    alwaysShortReturnPct: results[1].value,
    polymarketDirectionReturnPct: results[2].value,
    randomMedianReturnPct: results[3].value,
    randomTrials: randomBenchmarkTrials,
    bestReturnPct: best.value,
    bestLabel: best.label,
  };
}

function simulate(
  signals: TradeSignal[],
  candidate: CombinedStrategyCandidate,
  direction: "signal" | "polymarket" | "long" | "short" | "random",
  options: { calculateStatistics?: boolean; randomSeed?: number } = {},
): Simulation {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let wins = 0;
  let directionallyCorrect = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let totalFees = 0;
  let totalSpread = 0;
  let totalSlippage = 0;
  let totalFunding = 0;
  const random = createSeededRandom(options.randomSeed ?? 1);
  const netTradeReturns: number[] = [];
  const openTrades: Array<{ exitAt: number; notional: number; grossReturn: number; netTradeReturn: number }> = [];
  const settleThrough = (timestamp: number) => {
    const closing = openTrades.filter((trade) => trade.exitAt <= timestamp).sort((left, right) => left.exitAt - right.exitAt);
    if (!closing.length) return;
    const closingSet = new Set(closing);
    for (let index = openTrades.length - 1; index >= 0; index -= 1) {
      if (closingSet.has(openTrades[index])) openTrades.splice(index, 1);
    }
    const byExit = new Map<number, typeof closing>();
    for (const trade of closing) byExit.set(trade.exitAt, [...(byExit.get(trade.exitAt) ?? []), trade]);
    for (const batch of Array.from(byExit.entries()).sort(([left], [right]) => left - right).map(([, trades]) => trades)) {
      capital += batch.reduce((sum, trade) => sum + trade.notional * trade.netTradeReturn, 0);
      for (const trade of batch) {
        netTradeReturns.push(trade.netTradeReturn);
        if (trade.netTradeReturn > 0) wins += 1;
        if (trade.grossReturn > 0) directionallyCorrect += 1;
      }
      peak = Math.max(peak, capital);
      maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - capital) / peak : 0);
    }
  };

  [...signals].sort((left, right) => left.entryAt - right.entryAt || left.exitAt - right.exitAt).forEach((signal) => {
    settleThrough(signal.entryAt);
    const strategySide = resolveStrategySide(signal, candidate.signalRule);
    const side = direction === "long"
      ? 1
      : direction === "short"
        ? -1
        : direction === "polymarket"
          ? signal.side
          : direction === "random"
            ? random() < 0.5 ? -1 : 1
            : strategySide;
    const holdingDays = Math.max(0, signal.exitAt - signal.entryAt) / (24 * 60 * 60 * 1_000);
    const bookReturn = calculateDirectionalBookReturn(signal, side);
    const grossReturn = bookReturn.grossReturn;
    const feeRate = takerFeePerSide * 2;
    const slippageRate = slippagePerSide * 2;
    const fundingRate = signal.realizedFunding === null
      ? fundingPer24h * holdingDays
      : side * signal.realizedFunding;
    const netTradeReturn = grossReturn - feeRate - slippageRate - fundingRate;
    const notional = capital * candidate.positionPct;

    totalFees += notional * feeRate;
    totalSpread += notional * bookReturn.spreadRate;
    totalSlippage += notional * slippageRate;
    totalFunding += notional * fundingRate;
    if (side === 1) longTrades += 1;
    else shortTrades += 1;
    openTrades.push({ exitAt: signal.exitAt, notional, grossReturn, netTradeReturn });
  });
  settleThrough(Number.POSITIVE_INFINITY);

  const calculateStatistics = options.calculateStatistics !== false;
  const returnConfidenceInterval95 = calculateStatistics ? blockBootstrapMeanConfidenceInterval(netTradeReturns) : null;
  const deflatedSharpe = calculateStatistics ? deflatedSharpeProbability(netTradeReturns, cumulativeStrategyTrials) : null;
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
    statisticallyPositive: signals.length >= minimumValidationTrades && returnConfidenceInterval95 !== null && returnConfidenceInterval95[0] > 0,
    deflatedSharpeProbability: deflatedSharpe,
    maxDrawdownPct,
    totalFees,
    totalSpread,
    totalSlippage,
    totalFunding,
    assumedTakerFeePerSide: takerFeePerSide,
    assumedSlippagePerSide: slippagePerSide,
    assumedFundingPer24h: fundingPer24h,
    tradeReturns: netTradeReturns,
  };
}

export function calculateDirectionalBookReturn(
  prices: {
    entryPrice: number;
    exitPrice: number;
    entryBestBid?: number | null;
    entryBestAsk?: number | null;
    exitBestBid?: number | null;
    exitBestAsk?: number | null;
  },
  side: 1 | -1,
) {
  const midGrossReturn = side * (prices.exitPrice / prices.entryPrice - 1);
  const entryPrice = side === 1 ? finitePositive(prices.entryBestAsk) : finitePositive(prices.entryBestBid);
  const exitPrice = side === 1 ? finitePositive(prices.exitBestBid) : finitePositive(prices.exitBestAsk);
  if (entryPrice === null || exitPrice === null) {
    return { grossReturn: midGrossReturn, midGrossReturn, spreadRate: 0, usedOrderBook: false };
  }
  const grossReturn = side * (exitPrice / entryPrice - 1);
  return {
    grossReturn,
    midGrossReturn,
    spreadRate: Math.max(0, midGrossReturn - grossReturn),
    usedOrderBook: true,
  };
}

function resolveStrategySide(signal: TradeSignal, rule: CombinedStrategyCandidate["signalRule"]): 1 | -1 {
  if (rule === "contrarian") return -signal.side as 1 | -1;
  if (rule === "hyperliquid-momentum" || rule === "hyperliquid-reversion") {
    const trendSide = (signal.trendZ6h ?? 0) >= 0 ? 1 as const : -1 as const;
    return rule === "hyperliquid-reversion" ? -trendSide as 1 | -1 : trendSide;
  }
  if (isFundingSignalRule(rule)) {
    const fundingSide = (signal.funding24h ?? 0) >= 0 ? 1 as const : -1 as const;
    return rule === "hyperliquid-funding-momentum" ? fundingSide : -fundingSide as 1 | -1;
  }
  return signal.side;
}

function isFundingSignalRule(rule: CombinedStrategyCandidate["signalRule"]) {
  return rule === "hyperliquid-funding-carry"
    || rule === "hyperliquid-funding-momentum"
    || rule === "polymarket-funding-consensus";
}

function impliedTerminalMedian(sample: EvaluationSample, volatility: number, probability = sample.marketProbability) {
  return impliedTerminalMedianForCondition(
    sample.thresholdKind,
    sample.thresholdLower,
    sample.thresholdUpper,
    probability,
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
  return hasExecutableSynchronizedOrderBook(sample)
    && typeof sample.realizedVolatility24h === "number"
    && Number.isFinite(sample.realizedVolatility24h)
    && sample.realizedVolatility24h > 0;
}

function finitePositive(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function deflatedSharpeProbability(returns: number[], strategyTrials: number) {
  if (returns.length < minimumValidationTrades) return null;
  const mean = average(returns);
  const standardDeviation = sampleStandardDeviation(returns);
  if (standardDeviation < 1e-12) return mean > 0 ? 1 : 0;
  const sharpe = mean / standardDeviation;
  const skewness = average(returns.map((value) => ((value - mean) / standardDeviation) ** 3));
  const kurtosis = average(returns.map((value) => ((value - mean) / standardDeviation) ** 4));
  const trials = Math.max(2, strategyTrials);
  const eulerGamma = 0.5772156649;
  const expectedMaximumZ = (1 - eulerGamma) * inverseNormalCdf(1 - 1 / trials)
    + eulerGamma * inverseNormalCdf(1 - 1 / (trials * Math.E));
  const expectedMaximumSharpe = expectedMaximumZ / Math.sqrt(Math.max(1, returns.length - 1));
  const denominatorSquared = Math.max(1e-12, 1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2);
  const statistic = (sharpe - expectedMaximumSharpe) * Math.sqrt(returns.length - 1) / Math.sqrt(denominatorSquared);
  return clamp(normalCdf(statistic), 0, 1);
}

export function blockBootstrapMeanConfidenceInterval(values: number[]): [number, number] | null {
  if (values.length < 2) return null;
  if (values.length < 5) return meanConfidenceInterval(values);
  const blockLength = Math.max(2, Math.ceil(Math.sqrt(values.length)));
  const means: number[] = [];
  let seed = (values.length * 2_654_435_761) >>> 0;
  const random = () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const sample: number[] = [];
    while (sample.length < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < blockLength && sample.length < values.length; offset += 1) {
        sample.push(values[(start + offset) % values.length]);
      }
    }
    means.push(average(sample));
  }
  means.sort((left, right) => left - right);
  return [means[Math.floor(means.length * 0.025)], means[Math.floor(means.length * 0.975)]];
}

function meanConfidenceInterval(values: number[]): [number, number] {
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = criticalValue95(values.length - 1) * Math.sqrt(variance / values.length);
  return [mean - margin, mean + margin];
}

function splitChronologically<T>(values: T[], folds: number) {
  if (!values.length) return Array.from({ length: folds }, () => [] as T[]);
  return Array.from({ length: folds }, (_, index) => {
    const start = Math.floor(index * values.length / folds);
    const end = Math.floor((index + 1) * values.length / folds);
    return values.slice(start, end);
  });
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

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function criticalValue95(degreesOfFreedom: number) {
  if (degreesOfFreedom <= 4) return 2.776;
  if (degreesOfFreedom <= 9) return 2.262;
  if (degreesOfFreedom <= 14) return 2.145;
  if (degreesOfFreedom <= 19) return 2.093;
  if (degreesOfFreedom <= 29) return 2.045;
  return 1.96;
}

function sampleStandardDeviation(values: number[]) {
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function createSeededRandom(initialSeed: number) {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
