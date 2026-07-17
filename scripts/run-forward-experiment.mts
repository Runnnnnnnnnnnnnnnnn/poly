import { ensureCombinedShadowRun, tickCombinedShadowRun, type CombinedShadowConfig } from "../src/lib/combined-trading/service";
import { forwardControlExperimentKey, forwardStrategyExperimentKey } from "../src/lib/combined-trading/forward-evaluation";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(60_000, Number(process.env.FORWARD_EXPERIMENT_INTERVAL_MS ?? 300_000));

// This configuration is intentionally versioned and fixed. Changing it requires a new experiment key.
const strategyConfig: Partial<CombinedShadowConfig> = {
  experimentKey: forwardStrategyExperimentKey,
  experimentLabel: "Poly予測 × 資金調達一致 v1",
  forwardOnly: true,
  initialEquity: 10_000,
  minimumSignalZ: 0.25,
  minimumTrendZ: 0,
  minimumFunding24h: 0.0003,
  signalRule: "polymarket-funding-consensus",
  modelVersion: "Forward Experiment 2026-07-17 / no backfill",
  positionPct: 0.05,
  maxPositionNotional: 500,
  maxConcurrentPositions: 3,
  maxDailyLossPct: 0.02,
  maxDrawdownPct: 0.05,
};

const controlConfig: Partial<CombinedShadowConfig> = {
  ...strategyConfig,
  experimentKey: forwardControlExperimentKey,
  experimentLabel: "Polymarket方向のみ 対照 v1",
  minimumFunding24h: 0,
  signalRule: "polymarket-only",
  modelVersion: "Forward Control 2026-07-17 / no backfill",
};

let strategyRun = await ensureCombinedShadowRun(strategyConfig);
let controlRun = await ensureCombinedShadowRun(controlConfig);

async function tick() {
  try {
    strategyRun = await ensureCombinedShadowRun(strategyConfig);
    controlRun = await ensureCombinedShadowRun(controlConfig);
    await markPipelineAttempt("forward-experiment", "次期モデルと対照戦略を開始後データだけで評価中");
    const observedAt = new Date();
    const strategyStatus = await tickCombinedShadowRun(strategyRun.id, observedAt);
    const controlStatus = await tickCombinedShadowRun(controlRun.id, observedAt);
    await markPipelineSuccess("forward-experiment", 2, strategyStatus?.lastDecision?.reason ?? "次期モデルと対照戦略を更新");
    console.log(JSON.stringify({
      type: "forward-experiment-tick",
      strategyRunId: strategyRun.id,
      controlRunId: controlRun.id,
      strategyAction: strategyStatus?.lastDecision?.action,
      controlAction: controlStatus?.lastDecision?.action,
      strategyClosedTrades: strategyStatus?.closedTrades,
      controlClosedTrades: controlStatus?.closedTrades,
      strategyOpenPositions: strategyStatus?.openPositions.length,
      controlOpenPositions: controlStatus?.openPositions.length,
    }));
  } catch (error) {
    await markPipelineError("forward-experiment", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`forward experiment ${strategyRun.id} with control ${controlRun.id} running every ${intervalMs}ms without backfill`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
