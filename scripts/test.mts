import assert from "node:assert/strict";

import { calculateBacktestMetrics } from "../src/lib/backtest/metrics";
import { compareTestnetPositions, normalizeExchangeOrderStatus } from "../src/lib/combined-trading/hyperliquid-execution";
import { calculatePriceBasisPct } from "../src/lib/combined-trading/polymarket-reference";
import { applyCombinedSignalRule, calculateCombinedClose } from "../src/lib/combined-trading/service";
import { planAlertDeliveries } from "../src/lib/monitoring/alert-state";
import { evaluatePipelineAlerts, evaluateSettlementBasisAlerts } from "../src/lib/monitoring/operational-alerts";
import { resolveTunnelConfig } from "./tunnel-config.mjs";
import { deflatedSharpeProbability, evaluateCombinedTrading, impliedTerminalMedianForCondition } from "../src/lib/model-evaluation/combined-trading";
import { evaluateChronologicalModel } from "../src/lib/model-evaluation/engine";
import { fitMonotonicProbabilityLadder } from "../src/lib/model-evaluation/probability-ladder";
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

const bullishTarget = impliedTerminalMedianForCondition("above", 100, null, 0.8, 0.05);
const bearishTarget = impliedTerminalMedianForCondition("below", null, 100, 0.8, 0.05);
assert.ok((bullishTarget ?? 0) > 100);
assert.ok((bearishTarget ?? 200) < 100);
assert.equal(impliedTerminalMedianForCondition("between", 90, 110, 0.5, 0.05), null);

console.log("live signal inversion tests passed");

const ladder = fitMonotonicProbabilityLadder([
  { id: "90", kind: "above", threshold: 90, probability: 0.6 },
  { id: "100", kind: "above", threshold: 100, probability: 0.7 },
  { id: "110", kind: "above", threshold: 110, probability: 0.2 },
]);
assert.equal(ladder.violations, 1);
const corrected = new Map(ladder.points.map((point) => [point.id, point.correctedProbability]));
assert.ok((corrected.get("90") ?? 0) >= (corrected.get("100") ?? 1));
assert.ok((corrected.get("100") ?? 0) >= (corrected.get("110") ?? 1));
assert.ok((deflatedSharpeProbability(Array.from({ length: 20 }, () => 0.01), 5) ?? 0) > 0.95);

console.log("probability ladder and selection-bias tests passed");

const closeCost = {
  quantity: 10,
  entryPrice: 100,
  entryFee: 0.45,
  openedAt: new Date("2026-01-01T00:00:00Z"),
  now: new Date("2026-01-02T00:00:00Z"),
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
};
const longClose = calculateCombinedClose({ ...closeCost, side: "LONG", markPrice: 102 });
const shortClose = calculateCombinedClose({ ...closeCost, side: "SHORT", markPrice: 98 });
assert.ok(longClose.realizedPnl > 18);
assert.ok(shortClose.realizedPnl > 18);
assert.ok(longClose.realizedPnl < longClose.grossPnl);
assert.ok(shortClose.realizedPnl < shortClose.grossPnl);

console.log("combined shadow cost tests passed");

const syntheticLiveSignal = {
  eventId: "event",
  marketId: "market",
  asset: "BTC" as const,
  observedAt: "2026-01-01T00:00:00Z",
  exitAt: "2026-01-02T00:00:00Z",
  horizonHours: 24,
  actualHoursToEnd: 24,
  marketProbability: 0.8,
  marketBestBid: 0.79,
  marketBestAsk: 0.81,
  marketSpread: 0.02,
  polymarketReferencePrice: 100,
  referenceSource: "BINANCE" as const,
  referenceCapturedAt: "2026-01-01T00:00:00Z",
  spotPrice: 100,
  priceBasisPct: 0,
  impliedTarget: 102,
  realizedVolatility24h: 0.02,
  hyperliquidMomentum6h: 0.01,
  trendZ6h: 1,
  signalZ: 1,
  side: "LONG" as const,
  sourceMarkets: 3,
  ladderViolations: 0,
  ladderAdjustmentRms: 0,
};
assert.equal(applyCombinedSignalRule(syntheticLiveSignal, "polymarket-only").side, "LONG");
assert.equal(applyCombinedSignalRule(syntheticLiveSignal, "contrarian").side, "SHORT");
assert.equal(applyCombinedSignalRule({ ...syntheticLiveSignal, side: "SHORT", trendZ6h: 1 }, "hyperliquid-momentum").side, "LONG");
assert.equal(applyCombinedSignalRule({ ...syntheticLiveSignal, side: "LONG", trendZ6h: -1 }, "hyperliquid-reversion").side, "LONG");

console.log("combined shadow signal-rule tests passed");

assert.ok(Math.abs((calculatePriceBasisPct(100.1, 100) ?? 0) - 0.001) < 1e-12);
assert.equal(calculatePriceBasisPct(0, 100), null);
assert.equal(calculatePriceBasisPct(100, Number.NaN), null);

console.log("settlement reference basis tests passed");

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

const combinedSamples: EvaluationSample[] = [];
for (let eventIndex = 0; eventIndex < 60; eventIndex += 1) {
  const long = eventIndex % 5 === 0 || eventIndex % 5 === 1;
  const polymarketLong = eventIndex % 2 === 0;
  const entryAt = new Date(Date.UTC(2024, 0, 1 + eventIndex * 2, 0));
  const exitAt = new Date(entryAt.getTime() + 24 * 60 * 60 * 1_000);
  combinedSamples.push({
    eventId: `combined-${eventIndex}`,
    marketId: `combined-market-${eventIndex}`,
    asset: "BTC",
    title: "Will Bitcoin be above $100 on the test date?",
    endAt: exitAt.toISOString(),
    observedAt: entryAt.toISOString(),
    marketProbability: polymarketLong ? 0.8 : 0.2,
    realizedVolatility24h: 0.02,
    hyperliquidEntryAt: entryAt.toISOString(),
    hyperliquidEntryPrice: 100,
    hyperliquidExitAt: exitAt.toISOString(),
    hyperliquidExitPrice: long ? 102 : 98,
    hyperliquidMomentum6h: long ? 0.01 : -0.01,
    hyperliquidMomentum24h: long ? 0.02 : -0.02,
    thresholdKind: "above",
    thresholdLower: 100,
    thresholdUpper: null,
    outcome: long ? 1 : 0,
  });
}

const combined = evaluateCombinedTrading(combinedSamples);
assert.notEqual(combined.selectedStrategy.id, "no-trade guard");
assert.equal(combined.trades, 24);
assert.equal(combined.longTrades + combined.shortTrades, 24);
assert.ok(combined.longTrades > 0 && combined.shortTrades > 0);
assert.ok(combined.netReturnPct > 0);
assert.ok(combined.excessReturnPct > 0);
assert.equal(combined.statisticallyPositive, true);
assert.ok((combined.deflatedSharpeProbability ?? 0) > 0.95);
assert.equal(combined.strategyTrials, 15);
assert.equal(combined.walkForwardFolds, 4);
assert.equal(combined.selectedFromValidation, true);
assert.equal(combined.candidateDiagnostics.length, 6);
assert.equal(combined.candidateDiagnostics.some((candidate) => candidate.passed), true);
assert.equal(
  combined.candidateDiagnostics
    .find((candidate) => candidate.strategy.signalRule === "polymarket-only")
    ?.gates.find((gate) => gate.id === "benchmark")?.passed,
  false,
);
assert.equal(combined.benchmarks.randomTrials, 200);
assert.ok(Number.isFinite(combined.benchmarks.polymarketDirectionReturnPct));
assert.ok(Number.isFinite(combined.benchmarks.randomMedianReturnPct));
assert.deepEqual(combined.benchmarks, evaluateCombinedTrading(combinedSamples).benchmarks);

const concurrentCombined = evaluateCombinedTrading([
  ...combinedSamples,
  ...combinedSamples.map((sample) => ({
    ...sample,
    eventId: `${sample.eventId}-eth`,
    marketId: `${sample.marketId}-eth`,
    asset: "ETH" as const,
  })),
]);
assert.equal(concurrentCombined.totalEligibleSignals, 120);
assert.equal(concurrentCombined.validationEligibleSignals, 72);
assert.equal(concurrentCombined.trades, 48);

const reversionCombined = evaluateCombinedTrading(combinedSamples.map((sample) => ({
  ...sample,
  hyperliquidExitPrice: sample.hyperliquidExitPrice === 102 ? 98 : 102,
})));
assert.equal(reversionCombined.selectedStrategy.signalRule, "hyperliquid-reversion");
assert.equal(reversionCombined.trades, 24);
assert.ok(reversionCombined.netReturnPct > 0);
assert.ok(reversionCombined.excessReturnPct > 0);

const guarded = evaluateCombinedTrading(combinedSamples.map((sample, index) => index < 36 ? ({
  ...sample,
  hyperliquidExitPrice: 100,
}) : sample));
assert.equal(guarded.selectedStrategy.id, "no-trade guard");
assert.equal(guarded.selectedFromValidation, false);
assert.ok(guarded.closestValidationCandidate);
assert.equal(guarded.candidateDiagnostics.every((candidate) => !candidate.passed), true);

console.log("combined Polymarket and Hyperliquid strategy tests passed");

assert.equal(normalizeExchangeOrderStatus({ status: "query_error", error: "temporary timeout" }), null);
assert.equal(normalizeExchangeOrderStatus({ status: "unknownOid" }), null);
assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status: "filled" } }), "FILLED");
assert.equal(normalizeExchangeOrderStatus({ status: "order", order: { status: "open" } }), "OPEN");

console.log("testnet reconciliation status tests passed");

assert.deepEqual(compareTestnetPositions(
  [{ coin: "BTC", size: 0.1 }, { coin: "ETH", size: -0.2 }],
  [
    { asset: "BTC", side: "LONG", action: "OPEN", quantity: 0.1 },
    { asset: "ETH", side: "SHORT", action: "OPEN", quantity: 0.1 },
  ],
), [{ asset: "ETH", expectedSize: -0.1, actualSize: -0.2, kind: "quantity" }]);

const alertNow = new Date("2026-01-01T01:00:00Z");
const healthyHeartbeats = ["polymarket", "hyperliquid", "paper", "combined-shadow", "backtest"].map((id) => ({
  id,
  status: "healthy",
  message: null,
  lastSuccessAt: new Date("2026-01-01T00:55:00Z"),
  lastAttemptAt: new Date("2026-01-01T00:55:00Z"),
}));
assert.equal(evaluatePipelineAlerts(healthyHeartbeats, alertNow).length, 0);
const staleAlerts = evaluatePipelineAlerts(healthyHeartbeats.map((item) => item.id === "polymarket"
  ? { ...item, lastSuccessAt: new Date("2026-01-01T00:30:00Z") }
  : item), alertNow);
assert.equal(staleAlerts.some((alert) => alert.key === "pipeline-stale:polymarket"), true);
const firstAlertPlan = planAlertDeliveries(staleAlerts, {}, alertNow, 60 * 60 * 1_000);
assert.equal(firstAlertPlan.deliveries[0]?.event, "triggered");
const recoveredAlertPlan = planAlertDeliveries([], firstAlertPlan.next, new Date("2026-01-01T01:05:00Z"), 60 * 60 * 1_000);
assert.equal(recoveredAlertPlan.deliveries[0]?.event, "recovered");

const basisAlertRows = Array.from({ length: 10 }, (_, index) => ({
  exitPriceBasisPct: index % 2 ? 0.0012 : -0.0012,
  exitReferenceCapturedAt: new Date("2026-01-01T00:00:00Z"),
  closedAt: new Date("2026-01-01T00:01:30Z"),
}));
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows.slice(0, 9)).length, 0);
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows)[0]?.severity, "warning");
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows.map((row) => ({ ...row, exitPriceBasisPct: 0.004 })))[0]?.severity, "critical");
assert.equal(evaluateSettlementBasisAlerts(basisAlertRows.map((row) => ({ ...row, exitReferenceCapturedAt: null })))[0]?.severity, "warning");

console.log("operational alert tests passed");

assert.deepEqual(resolveTunnelConfig({}, "3001"), {
  mode: "quick",
  args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3001"],
  publicUrl: "",
  allowQuickFallback: false,
});
const namedTunnel = resolveTunnelConfig({
  CLOUDFLARED_TUNNEL_TOKEN: "test-token",
  CLOUDFLARED_PUBLIC_URL: "https://api.example.com/",
}, "3001");
assert.equal(namedTunnel.mode, "named-token");
assert.equal(namedTunnel.publicUrl, "https://api.example.com");
assert.equal(namedTunnel.allowQuickFallback, true);
assert.throws(() => resolveTunnelConfig({ CLOUDFLARED_TUNNEL_TOKEN: "test-token" }, "3001"));

console.log("tunnel configuration tests passed");
