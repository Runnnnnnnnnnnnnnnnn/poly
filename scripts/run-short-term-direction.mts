import {
  scanShortTermDirectionSignal,
  isShortTermDirectionFamilyKey,
  shortTermDirectionControlKey,
  shortTermDirectionHorizonKey,
  shortTermDirectionSpecificationHash,
  shortTermDirectionStrategyKey,
} from "../src/lib/combined-trading/short-term-direction";
import type { CombinedSignalScan } from "../src/lib/combined-trading/live-signal";
import { ensureCombinedShadowRun, loadCombinedMarkPrices, tickCombinedShadowRun, type CombinedShadowConfig } from "../src/lib/combined-trading/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { prisma } from "../src/lib/server/prisma";

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
  specificationHash: shortTermDirectionSpecificationHash,
};

const strategyConfig: Partial<CombinedShadowConfig> = {
  ...sharedConfig,
  experimentKey: shortTermDirectionStrategyKey,
  experimentLabel: "15分Up/Down × Hyperliquid開始後トレンド一致",
  signalRule: "trend-confirmed",
  modelVersion: "Short Direction v5 2026-07-18 / causal 5s entry and exit audit / independent 15m windows / 11 trials / official resolution / entry 2-4m / p 0.58 / spread 0.08 / no backfill",
};

const controlConfig: Partial<CombinedShadowConfig> = {
  ...sharedConfig,
  experimentKey: shortTermDirectionControlKey,
  experimentLabel: "15分Up/Downの方向のみ（同時対照）",
  minimumTrendZ: 0,
  signalRule: "polymarket-only",
  modelVersion: "Short Direction Control v5 2026-07-18 / causal 5s entry and exit audit / independent 15m windows / 11 trials / official resolution / entry 2-4m / p 0.58 / spread 0.08 / no backfill",
};

let runs = await ensureRuns();

async function ensureRuns() {
  const active = {
    strategy: await ensureCombinedShadowRun(strategyConfig),
    control: await ensureCombinedShadowRun(controlConfig),
  };
  const retiringRunIds = await reconcileLegacyRuns([active.strategy.id, active.control.id]);
  return { ...active, retiringRunIds };
}

async function reconcileLegacyRuns(activeIds: string[]) {
  const running = await prisma.combinedShadowRun.findMany({
    where: { status: "running", id: { notIn: activeIds } },
    select: { id: true, configJson: true, _count: { select: { positions: { where: { status: "OPEN" } } } } },
  });
  const legacy = running.filter((run) => {
    const key = parseExperimentKey(run.configJson);
    return isShortTermDirectionFamilyKey(key);
  });
  const completedIds = legacy.filter((run) => run._count.positions === 0).map((run) => run.id);
  if (completedIds.length) {
    await prisma.combinedShadowRun.updateMany({
      where: { id: { in: completedIds }, status: "running" },
      data: { status: "superseded", stoppedAt: new Date() },
    });
  }
  return legacy.filter((run) => run._count.positions > 0).map((run) => run.id);
}

function parseExperimentKey(configJson: string) {
  try {
    const value = JSON.parse(configJson) as { experimentKey?: unknown };
    return typeof value.experimentKey === "string" ? value.experimentKey : "";
  } catch {
    return "";
  }
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
    for (const retiringRunId of runs.retiringRunIds) {
      await tickCombinedShadowRun(retiringRunId, observedAt, retirementScan(observedAt), markPrices);
    }
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
      retiringRuns: runs.retiringRunIds.length,
    }));
  } catch (error) {
    await markPipelineError("short-term-direction", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

function retirementScan(now: Date): CombinedSignalScan {
  return {
    signal: null,
    signals: [],
    horizons: [],
    scannedMarkets: 0,
    structuredMarkets: 0,
    horizonEligibleMarkets: 0,
    groupedEvents: 0,
    priceReadyEvents: 0,
    eligibleEvents: 0,
    nextWindowAt: null,
    closestHoursToEnd: null,
    reason: `旧実験の未決済を期限まで監視中 (${now.toISOString()})`,
  };
}

console.log(`15-minute direction experiment running every ${intervalMs}ms without backfill`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
