import { ensureCombinedShadowRun, tickCombinedShadowRun, type CombinedShadowConfig } from "../src/lib/combined-trading/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(60_000, Number(process.env.FORWARD_EXPERIMENT_INTERVAL_MS ?? 300_000));

// This configuration is intentionally versioned and fixed. Changing it requires a new experiment key.
const config: Partial<CombinedShadowConfig> = {
  experimentKey: "poly-funding-consensus-v1",
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

let run = await ensureCombinedShadowRun(config);

async function tick() {
  try {
    run = await ensureCombinedShadowRun(config);
    await markPipelineAttempt("forward-experiment", "次期モデルを開始後データだけで評価中");
    const status = await tickCombinedShadowRun(run.id);
    await markPipelineSuccess("forward-experiment", 1, status?.lastDecision?.reason ?? "次期モデルの仮想売買を更新");
    console.log(JSON.stringify({
      type: "forward-experiment-tick",
      runId: run.id,
      action: status?.lastDecision?.action,
      closedTrades: status?.closedTrades,
      openPositions: status?.openPositions.length,
    }));
  } catch (error) {
    await markPipelineError("forward-experiment", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`forward experiment ${run.id} running every ${intervalMs}ms without backfill`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
