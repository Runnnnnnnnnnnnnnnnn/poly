import {
  scanShortTermDirectionSignal,
  shortTermDirectionControlKey,
  shortTermDirectionHorizonKey,
  shortTermDirectionStrategyKey,
} from "../src/lib/combined-trading/short-term-direction";
import { ensureCombinedShadowRun, loadCombinedMarkPrices, tickCombinedShadowRun, type CombinedShadowConfig } from "../src/lib/combined-trading/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(60_000, Number(process.env.SHORT_TERM_DIRECTION_INTERVAL_MS ?? 60_000));

// Versioned, forward-only rules. A rule change must use new experiment keys.
const sharedConfig: Partial<CombinedShadowConfig> = {
  forwardOnly: true,
  observationHorizonHours: shortTermDirectionHorizonKey,
  initialEquity: 10_000,
  minimumSignalZ: 1,
  minimumTrendZ: 0.15,
  minimumFunding24h: 0,
  positionPct: 0.05,
  maxPositionNotional: 500,
  maxConcurrentPositions: 3,
  maxDailyLossPct: 0.02,
  maxDrawdownPct: 0.05,
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
};

const strategyConfig: Partial<CombinedShadowConfig> = {
  ...sharedConfig,
  experimentKey: shortTermDirectionStrategyKey,
  experimentLabel: "15分Up/Down × Hyperliquid開始後トレンド一致",
  signalRule: "trend-confirmed",
  modelVersion: "Short Direction v2 2026-07-18 / shared exit quote / entry 2-4m / p 0.58 / spread 0.08 / no backfill",
};

const controlConfig: Partial<CombinedShadowConfig> = {
  ...sharedConfig,
  experimentKey: shortTermDirectionControlKey,
  experimentLabel: "15分Up/Downの方向のみ（同時対照）",
  minimumTrendZ: 0,
  signalRule: "polymarket-only",
  modelVersion: "Short Direction Control v2 2026-07-18 / shared exit quote / entry 2-4m / p 0.58 / spread 0.08 / no backfill",
};

let runs = await ensureRuns();

async function ensureRuns() {
  return {
    strategy: await ensureCombinedShadowRun(strategyConfig),
    control: await ensureCombinedShadowRun(controlConfig),
  };
}

async function tick() {
  try {
    runs = await ensureRuns();
    await markPipelineAttempt("short-term-direction", "15分Up/Downを開始2分後の板で前向き評価中");
    const observedAt = new Date();
    const [scan, markPrices] = await Promise.all([
      scanShortTermDirectionSignal(observedAt),
      loadCombinedMarkPrices(observedAt),
    ]);
    const strategy = await tickCombinedShadowRun(runs.strategy.id, observedAt, scan, markPrices);
    const control = await tickCombinedShadowRun(runs.control.id, observedAt, scan, markPrices);
    const records = (strategy?.closedTrades ?? 0) + (strategy?.openPositions.length ?? 0);
    await markPipelineSuccess(
      "short-term-direction",
      records,
      `15分モデル 決済${strategy?.closedTrades ?? 0}件 / 保有${strategy?.openPositions.length ?? 0}件`,
    );
    console.log(JSON.stringify({
      type: "short-term-direction-tick",
      observedAt: observedAt.toISOString(),
      markets: scan.scannedMarkets,
      inWindow: scan.horizonEligibleMarkets,
      priceReady: scan.priceReadyEvents,
      strategyAction: strategy?.lastDecision?.action,
      controlAction: control?.lastDecision?.action,
      strategyClosedTrades: strategy?.closedTrades ?? 0,
      controlClosedTrades: control?.closedTrades ?? 0,
    }));
  } catch (error) {
    await markPipelineError("short-term-direction", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`15-minute direction experiment running every ${intervalMs}ms without backfill`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
