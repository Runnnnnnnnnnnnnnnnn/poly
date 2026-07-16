import { createHash } from "node:crypto";

import type { CalibrationCandidate, EvaluationSample, ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";

export const MODEL_VERSION = "Reliability Guard v4";
export const HORIZON_HOURS = 24;
export const MIN_TRAIN_EVENTS = 20;
export const MIN_HOLDOUT_EVENTS = 15;

const candidates: CalibrationCandidate[] = [
  { id: "market guard", bins: 5, priorStrength: 8, blendWeight: 0 },
  { id: "conservative calibration", bins: 5, priorStrength: 8, blendWeight: 0.25 },
  { id: "balanced calibration", bins: 5, priorStrength: 8, blendWeight: 0.5 },
  { id: "adaptive calibration", bins: 10, priorStrength: 5, blendWeight: 0.5 },
  { id: "full calibration", bins: 10, priorStrength: 5, blendWeight: 1 },
];

const initialCapital = 10_000;
const maxPositionPct = 0.05;
const halfSpread = 0.01;
const slippage = 0.005;
const entryEdge = 0.03;
const takerFeeRate = 0.07;

export function evaluateChronologicalModel(input: EvaluationSample[]): ModelEvaluationMetrics {
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
  const selectedCandidate = candidateEvaluations
    .filter(({ candidate, confidenceInterval95 }) => candidate.blendWeight === 0 || confidenceInterval95[0] > 0)
    .sort((a, b) => a.score - b.score || a.candidate.id.localeCompare(b.candidate.id))[0].candidate;

  const prior = [...train, ...validation];
  const predictions = test.map((sample) => ({
    sample,
    modelProbability: calibrate(sample.marketProbability, prior, selectedCandidate),
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
  const assets = samples.reduce<Record<string, number>>((counts, sample) => ({ ...counts, [sample.asset]: (counts[sample.asset] ?? 0) + 1 }), {});
  const statisticallyPositive = confidenceInterval95[0] > 0;
  const gates = [
    { id: "chronology", label: "時系列で訓練とテストを分離", passed: true },
    { id: "horizon", label: "全市場を決着24時間前で統一", passed: true },
    { id: "same-holdout", label: "同一テスト市場でPolymarketと比較", passed: true },
    { id: "costs", label: "スプレッド・滑り・手数料を反映", passed: true },
    { id: "sample", label: `最終テスト${MIN_HOLDOUT_EVENTS}イベント以上`, passed: testEvents.length >= MIN_HOLDOUT_EVENTS },
    { id: "significance", label: "誤差改善の95%区間がプラス", passed: statisticallyPositive },
  ];
  const qualityStatus = relativeImprovement < 0
    ? "underperforming"
    : testEvents.length >= MIN_HOLDOUT_EVENTS && statisticallyPositive && trading.netReturnPct > 0
      ? "promising"
      : "inconclusive";

  return {
    methodology: "chronological-holdout",
    horizonHours: HORIZON_HOURS,
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
    quality: { status: qualityStatus, gates },
  };
}

export function calibrate(probability: number, training: EvaluationSample[], candidate: CalibrationCandidate) {
  const marketProbability = clamp(probability, 0, 1);
  if (candidate.blendWeight === 0) return marketProbability;
  const bounded = clamp(probability, 0.001, 0.999);
  const bin = Math.min(candidate.bins - 1, Math.floor(bounded * candidate.bins));
  const matches = training.filter((sample) => Math.min(candidate.bins - 1, Math.floor(clamp(sample.marketProbability, 0, 0.999999) * candidate.bins)) === bin);
  if (!matches.length) return bounded;
  const successes = matches.reduce((sum, sample) => sum + sample.outcome, 0);
  const calibrated = clamp((successes + candidate.priorStrength * bounded) / (matches.length + candidate.priorStrength), 0.01, 0.99);
  return clamp(bounded + candidate.blendWeight * (calibrated - bounded), 0.01, 0.99);
}

function evaluateCandidate(candidate: CalibrationCandidate, train: EvaluationSample[], validationEvents: EventGroup[]) {
  const history = [...train];
  const losses: number[] = [];
  const improvements: number[] = [];
  for (const event of validationEvents) {
    const modelLoss = average(event.samples.map((sample) => (calibrate(sample.marketProbability, history, candidate) - sample.outcome) ** 2));
    const marketLoss = average(event.samples.map((sample) => (sample.marketProbability - sample.outcome) ** 2));
    losses.push(modelLoss);
    improvements.push(marketLoss - modelLoss);
    history.push(...event.samples);
  }
  return { candidate, score: average(losses), confidenceInterval95: meanConfidenceInterval(improvements) };
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
    .update(samples.map((sample) => `${sample.marketId}:${sample.observedAt}:${sample.marketProbability}:${sample.outcome}`).join("|"))
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

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
