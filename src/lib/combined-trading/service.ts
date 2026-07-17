import type { CombinedShadowPosition, CombinedShadowRun } from "@prisma/client";

import { executeHyperliquidTestnetOrder, getHyperliquidExecutionReadiness } from "@/src/lib/combined-trading/hyperliquid-execution";
import { scanCombinedLiveSignal, type CombinedLiveSignal } from "@/src/lib/combined-trading/live-signal";
import type { ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";
import { prisma } from "@/src/lib/server/prisma";

export type CombinedShadowConfig = {
  initialEquity: number;
  minimumSignalZ: number;
  positionPct: number;
  maxPositionNotional: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
};

const defaultConfig: CombinedShadowConfig = {
  initialEquity: 10_000,
  minimumSignalZ: 0.5,
  positionPct: 0.1,
  maxPositionNotional: 1_000,
  maxConcurrentPositions: 1,
  maxDailyLossPct: 0.02,
  maxDrawdownPct: 0.05,
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
};

export async function ensureCombinedShadowRun(configOverride: Partial<CombinedShadowConfig> = {}) {
  const existing = await prisma.combinedShadowRun.findFirst({ where: { status: "running" }, orderBy: { startedAt: "desc" } });
  if (existing) return existing;
  const config = normalizeConfig(configOverride);
  return prisma.combinedShadowRun.create({
    data: {
      id: crypto.randomUUID(),
      status: "running",
      initialEquity: config.initialEquity,
      cash: config.initialEquity,
      equity: config.initialEquity,
      peakEquity: config.initialEquity,
      configJson: JSON.stringify(config),
      riskStatus: "NORMAL",
    },
  });
}

export async function tickCombinedShadowRun(runId?: string, now = new Date()) {
  let run = runId
    ? await prisma.combinedShadowRun.findUniqueOrThrow({ where: { id: runId } })
    : await ensureCombinedShadowRun();
  if (run.status !== "running") throw new Error(`combined shadow run is ${run.status}`);
  const config = normalizeConfig(parseJson<Partial<CombinedShadowConfig>>(run.configJson) ?? {});
  let positions = await prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } });
  let prices = await latestPrices(positions.map((position) => position.asset));

  for (const position of positions) {
    const markPrice = prices.get(position.asset);
    if (markPrice) await prisma.combinedShadowPosition.update({ where: { id: position.id }, data: { markPrice } });
  }
  positions = await prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } });

  let positionsPnl = openPositionsPnl(positions, prices, config, now);
  let equity = run.cash + positionsPnl;
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const firstToday = await prisma.combinedShadowEquitySnapshot.findFirst({ where: { runId: run.id, capturedAt: { gte: startOfDay } }, orderBy: { capturedAt: "asc" } });
  const dayStartEquity = firstToday?.equity ?? equity;
  const dailyReturnPct = dayStartEquity > 0 ? equity / dayStartEquity - 1 : 0;
  const currentDrawdown = run.peakEquity > 0 ? Math.max(0, (run.peakEquity - equity) / run.peakEquity) : 0;
  const environmentStop = process.env.COMBINED_KILL_SWITCH === "1";
  const riskReason = environmentStop || run.emergencyStopped
    ? "緊急停止が有効です"
    : dailyReturnPct <= -config.maxDailyLossPct
      ? `日次損失が${formatPct(config.maxDailyLossPct)}に達しました`
      : currentDrawdown >= config.maxDrawdownPct
        ? `最大下落が${formatPct(config.maxDrawdownPct)}に達しました`
        : null;

  const closeReasons = new Map<string, string>();
  for (const position of positions) {
    if (riskReason) closeReasons.set(position.id, riskReason);
    else if (position.exitAt.getTime() <= now.getTime()) closeReasons.set(position.id, "予測市場の判定時刻に到達");
  }
  for (const position of positions) {
    const reason = closeReasons.get(position.id);
    const markPrice = prices.get(position.asset);
    if (!reason || !markPrice) continue;
    const result = await closeShadowPosition(run, position, markPrice, reason, config, now);
    run = result.run;
  }

  positions = await prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } });
  prices = await latestPrices(positions.map((position) => position.asset));
  positionsPnl = openPositionsPnl(positions, prices, config, now);
  equity = run.cash + positionsPnl;

  const scan = await scanCombinedLiveSignal(now);
  let action = "WAIT";
  let reason = scan.reason;
  if (riskReason) {
    action = "BLOCKED";
    reason = riskReason;
  } else if (positions.length >= config.maxConcurrentPositions) {
    action = "HOLD";
    reason = `${positions.length}件の仮想ポジションを保有中`;
  } else if (!scan.signal) {
    action = "NO_SIGNAL";
  } else if (Math.abs(scan.signal.signalZ) < config.minimumSignalZ) {
    action = "WAIT";
    reason = `シグナル強度${Math.abs(scan.signal.signalZ).toFixed(2)}が基準${config.minimumSignalZ.toFixed(2)}未満`;
  } else {
    const alreadyObserved = await prisma.combinedShadowPosition.findFirst({ where: { runId: run.id, eventId: scan.signal.eventId } });
    if (alreadyObserved) {
      action = "SKIP";
      reason = "同じ予測テーマはすでに検証済み";
    } else {
      const opened = await openShadowPosition(run, scan.signal, equity, config, now);
      run = opened.run;
      positions.push(opened.position);
      prices.set(opened.position.asset, scan.signal.spotPrice);
      await maybeMirrorTestnetOrder(run, opened.position, "OPEN", scan.signal.spotPrice);
      action = scan.signal.side === "LONG" ? "OPEN_LONG" : "OPEN_SHORT";
      reason = `${scan.signal.asset}を${scan.signal.side === "LONG" ? "ロング" : "ショート"}で仮想発注`;
    }
  }

  positions = await prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } });
  prices = await latestPrices(positions.map((position) => position.asset));
  if (scan.signal) prices.set(scan.signal.asset, prices.get(scan.signal.asset) ?? scan.signal.spotPrice);
  positionsPnl = openPositionsPnl(positions, prices, config, now);
  equity = run.cash + positionsPnl;
  const peakEquity = Math.max(run.peakEquity, equity);
  const drawdownPct = peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : 0;
  const finalDailyReturnPct = dayStartEquity > 0 ? equity / dayStartEquity - 1 : 0;
  const riskStatus = riskReason
    ? environmentStop || run.emergencyStopped ? "EMERGENCY_STOP" : "RISK_PAUSED"
    : "NORMAL";
  const decision = {
    action,
    reason,
    signal: scan.signal,
    scannedMarkets: scan.scannedMarkets,
    eligibleEvents: scan.eligibleEvents,
    threshold: config.minimumSignalZ,
    observedAt: now.toISOString(),
  };

  await prisma.combinedShadowDecision.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      eventId: scan.signal?.eventId ?? null,
      marketId: scan.signal?.marketId ?? null,
      asset: scan.signal?.asset ?? null,
      action,
      reason,
      probability: scan.signal?.marketProbability ?? null,
      spotPrice: scan.signal?.spotPrice ?? null,
      targetPrice: scan.signal?.impliedTarget ?? null,
      signalZ: scan.signal?.signalZ ?? null,
      threshold: config.minimumSignalZ,
      observedAt: now,
    },
  });
  await prisma.combinedShadowEquitySnapshot.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      cash: run.cash,
      positionsPnl,
      equity,
      drawdownPct,
      dailyReturnPct: finalDailyReturnPct,
      capturedAt: now,
    },
  });
  run = await prisma.combinedShadowRun.update({
    where: { id: run.id },
    data: {
      equity,
      peakEquity,
      maxDrawdownPct: Math.max(run.maxDrawdownPct, drawdownPct),
      riskStatus,
      lastDecisionJson: JSON.stringify(decision),
    },
  });
  return getCombinedShadowStatus(run.id);
}

export async function getCombinedShadowStatus(runId?: string) {
  const run = runId
    ? await prisma.combinedShadowRun.findUnique({ where: { id: runId } })
    : await prisma.combinedShadowRun.findFirst({ orderBy: { startedAt: "desc" } });
  if (!run) return null;
  const [latestDecision, latestSnapshot, openPositions, closedPositions, winningPositions] = await Promise.all([
    prisma.combinedShadowDecision.findFirst({ where: { runId: run.id }, orderBy: { observedAt: "desc" } }),
    prisma.combinedShadowEquitySnapshot.findFirst({ where: { runId: run.id }, orderBy: { capturedAt: "desc" } }),
    prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } }),
    prisma.combinedShadowPosition.count({ where: { runId: run.id, status: "CLOSED" } }),
    prisma.combinedShadowPosition.count({ where: { runId: run.id, status: "CLOSED", realizedPnl: { gt: 0 } } }),
  ]);
  return {
    ...run,
    config: parseJson<CombinedShadowConfig>(run.configJson),
    lastDecision: latestDecision,
    latestSnapshot,
    openPositions,
    closedTrades: closedPositions,
    winningTrades: winningPositions,
    returnPct: run.initialEquity > 0 ? run.equity / run.initialEquity - 1 : null,
  };
}

export async function setCombinedShadowEmergencyStop(stopped: boolean) {
  const run = await ensureCombinedShadowRun();
  await prisma.combinedShadowRun.update({ where: { id: run.id }, data: { emergencyStopped: stopped } });
  return tickCombinedShadowRun(run.id);
}

async function openShadowPosition(run: CombinedShadowRun, signal: CombinedLiveSignal, equity: number, config: CombinedShadowConfig, now: Date) {
  const sideMultiplier = signal.side === "LONG" ? 1 : -1;
  const entryPrice = signal.spotPrice * (1 + sideMultiplier * config.slippagePerSide);
  const notional = Math.max(0, Math.min(equity * config.positionPct, config.maxPositionNotional));
  const quantity = notional / entryPrice;
  const entryFee = notional * config.takerFeePerSide;
  const positionId = crypto.randomUUID();
  const position = await prisma.combinedShadowPosition.create({
    data: {
      id: positionId,
      runId: run.id,
      eventId: signal.eventId,
      marketId: signal.marketId,
      asset: signal.asset,
      side: signal.side,
      quantity,
      entryPrice,
      markPrice: signal.spotPrice,
      impliedTarget: signal.impliedTarget,
      signalZ: signal.signalZ,
      entryFee,
      status: "OPEN",
      openedAt: now,
      exitAt: new Date(signal.exitAt),
    },
  });
  await prisma.combinedExecutionOrder.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      positionId,
      environment: "SHADOW",
      clientOrderId: shadowClientOrderId(run.id, positionId, "OPEN"),
      asset: signal.asset,
      side: signal.side,
      action: "OPEN",
      quantity,
      referencePrice: signal.spotPrice,
      status: "FILLED",
      reason: `signalZ=${signal.signalZ.toFixed(4)} target=${signal.impliedTarget.toFixed(2)}`,
    },
  });
  const updatedRun = await prisma.combinedShadowRun.update({ where: { id: run.id }, data: { cash: run.cash - entryFee } });
  return { run: updatedRun, position };
}

async function closeShadowPosition(
  run: CombinedShadowRun,
  position: CombinedShadowPosition,
  markPrice: number,
  reason: string,
  config: CombinedShadowConfig,
  now: Date,
) {
  const { grossPnl, exitFee, funding, realizedPnl } = calculateCombinedClose({
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    markPrice,
    entryFee: position.entryFee,
    openedAt: position.openedAt,
    now,
    takerFeePerSide: config.takerFeePerSide,
    slippagePerSide: config.slippagePerSide,
    fundingPer24h: config.fundingPer24h,
  });
  await prisma.combinedShadowPosition.update({
    where: { id: position.id },
    data: { markPrice, accruedFunding: funding, realizedPnl, status: "CLOSED", closedAt: now, closeReason: reason },
  });
  await prisma.combinedExecutionOrder.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      positionId: position.id,
      environment: "SHADOW",
      clientOrderId: shadowClientOrderId(run.id, position.id, "CLOSE"),
      asset: position.asset,
      side: position.side,
      action: "CLOSE",
      quantity: position.quantity,
      referencePrice: markPrice,
      status: "FILLED",
      reason,
    },
  });
  const updatedRun = await prisma.combinedShadowRun.update({
    where: { id: run.id },
    data: { cash: run.cash + grossPnl - exitFee - funding, realizedPnl: run.realizedPnl + realizedPnl },
  });
  await maybeMirrorTestnetOrder(updatedRun, position, "CLOSE", markPrice);
  return { run: updatedRun, realizedPnl };
}

async function maybeMirrorTestnetOrder(run: CombinedShadowRun, position: CombinedShadowPosition, action: "OPEN" | "CLOSE", referencePrice: number) {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready || !readiness.autoMirrorEnabled) return;
  if (action === "OPEN") {
    if (run.emergencyStopped || run.riskStatus !== "NORMAL") return;
    const latestEvaluation = await prisma.modelEvaluationRun.findFirst({ where: { status: "completed" }, orderBy: { completedAt: "desc" } });
    const metrics = parseJson<ModelEvaluationMetrics>(latestEvaluation?.metricsJson ?? null);
    const qualified = metrics?.quality.status === "promising"
      && metrics.combinedTrading?.selectedStrategy.id !== "no-trade guard"
      && metrics.combinedTrading?.statisticallyPositive === true;
    if (!qualified) return;
  }
  const existing = await prisma.combinedExecutionOrder.findFirst({ where: { positionId: position.id, environment: "TESTNET", action } });
  if (existing) return;
  let mirroredOpenQuantity: number | null = null;
  if (action === "CLOSE") {
    const opened = await prisma.combinedExecutionOrder.findFirst({ where: { positionId: position.id, environment: "TESTNET", action: "OPEN", status: "ACCEPTED" } });
    if (!opened) return;
    mirroredOpenQuantity = opened.quantity;
  }

  const clientOrderId = crypto.randomUUID();
  const maximumQuantity = readiness.maximumNotionalUsd / referencePrice;
  const quantity = action === "CLOSE" ? mirroredOpenQuantity as number : Math.min(position.quantity, maximumQuantity);
  const order = await prisma.combinedExecutionOrder.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      positionId: position.id,
      environment: "TESTNET",
      clientOrderId,
      asset: position.asset,
      side: position.side,
      action,
      quantity,
      referencePrice,
      status: "SUBMITTED",
      reason: "qualified model auto-mirror",
    },
  });
  try {
    const response = await executeHyperliquidTestnetOrder({
      action: action === "OPEN" ? "open" : "close",
      asset: position.asset as "BTC" | "ETH" | "SOL" | "XRP",
      isBuy: action === "OPEN" ? position.side === "LONG" : position.side === "SHORT",
      size: quantity,
      referencePrice,
      clientOrderId,
    });
    await prisma.combinedExecutionOrder.update({ where: { id: order.id }, data: { status: "ACCEPTED", responseJson: JSON.stringify(response.result ?? null) } });
  } catch (error) {
    await prisma.combinedExecutionOrder.update({ where: { id: order.id }, data: { status: "REJECTED", reason: error instanceof Error ? error.message : "testnet order failed" } });
  }
}

async function latestPrices(assets: string[]) {
  const prices = new Map<string, number>();
  for (const asset of Array.from(new Set(assets))) {
    const latest = await prisma.hyperliquidSnapshot.findFirst({ where: { asset }, orderBy: { capturedAt: "desc" } });
    if (latest?.midPrice) prices.set(asset, latest.midPrice);
  }
  return prices;
}

function openPositionsPnl(positions: CombinedShadowPosition[], prices: Map<string, number>, config: CombinedShadowConfig, now: Date) {
  return positions.reduce((sum, position) => {
    const markPrice = prices.get(position.asset) ?? position.markPrice;
    const close = calculateCombinedClose({
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      markPrice,
      entryFee: position.entryFee,
      openedAt: position.openedAt,
      now,
      takerFeePerSide: config.takerFeePerSide,
      slippagePerSide: config.slippagePerSide,
      fundingPer24h: config.fundingPer24h,
    });
    return sum + close.realizedPnl + position.entryFee;
  }, 0);
}

export function calculateCombinedClose(input: {
  side: string;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  entryFee: number;
  openedAt: Date;
  now: Date;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
}) {
  const sideMultiplier = input.side === "LONG" ? 1 : -1;
  const exitPrice = input.markPrice * (1 - sideMultiplier * input.slippagePerSide);
  const grossPnl = sideMultiplier * input.quantity * (exitPrice - input.entryPrice);
  const exitFee = input.quantity * exitPrice * input.takerFeePerSide;
  const holdingDays = Math.max(0, input.now.getTime() - input.openedAt.getTime()) / (24 * 60 * 60 * 1_000);
  const funding = input.quantity * input.entryPrice * input.fundingPer24h * holdingDays;
  return {
    exitPrice,
    grossPnl,
    exitFee,
    funding,
    realizedPnl: grossPnl - input.entryFee - exitFee - funding,
  };
}

function normalizeConfig(override: Partial<CombinedShadowConfig>) {
  return {
    initialEquity: positive(override.initialEquity, defaultConfig.initialEquity),
    minimumSignalZ: clamp(override.minimumSignalZ ?? defaultConfig.minimumSignalZ, 0.1, 3),
    positionPct: clamp(override.positionPct ?? defaultConfig.positionPct, 0.01, 0.2),
    maxPositionNotional: positive(override.maxPositionNotional, defaultConfig.maxPositionNotional),
    maxConcurrentPositions: Math.max(1, Math.min(3, Math.floor(override.maxConcurrentPositions ?? defaultConfig.maxConcurrentPositions))),
    maxDailyLossPct: clamp(override.maxDailyLossPct ?? defaultConfig.maxDailyLossPct, 0.005, 0.05),
    maxDrawdownPct: clamp(override.maxDrawdownPct ?? defaultConfig.maxDrawdownPct, 0.01, 0.1),
    takerFeePerSide: clamp(override.takerFeePerSide ?? defaultConfig.takerFeePerSide, 0, 0.01),
    slippagePerSide: clamp(override.slippagePerSide ?? defaultConfig.slippagePerSide, 0, 0.02),
    fundingPer24h: clamp(override.fundingPer24h ?? defaultConfig.fundingPer24h, 0, 0.02),
  } satisfies CombinedShadowConfig;
}

function shadowClientOrderId(runId: string, positionId: string, action: string) {
  return `shadow-${runId.slice(0, 8)}-${positionId.slice(0, 8)}-${action.toLowerCase()}`;
}

function parseJson<T>(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function positive(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
