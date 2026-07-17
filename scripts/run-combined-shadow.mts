import { ensureCombinedShadowRun, getQualifiedModelShadowConfig, tickCombinedShadowRun } from "../src/lib/combined-trading/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(60_000, Number(process.env.COMBINED_SHADOW_INTERVAL_MS ?? 300_000));
const qualifiedModelConfig = process.env.COMBINED_USE_QUALIFIED_MODEL === "0" ? null : await getQualifiedModelShadowConfig();
const configuredSignalRule = process.env.COMBINED_SIGNAL_RULE;
const signalRule = configuredSignalRule === "contrarian"
  || configuredSignalRule === "hyperliquid-momentum"
  || configuredSignalRule === "hyperliquid-reversion"
  || configuredSignalRule === "hyperliquid-funding-carry"
  || configuredSignalRule === "hyperliquid-funding-momentum"
  || configuredSignalRule === "polymarket-funding-consensus"
  ? configuredSignalRule
  : "polymarket-only";
const config = {
  experimentKey: "legacy-shadow-v1",
  experimentLabel: "従来の組み合わせ検証",
  forwardOnly: false,
  initialEquity: Number(process.env.COMBINED_INITIAL_EQUITY ?? 10_000),
  minimumSignalZ: Number(qualifiedModelConfig?.minimumSignalZ ?? process.env.COMBINED_MINIMUM_SIGNAL_Z ?? 0.5),
  minimumTrendZ: Number(qualifiedModelConfig?.minimumTrendZ ?? process.env.COMBINED_MINIMUM_TREND_Z ?? 0.1),
  minimumFunding24h: Number(qualifiedModelConfig?.minimumFunding24h ?? process.env.COMBINED_MINIMUM_FUNDING_24H ?? 0.0003),
  signalRule: qualifiedModelConfig?.signalRule ?? signalRule,
  modelVersion: qualifiedModelConfig?.modelVersion ?? null,
  positionPct: Number(qualifiedModelConfig?.positionPct ?? process.env.COMBINED_POSITION_PCT ?? 0.1),
  maxPositionNotional: Number(process.env.COMBINED_MAX_NOTIONAL ?? 1_000),
  maxConcurrentPositions: Number(process.env.COMBINED_MAX_CONCURRENT_POSITIONS ?? 1),
  maxDailyLossPct: Number(process.env.COMBINED_MAX_DAILY_LOSS_PCT ?? 0.02),
  maxDrawdownPct: Number(process.env.COMBINED_MAX_DRAWDOWN_PCT ?? 0.05),
};
let run = await ensureCombinedShadowRun(config);

async function tick() {
  try {
    run = await ensureCombinedShadowRun(config);
    await markPipelineAttempt("combined-shadow", "組み合わせシグナルを評価中");
    const status = await tickCombinedShadowRun(run.id);
    await markPipelineSuccess("combined-shadow", 1, status?.lastDecision?.reason ?? "組み合わせ仮想売買を更新");
    console.log(JSON.stringify({
      type: "combined-shadow-tick",
      runId: run.id,
      equity: status?.equity,
      action: status?.lastDecision?.action,
      openPositions: status?.openPositions.length,
    }));
  } catch (error) {
    await markPipelineError("combined-shadow", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`combined shadow run ${run.id} running every ${intervalMs}ms`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
