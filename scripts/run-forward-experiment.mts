import { scanCombinedLiveSignal } from "../src/lib/combined-trading/live-signal";
import {
  forwardControlExperimentKey,
  forwardObservationHorizons,
  forwardStrategyExperimentKey,
  type ForwardObservationHorizon,
} from "../src/lib/combined-trading/forward-evaluation";
import { ensureCombinedShadowRun, tickCombinedShadowRun, type CombinedShadowConfig } from "../src/lib/combined-trading/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(60_000, Number(process.env.FORWARD_EXPERIMENT_INTERVAL_MS ?? 300_000));

// These configurations are intentionally versioned and fixed. Changing a rule requires v3 keys.
function strategyConfig(horizonHours: ForwardObservationHorizon): Partial<CombinedShadowConfig> {
  return {
    experimentKey: forwardStrategyExperimentKey(horizonHours),
    experimentLabel: `Poly予測 × 資金調達一致 v2 / ${horizonHours}時間`,
    forwardOnly: true,
    observationHorizonHours: horizonHours,
    initialEquity: 10_000,
    minimumSignalZ: 0.25,
    minimumTrendZ: 0,
    minimumFunding24h: 0.0003,
    signalRule: "polymarket-funding-consensus",
    modelVersion: `Forward Experiment v2 2026-07-18 / ${horizonHours}h / no backfill`,
    positionPct: 0.05,
    maxPositionNotional: 500,
    maxConcurrentPositions: 3,
    maxDailyLossPct: 0.02,
    maxDrawdownPct: 0.05,
  };
}

function controlConfig(horizonHours: ForwardObservationHorizon): Partial<CombinedShadowConfig> {
  return {
    ...strategyConfig(horizonHours),
    experimentKey: forwardControlExperimentKey(horizonHours),
    experimentLabel: `Polymarket方向のみ 対照 v2 / ${horizonHours}時間`,
    minimumFunding24h: 0,
    signalRule: "polymarket-only",
    modelVersion: `Forward Control v2 2026-07-18 / ${horizonHours}h / no backfill`,
  };
}

let experiments = await ensureExperiments();

async function ensureExperiments() {
  return Promise.all(forwardObservationHorizons.map(async (horizonHours) => ({
    horizonHours,
    strategyRun: await ensureCombinedShadowRun(strategyConfig(horizonHours)),
    controlRun: await ensureCombinedShadowRun(controlConfig(horizonHours)),
  })));
}

async function tick() {
  try {
    experiments = await ensureExperiments();
    await markPipelineAttempt("forward-experiment", "6・12・24・48時間モデルを開始後データだけで独立評価中");
    const observedAt = new Date();
    const scan = await scanCombinedLiveSignal(observedAt);
    const results = [];
    for (const experiment of experiments) {
      const strategyStatus = await tickCombinedShadowRun(experiment.strategyRun.id, observedAt, scan);
      const controlStatus = await tickCombinedShadowRun(experiment.controlRun.id, observedAt, scan);
      results.push({
        horizonHours: experiment.horizonHours,
        strategyRunId: experiment.strategyRun.id,
        controlRunId: experiment.controlRun.id,
        strategyAction: strategyStatus?.lastDecision?.action,
        controlAction: controlStatus?.lastDecision?.action,
        strategyClosedTrades: strategyStatus?.closedTrades ?? 0,
        controlClosedTrades: controlStatus?.closedTrades ?? 0,
        strategyOpenPositions: strategyStatus?.openPositions.length ?? 0,
        controlOpenPositions: controlStatus?.openPositions.length ?? 0,
      });
    }
    const closedTrades = results.reduce((total, result) => total + result.strategyClosedTrades, 0);
    await markPipelineSuccess("forward-experiment", results.length * 2, `4時間軸を独立検証中 / 決済${closedTrades}件`);
    console.log(JSON.stringify({ type: "forward-experiment-tick", observedAt: observedAt.toISOString(), results }));
  } catch (error) {
    await markPipelineError("forward-experiment", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`forward experiments ${forwardObservationHorizons.join("/")}h running every ${intervalMs}ms without backfill`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
