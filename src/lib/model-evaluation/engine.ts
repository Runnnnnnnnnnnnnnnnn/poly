import { createHash } from "node:crypto";

import { evaluateCombinedTrading } from "@/src/lib/model-evaluation/combined-trading";
import { fitMonotonicProbabilityLadder } from "@/src/lib/model-evaluation/probability-ladder";
import type { EvaluationSample, ModelCandidate, ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";

export const MODEL_VERSION = "Polymarket x Hyperliquid Signal v18";
export const HORIZON_HOURS = 24;
export const MIN_TRAIN_EVENTS = 20;
export const MIN_HOLDOUT_EVENTS = 15;
const minimumCombinedTrades = 12;

const candidates: ModelCandidate[] = [
  { id: "market guard", kind: "market", structuralWeight: 0, regularization: 0 },
  { id: "price structure 10%", kind: "logit-pool", structuralWeight: 0.1, regularization: 0 },
  { id: "price structure 25%", kind: "logit-pool", structuralWeight: 0.25, regularization: 0 },
  { id: "price structure 40%", kind: "logit-pool", structuralWeight: 0.4, regularization: 0 },
  { id: "ridge pool 0.01", kind: "ridge-logit-pool", structuralWeight: 0, regularization: 0.01 },
  { id: "ridge pool 0.05", kind: "ridge-logit-pool", structuralWeight: 0, regularization: 0.05 },
  { id: "ridge pool 0.20", kind: "ridge-logit-pool", structuralWeight: 0, regularization: 0.2 },
];

const initialCapital = 10_000;
const maxPositionPct = 0.05;
const halfSpread = 0.01;
const slippage = 0.005;
const entryEdge = 0.03;
const takerFeeRate = 0.07;

export function evaluateChronologicalModel(input: EvaluationSample[], options: { horizonHours?: number } = {}): ModelEvaluationMetrics {
  const horizonHours = options.horizonHours ?? HORIZON_HOURS;
  const samples = [...input].sort((a, b) => new Date(a.endAt).getTime() - new Date(b.endAt).getTime() || a.marketId.localeCompare(b.marketId));
  const events = groupByEvent(samples);
  if (events.length < MIN_TRAIN_EVENTS + 10) throw new Error(`at least ${MIN_TRAIN_EVENTS + 10} fixed-horizon events are required`);

  const trainEnd = Math.max(MIN_TRAIN_EVENTS, Math.floor(events.length * 0.6));
  const validationEnd = Math.max(trainEnd + 5, Math.floor(events.length * 0.8));
  const trainEvents = events.slice(0, trainEnd);
  const validationEvents = events.slice(trainEnd, validationEnd);
  const testEvents = events.slice(validationEnd);
  if (testEvents.length < 5) throw new Error("at least 5 chronological holdout events are required");
  const train = trainEvents.flatMap((event) => event.samples);
  const validation = validationEvents.flatMap((event) => event.samples);
  const test = testEvents.flatMap((event) => event.samples);

  const candidateEvaluations = candidates.map((candidate) => evaluateCandidate(candidate, train, validationEvents));
  const selectedDefinition = candidateEvaluations
    .filter(({ candidate, confidenceInterval95 }) => candidate.kind === "market" || confidenceInterval95[0] > 0)
    .sort((a, b) => a.score - b.score || a.candidate.id.localeCompare(b.candidate.id))[0].candidate;

  const prior = [...train, ...validation];
  const selectedCandidate = fitCandidate(selectedDefinition, prior);
  const predictions = test.map((sample) => ({
    sample,
    modelProbability: predictProbability(sample, selectedCandidate),
  }));
  const eventScores = testEvents.map((event) => {
    const eventPredictions = predictions.filter(({ sample }) => sample.eventId === event.id);
    const modelLoss = average(eventPredictions.map(({ sample, modelProbability }) => (modelProbability - sample.outcome) ** 2));
    const marketLoss = average(eventPredictions.map(({ sample }) => (sample.marketProbability - sample.outcome) ** 2));
    return { eventId: event.id, modelLoss, marketLoss, predictions: eventPredictions };
  });
  const modelBrierScore = average(eventScores.map((event) => event.modelLoss));
  const marketBrierScore = average(eventScores.map((event) => event.marketLoss));
  const improvements = eventScores.map((event) => event.marketLoss - event.modelLoss);
  const brierSkill = marketBrierScore - modelBrierScore;
  const relativeImprovement = marketBrierScore > 0 ? brierSkill / marketBrierScore : 0;
  const confidenceInterval95 = meanConfidenceInterval(improvements);
  const trading = simulateTrading(eventScores.map((event) => event.predictions));
  const combinedTrading = evaluateCombinedTrading(samples);
  const assets = samples.reduce<Record<string, number>>((counts, sample) => ({ ...counts, [sample.asset]: (counts[sample.asset] ?? 0) + 1 }), {});
  const structuralFeatureMarkets = samples.filter(hasStructuralProbability).length;
  const structuralFeatureCoverage = samples.length ? structuralFeatureMarkets / samples.length : 0;
  const executionFeatureMarkets = samples.filter(hasExecutionData).length;
  const executionFeatureCoverage = samples.length ? executionFeatureMarkets / samples.length : 0;
  const testExecutionFeatureMarkets = test.filter(hasExecutionData).length;
  const testExecutionFeatureCoverage = test.length ? testExecutionFeatureMarkets / test.length : 0;
  const synchronizedExecutionMarkets = samples.filter(hasSynchronizedExecutionData).length;
  const synchronizedExecutionCoverage = samples.length ? synchronizedExecutionMarkets / samples.length : 0;
  const testSynchronizedExecutionMarkets = test.filter(hasSynchronizedExecutionData).length;
  const testSynchronizedExecutionCoverage = test.length ? testSynchronizedExecutionMarkets / test.length : 0;
  const fundingFeatureMarkets = samples.filter(hasFundingFeature).length;
  const fundingFeatureCoverage = samples.length ? fundingFeatureMarkets / samples.length : 0;
  const testFundingFeatureMarkets = test.filter(hasFundingFeature).length;
  const testFundingFeatureCoverage = test.length ? testFundingFeatureMarkets / test.length : 0;
  const fundingCostMarkets = samples.filter(hasFundingCost).length;
  const fundingCostCoverage = samples.length ? fundingCostMarkets / samples.length : 0;
  const testFundingCostMarkets = test.filter(hasFundingCost).length;
  const testFundingCostCoverage = test.length ? testFundingCostMarkets / test.length : 0;
  const observationLags = samples.flatMap((sample) => typeof sample.observationLagMinutes === "number" ? [sample.observationLagMinutes] : []);
  const entryLags = samples.flatMap((sample) => typeof sample.hyperliquidEntryLagMinutes === "number" ? [sample.hyperliquidEntryLagMinutes] : []);
  const exitLeads = samples.flatMap((sample) => typeof sample.hyperliquidExitLeadMinutes === "number" ? [sample.hyperliquidExitLeadMinutes] : []);
  const executionTimingErrors = samples.flatMap((sample) => {
    const values = [sample.hyperliquidEntryLagMinutes, sample.hyperliquidExitLeadMinutes]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return values.length ? [Math.max(...values)] : [];
  });
  const ladder = probabilityLadderStats(samples);
  const maximumExecutionTimingErrorMinutes = executionTimingErrors.length ? Math.max(...executionTimingErrors) : null;
  const statisticallyPositive = confidenceInterval95[0] > 0;
  const gates = [
    {
      id: "chronology",
      label: "過去データだけで取引ルールを再選択する4期間検証",
      passed: combinedTrading.walkForwardChronologyValid && combinedTrading.walkForwardFolds >= 4,
    },
    {
      id: "horizon",
      label: `全市場を決着${horizonHours}時間前で統一`,
      passed: samples.every((sample) => sample.horizonHours === horizonHours),
    },
    {
      id: "same-holdout",
      label: "未使用期間の同期板価格で売買検証",
      passed: testSynchronizedExecutionCoverage >= 0.9 && combinedTrading.eligibleSignals >= MIN_HOLDOUT_EVENTS,
    },
    { id: "features", label: "最終テストの売買価格を90%以上取得", passed: testExecutionFeatureCoverage >= 0.9 },
    { id: "synchronized-prices", label: "最終テストの1分同期板価格を90%以上取得", passed: testSynchronizedExecutionCoverage >= 0.9 },
    { id: "timing", label: "売買時刻の誤差を5分以内に制限", passed: maximumExecutionTimingErrorMinutes !== null && maximumExecutionTimingErrorMinutes <= 5 },
    { id: "ladder", label: "価格帯の確率矛盾を単調補正", passed: ladder.events > 0 },
    {
      id: "costs",
      label: "同期板・手数料・滑り・実期間の資金調達を反映",
      passed: combinedTrading.trades >= minimumCombinedTrades
        && testSynchronizedExecutionCoverage >= 0.9
        && testFundingCostCoverage >= 0.9,
    },
    { id: "funding", label: "最終テストの資金調達率を90%以上取得", passed: testFundingFeatureCoverage >= 0.9 && testFundingCostCoverage >= 0.9 },
    { id: "sample", label: `売買可能な最終テスト${MIN_HOLDOUT_EVENTS}イベント以上`, passed: combinedTrading.eligibleSignals >= MIN_HOLDOUT_EVENTS },
    { id: "trades", label: `最終テスト${minimumCombinedTrades}取引以上`, passed: combinedTrading.trades >= minimumCombinedTrades },
    {
      id: "benchmark",
      label: "採用戦略が最終テストで単純戦略を上回る",
      passed: combinedTrading.trades >= minimumCombinedTrades && combinedTrading.excessReturnPct > 0,
    },
    {
      id: "closest-holdout",
      label: "最有力候補が未使用期間でプラスかつ単純戦略を上回る",
      passed: Boolean(
        combinedTrading.closestHoldoutAudit
        && combinedTrading.closestHoldoutAudit.trades >= minimumCombinedTrades
        && combinedTrading.closestHoldoutAudit.netReturnPct > 0
        && combinedTrading.closestHoldoutAudit.excessReturnPct > 0
      ),
    },
    { id: "significance", label: "ブロック再標本化95%区間がプラス", passed: combinedTrading.statisticallyPositive },
    { id: "selection-bias", label: "試行回数補正後も95%以上", passed: (combinedTrading.deflatedSharpeProbability ?? 0) >= 0.95 },
  ];
  const validationUnderperformed = combinedTrading.validationEligibleSignals >= 50
    && combinedTrading.candidateDiagnostics.length > 0
    && combinedTrading.candidateDiagnostics.every((candidate) => candidate.excessReturnPct <= 0);
  const closestHoldoutUnderperformed = Boolean(
    combinedTrading.closestHoldoutAudit
    && combinedTrading.closestHoldoutAudit.trades >= minimumCombinedTrades
    && (
      combinedTrading.closestHoldoutAudit.netReturnPct <= 0
      || combinedTrading.closestHoldoutAudit.excessReturnPct <= 0
    )
  );
  const qualityStatus = combinedTrading.selectedStrategy.id === "no-trade guard"
    ? validationUnderperformed || closestHoldoutUnderperformed ? "underperforming" : "inconclusive"
    : combinedTrading.netReturnPct < 0 || combinedTrading.excessReturnPct <= 0
      ? "underperforming"
      : testEvents.length >= MIN_HOLDOUT_EVENTS
        && combinedTrading.trades >= minimumCombinedTrades
        && testSynchronizedExecutionCoverage >= 0.9
        && testFundingFeatureCoverage >= 0.9
        && testFundingCostCoverage >= 0.9
        && combinedTrading.statisticallyPositive
        && (combinedTrading.deflatedSharpeProbability ?? 0) >= 0.95
      ? "promising"
      : "inconclusive";

  return {
    methodology: "walk-forward-holdout",
    horizonHours,
    modelVersion: MODEL_VERSION,
    selectedCandidate,
    dataset: {
      hash: createDatasetHash(samples),
      totalEvents: events.length,
      trainEvents: trainEvents.length,
      validationEvents: validationEvents.length,
      testEvents: testEvents.length,
      totalMarkets: samples.length,
      trainMarkets: train.length,
      validationMarkets: validation.length,
      testMarkets: test.length,
      firstEndAt: samples[0].endAt,
      lastEndAt: samples.at(-1)?.endAt ?? samples[0].endAt,
      assets,
      structuralFeatureMarkets,
      structuralFeatureCoverage,
      executionFeatureMarkets,
      executionFeatureCoverage,
      testExecutionFeatureMarkets,
      testExecutionFeatureCoverage,
      synchronizedExecutionMarkets,
      synchronizedExecutionCoverage,
      testSynchronizedExecutionMarkets,
      testSynchronizedExecutionCoverage,
      fundingFeatureMarkets,
      fundingFeatureCoverage,
      testFundingFeatureMarkets,
      testFundingFeatureCoverage,
      fundingCostMarkets,
      fundingCostCoverage,
      testFundingCostMarkets,
      testFundingCostCoverage,
      medianObservationLagMinutes: median(observationLags),
      medianEntryLagMinutes: median(entryLags),
      medianExitLeadMinutes: median(exitLeads),
      maximumExecutionTimingErrorMinutes,
      probabilityLadderEvents: ladder.events,
      probabilityLadderViolationEvents: ladder.violationEvents,
    },
    probability: {
      modelBrierScore,
      marketBrierScore,
      brierSkill,
      relativeImprovement,
      confidenceInterval95,
      statisticallyPositive,
      modelLogLoss: eventAverage(testEvents, predictions, ({ sample, modelProbability }) => logLoss(modelProbability, sample.outcome)),
      marketLogLoss: eventAverage(testEvents, predictions, ({ sample }) => logLoss(sample.marketProbability, sample.outcome)),
      modelAccuracy: eventAverage(testEvents, predictions, ({ sample, modelProbability }) => Number((modelProbability >= 0.5) === Boolean(sample.outcome))),
      marketAccuracy: eventAverage(testEvents, predictions, ({ sample }) => Number((sample.marketProbability >= 0.5) === Boolean(sample.outcome))),
    },
    trading,
    combinedTrading,
    quality: { status: qualityStatus, gates },
  };
}

function evaluateCandidate(candidate: ModelCandidate, train: EvaluationSample[], validationEvents: EventGroup[]) {
  const history = [...train];
  const losses: number[] = [];
  const improvements: number[] = [];
  for (const event of validationEvents) {
    const fitted = fitCandidate(candidate, history);
    const modelLoss = average(event.samples.map((sample) => (predictProbability(sample, fitted) - sample.outcome) ** 2));
    const marketLoss = average(event.samples.map((sample) => (sample.marketProbability - sample.outcome) ** 2));
    losses.push(modelLoss);
    improvements.push(marketLoss - modelLoss);
    history.push(...event.samples);
  }
  return { candidate, score: average(losses), confidenceInterval95: meanConfidenceInterval(improvements) };
}

function fitCandidate(candidate: ModelCandidate, training: EvaluationSample[]): ModelCandidate {
  if (candidate.kind !== "ridge-logit-pool") return { ...candidate };
  return { ...candidate, coefficients: fitRidgeLogitPool(training, candidate.regularization) };
}

function predictProbability(sample: EvaluationSample, candidate: ModelCandidate) {
  const rawMarket = clamp(sample.marketProbability, 0, 1);
  if (candidate.kind === "market" || !hasStructuralProbability(sample)) return rawMarket;
  const market = clamp(rawMarket, 0.001, 0.999);
  const structural = clamp(sample.structuralProbability, 0.001, 0.999);
  if (candidate.kind === "logit-pool") {
    return sigmoid((1 - candidate.structuralWeight) * logit(market) + candidate.structuralWeight * logit(structural));
  }
  const [intercept, marketCoefficient, structuralCoefficient] = candidate.coefficients ?? [0, 1, 0];
  return clamp(sigmoid(intercept + marketCoefficient * logit(market) + structuralCoefficient * logit(structural)), 0.001, 0.999);
}

function fitRidgeLogitPool(samples: EvaluationSample[], regularization: number): [number, number, number] {
  const usable = samples.filter(hasStructuralProbability);
  if (!usable.length) return [0, 1, 0];
  const counts = usable.reduce<Map<string, number>>((result, sample) => result.set(sample.eventId, (result.get(sample.eventId) ?? 0) + 1), new Map());
  const eventCount = counts.size;
  const prior: [number, number, number] = [0, 1, 0];
  const coefficients: [number, number, number] = [...prior];

  for (let iteration = 0; iteration < 25; iteration += 1) {
    const gradient = [0, 0, 0];
    const hessian = Array.from({ length: 3 }, () => [0, 0, 0]);
    for (const sample of usable) {
      const features = [1, logit(clamp(sample.marketProbability, 0.001, 0.999)), logit(clamp(sample.structuralProbability, 0.001, 0.999))];
      const probability = sigmoid(dot(coefficients, features));
      const weight = 1 / eventCount / (counts.get(sample.eventId) ?? 1);
      for (let row = 0; row < 3; row += 1) {
        gradient[row] += weight * (probability - sample.outcome) * features[row];
        for (let column = 0; column < 3; column += 1) {
          hessian[row][column] += weight * probability * (1 - probability) * features[row] * features[column];
        }
      }
    }
    for (let index = 0; index < 3; index += 1) {
      gradient[index] += regularization * (coefficients[index] - prior[index]);
      hessian[index][index] += regularization;
    }
    const step = solveThreeByThree(hessian, gradient);
    if (!step) return [...prior];
    for (let index = 0; index < 3; index += 1) coefficients[index] -= step[index];
    coefficients[0] = clamp(coefficients[0], -4, 4);
    coefficients[1] = clamp(coefficients[1], -2, 4);
    coefficients[2] = clamp(coefficients[2], -2, 4);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  return coefficients;
}

function solveThreeByThree(matrix: number[][], vector: number[]): [number, number, number] | null {
  const rows = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let index = column; index < 4; index += 1) rows[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let index = column; index < 4; index += 1) rows[row][index] -= factor * rows[column][index];
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]];
}

function simulateTrading(events: Array<Array<{ sample: EvaluationSample; modelProbability: number }>>) {
  let capital = initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let trades = 0;
  let wins = 0;
  let totalFees = 0;

  for (const event of events) {
    const opportunity = event.flatMap(({ sample, modelProbability }) => {
      const yesPrice = clamp(sample.marketProbability + halfSpread + slippage, 0.01, 0.99);
      const noPrice = clamp(1 - sample.marketProbability + halfSpread + slippage, 0.01, 0.99);
      return [
        { sample, outcome: 1 as const, price: yesPrice, fee: feePerShare(yesPrice), edge: modelProbability - yesPrice - feePerShare(yesPrice) },
        { sample, outcome: 0 as const, price: noPrice, fee: feePerShare(noPrice), edge: 1 - modelProbability - noPrice - feePerShare(noPrice) },
      ];
    }).sort((a, b) => b.edge - a.edge)[0];
    if (!opportunity || opportunity.edge < entryEdge) continue;

    const { sample, outcome, price, fee } = opportunity;
    const budget = capital * maxPositionPct;
    const quantity = budget / (price + fee);
    const feePaid = quantity * fee;
    const payout = sample.outcome === outcome ? quantity : 0;
    capital += payout - budget;
    totalFees += feePaid;
    trades += 1;
    if (payout > budget) wins += 1;
    peak = Math.max(peak, capital);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - capital) / peak : 0);
  }

  return {
    initialCapital,
    endingCapital: capital,
    netReturnPct: capital / initialCapital - 1,
    trades,
    wins,
    winRate: trades ? wins / trades : null,
    maxDrawdownPct,
    totalFees,
    assumedHalfSpread: halfSpread,
    assumedSlippage: slippage,
    entryEdge,
  };
}

function feePerShare(price: number) {
  return takerFeeRate * price * (1 - price);
}

function createDatasetHash(samples: EvaluationSample[]) {
  return createHash("sha256")
    .update(samples.map((sample) => `${sample.marketId}:${sample.observedAt}:${sample.marketProbability}:${sample.structuralProbability ?? "none"}:${sample.hyperliquidEntryPrice ?? "none"}:${sample.hyperliquidExitPrice ?? "none"}:${sample.hyperliquidMomentum6h ?? "none"}:${sample.hyperliquidMomentum24h ?? "none"}:${sample.hyperliquidFunding24h ?? "none"}:${sample.hyperliquidFundingDuringTrade ?? "none"}:${sample.outcome}`).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function meanConfidenceInterval(values: number[]): [number, number] {
  const mean = average(values);
  if (values.length < 2) return [mean, mean];
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = criticalValue95(values.length - 1) * Math.sqrt(variance / values.length);
  return [mean - margin, mean + margin];
}

type EventGroup = { id: string; endAt: string; samples: EvaluationSample[] };

function groupByEvent(samples: EvaluationSample[]): EventGroup[] {
  const groups = new Map<string, EvaluationSample[]>();
  for (const sample of samples) groups.set(sample.eventId, [...(groups.get(sample.eventId) ?? []), sample]);
  return Array.from(groups, ([id, eventSamples]) => ({ id, endAt: eventSamples[0].endAt, samples: eventSamples }))
    .sort((a, b) => new Date(a.endAt).getTime() - new Date(b.endAt).getTime() || a.id.localeCompare(b.id));
}

function eventAverage(
  events: EventGroup[],
  predictions: Array<{ sample: EvaluationSample; modelProbability: number }>,
  score: (prediction: { sample: EvaluationSample; modelProbability: number }) => number,
) {
  return average(events.map((event) => average(predictions.filter(({ sample }) => sample.eventId === event.id).map(score))));
}

function criticalValue95(degreesOfFreedom: number) {
  if (degreesOfFreedom <= 4) return 2.776;
  if (degreesOfFreedom <= 9) return 2.262;
  if (degreesOfFreedom <= 14) return 2.145;
  if (degreesOfFreedom <= 19) return 2.093;
  if (degreesOfFreedom <= 29) return 2.045;
  return 1.96;
}

function logLoss(probability: number, outcome: 0 | 1) {
  const bounded = clamp(probability, 0.0001, 0.9999);
  return -(outcome * Math.log(bounded) + (1 - outcome) * Math.log(1 - bounded));
}

function hasStructuralProbability(sample: EvaluationSample): sample is EvaluationSample & { structuralProbability: number } {
  return typeof sample.structuralProbability === "number" && Number.isFinite(sample.structuralProbability);
}

function hasExecutionData(sample: EvaluationSample) {
  return typeof sample.hyperliquidEntryPrice === "number"
    && Number.isFinite(sample.hyperliquidEntryPrice)
    && typeof sample.hyperliquidExitPrice === "number"
    && Number.isFinite(sample.hyperliquidExitPrice);
}

function hasSynchronizedExecutionData(sample: EvaluationSample) {
  return sample.executionPriceSource === "synchronized-1m" && hasExecutionData(sample);
}

function hasFundingFeature(sample: EvaluationSample) {
  return typeof sample.hyperliquidFunding24h === "number" && Number.isFinite(sample.hyperliquidFunding24h);
}

function hasFundingCost(sample: EvaluationSample) {
  return typeof sample.hyperliquidFundingDuringTrade === "number" && Number.isFinite(sample.hyperliquidFundingDuringTrade);
}

function probabilityLadderStats(samples: EvaluationSample[]) {
  const groups = new Map<string, EvaluationSample[]>();
  for (const sample of samples) {
    const key = `${sample.eventId}:${sample.asset}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  let events = 0;
  let violationEvents = 0;
  for (const group of groups.values()) {
    const points = group.flatMap((sample) => {
      if (sample.thresholdKind !== "above" && sample.thresholdKind !== "below") return [];
      const threshold = sample.thresholdKind === "above" ? sample.thresholdLower : sample.thresholdUpper;
      if (typeof threshold !== "number") return [];
      return [{ id: sample.marketId, kind: sample.thresholdKind, threshold, probability: sample.marketProbability }];
    });
    if (points.length < 2) continue;
    events += 1;
    if (fitMonotonicProbabilityLadder(points).violations > 0) violationEvents += 1;
  }
  return { events, violationEvents };
}

function logit(probability: number) {
  return Math.log(probability / (1 - probability));
}

function sigmoid(value: number) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function dot(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
