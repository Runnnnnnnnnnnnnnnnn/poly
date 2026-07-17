import assert from "node:assert/strict";

import { calculateBacktestMetrics } from "../src/lib/backtest/metrics";
import { evaluateChronologicalModel } from "../src/lib/model-evaluation/engine";
import { parseTerminalPriceCondition, probabilityForCondition } from "../src/lib/model-evaluation/price-structure";
import type { EvaluationSample } from "../src/lib/model-evaluation/types";

const metrics = calculateBacktestMetrics(
  [
    { marketId: "a", predictedProbability: 0.6, actualOutcome: 1, brierScore: 0.16, logLoss: 0.51, position: 1, pnl: 10 },
    { marketId: "a", predictedProbability: 0.7, actualOutcome: 1, brierScore: 0.09, logLoss: 0.36, position: 1, pnl: 0 },
    { marketId: "b", predictedProbability: 0.4, actualOutcome: 0, brierScore: 0.16, logLoss: 0.51, position: -1, pnl: 5 },
  ],
  1_000,
  2,
);

assert.equal(metrics.observations, 3);
assert.equal(metrics.tradedMarkets, 2);
assert.equal(metrics.totalPnl, 15);
assert.equal(metrics.markets, 2);
assert.equal(metrics.calibration.reduce((sum, bucket) => sum + bucket.count, 0), 3);
assert.ok(Math.abs((metrics.brierScore ?? 0) - 0.1366666667) < 1e-9);

console.log("backtest metric tests passed");

assert.deepEqual(parseTerminalPriceCondition("Will Bitcoin be less than $100K on May 23?"), { kind: "below", lower: null, upper: 100_000 });
assert.deepEqual(parseTerminalPriceCondition("Will Bitcoin be between $90,000 and $88,000 on April 4?"), { kind: "between", lower: 88_000, upper: 90_000 });
assert.equal(parseTerminalPriceCondition("Will ETH dip below $3,000 in June?"), null);
assert.ok(Math.abs(probabilityForCondition(100, 0.1, { kind: "above", lower: 100, upper: null }) - 0.5) < 1e-6);
assert.ok(probabilityForCondition(100, 0.1, { kind: "above", lower: 90, upper: null }) > 0.5);

console.log("price structure tests passed");

const evaluationSamples: EvaluationSample[] = [];
for (let eventIndex = 0; eventIndex < 80; eventIndex += 1) {
  const endAt = new Date(Date.UTC(2024, 0, eventIndex + 1, 12)).toISOString();
  const observedAt = new Date(new Date(endAt).getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const marketCount = eventIndex === 79 ? 20 : 1;
  for (let marketIndex = 0; marketIndex < marketCount; marketIndex += 1) {
    const probability = 0.15 + ((eventIndex + marketIndex) % 8) * 0.1;
    evaluationSamples.push({
      eventId: `event-${eventIndex}`,
      marketId: `market-${eventIndex}-${marketIndex}`,
      asset: "BTC",
      title: `Synthetic market ${eventIndex}-${marketIndex}`,
      endAt,
      observedAt,
      marketProbability: probability,
      outcome: probability >= 0.5 ? 1 : 0,
    });
  }
}

const evaluation = evaluateChronologicalModel(evaluationSamples);
assert.equal(evaluation.dataset.totalEvents, 80);
assert.equal(evaluation.dataset.trainEvents, 48);
assert.equal(evaluation.dataset.validationEvents, 16);
assert.equal(evaluation.dataset.testEvents, 16);
assert.equal(evaluation.dataset.testMarkets, 35);
assert.ok(evaluation.trading.trades <= evaluation.dataset.testEvents);
assert.equal(evaluation.quality.gates.find((gate) => gate.id === "same-holdout")?.passed, true);
assert.equal(evaluation.dataset.hash, evaluateChronologicalModel([...evaluationSamples].reverse()).dataset.hash);

console.log("chronological model evaluation tests passed");
