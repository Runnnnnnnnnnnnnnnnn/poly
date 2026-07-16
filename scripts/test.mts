import assert from "node:assert/strict";

import { calculateBacktestMetrics } from "../src/lib/backtest/metrics";

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
