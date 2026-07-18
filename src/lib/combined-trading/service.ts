import type { CombinedShadowPosition, CombinedShadowRun } from "@prisma/client";

import {
  cancelOutstandingHyperliquidTestnetOrders,
  executeHyperliquidTestnetOrder,
  flattenHyperliquidTestnetPositions,
  getHyperliquidExecutionReadiness,
  HyperliquidDefinitiveOrderError,
  reconcileHyperliquidTestnetOrders,
} from "@/src/lib/combined-trading/hyperliquid-execution";
import {
  scanCombinedLiveSignal,
  selectCombinedSignalScan,
  type CombinedLiveSignal,
  type CombinedSignalScan,
} from "@/src/lib/combined-trading/live-signal";
import { isForwardControlExperimentKey, isForwardStrategyExperimentKey } from "@/src/lib/combined-trading/forward-evaluation";
import {
  isShortTermDirectionExperimentKey,
  scanShortTermDirectionSignal,
} from "@/src/lib/combined-trading/short-term-direction";
import { calculatePriceBasisPct, fetchPolymarketReferencePrices, selectReferencePrice } from "@/src/lib/combined-trading/polymarket-reference";
import type { ModelEvaluationMetrics } from "@/src/lib/model-evaluation/types";
import { fetchHyperliquidMarketStates } from "@/src/lib/monitoring/hyperliquid";
import { prisma } from "@/src/lib/server/prisma";

export type CombinedShadowConfig = {
  experimentKey: string;
  experimentLabel: string;
  forwardOnly: boolean;
  observationHorizonHours: number | null;
  initialEquity: number;
  minimumSignalZ: number;
  minimumTrendZ: number;
  minimumFunding24h: number;
  signalRule: "polymarket-only" | "trend-confirmed" | "contrarian" | "hyperliquid-momentum" | "hyperliquid-reversion" | "hyperliquid-funding-carry" | "hyperliquid-funding-momentum" | "polymarket-funding-consensus";
  modelVersion: string | null;
  specificationHash: string | null;
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
  experimentKey: "legacy-shadow-v1",
  experimentLabel: "従来の組み合わせ検証",
  forwardOnly: false,
  observationHorizonHours: null,
  initialEquity: 10_000,
  minimumSignalZ: 0.5,
  minimumTrendZ: 0.1,
  minimumFunding24h: 0.0003,
  signalRule: "polymarket-only",
  modelVersion: null,
  specificationHash: null,
  positionPct: 0.1,
  maxPositionNotional: 1_000,
  maxConcurrentPositions: 1,
  maxDailyLossPct: 0.02,
  maxDrawdownPct: 0.05,
  takerFeePerSide: 0.00045,
  slippagePerSide: 0.0002,
  fundingPer24h: 0.0003,
};

export async function getQualifiedModelShadowConfig(): Promise<Partial<CombinedShadowConfig> | null> {
  const latestEvaluation = await prisma.modelEvaluationRun.findFirst({ where: { status: "completed" }, orderBy: { completedAt: "desc" } });
  const metrics = parseJson<ModelEvaluationMetrics>(latestEvaluation?.metricsJson ?? null);
  const strategy = metrics?.combinedTrading?.selectedStrategy;
  if (
    metrics?.quality.status !== "promising"
    || !strategy
    || strategy.id === "no-trade guard"
    || metrics.combinedTrading.statisticallyPositive !== true
    || !isExecutableSignalRule(strategy.signalRule)
  ) return null;
  return {
    minimumSignalZ: strategy.minimumSignalZ,
    minimumTrendZ: strategy.minimumTrendZ,
    minimumFunding24h: strategy.minimumFunding24h,
    signalRule: strategy.signalRule,
    positionPct: strategy.positionPct,
    modelVersion: metrics.modelVersion,
  };
}

export async function ensureCombinedShadowRun(configOverride: Partial<CombinedShadowConfig> = {}) {
  const config = normalizeConfig(configOverride);
  const runningRuns = await prisma.combinedShadowRun.findMany({ where: { status: "running" }, orderBy: { startedAt: "desc" } });
  const existing = runningRuns.find((run) => (
    normalizeConfig(parseJson<Partial<CombinedShadowConfig>>(run.configJson) ?? {}).experimentKey === config.experimentKey
  ));
  if (existing) {
    const existingConfig = normalizeConfig(parseJson<Partial<CombinedShadowConfig>>(existing.configJson) ?? {});
    validateFrozenExperimentConfig(existingConfig, config);
    return existing;
  }
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

export async function tickCombinedShadowRun(
  runId?: string,
  now = new Date(),
  precomputedScan?: CombinedSignalScan,
  precomputedPrices?: Map<string, number>,
) {
  let run = runId
    ? await prisma.combinedShadowRun.findUniqueOrThrow({ where: { id: runId } })
    : await ensureCombinedShadowRun();
  if (run.status !== "running") throw new Error(`combined shadow run is ${run.status}`);
  const config = normalizeConfig(parseJson<Partial<CombinedShadowConfig>>(run.configJson) ?? {});
  let positions = await prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } });
  let prices = await latestPrices(positions.map((position) => position.asset), precomputedPrices);

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
  prices = await latestPrices(positions.map((position) => position.asset), precomputedPrices);
  positionsPnl = openPositionsPnl(positions, prices, config, now);
  equity = run.cash + positionsPnl;

  const fullScan = precomputedScan ?? await scanCombinedLiveSignal(now);
  const scan = config.observationHorizonHours === null
    ? fullScan
    : selectCombinedSignalScan(fullScan, config.observationHorizonHours);
  const observedPositions = scan.signals.length
    ? await prisma.combinedShadowPosition.findMany({
        where: { runId: run.id },
        select: { eventId: true, horizonHours: true },
      })
    : [];
  const selection = selectCombinedSignalCandidate(
    scan.signals,
    config,
    new Set(observedPositions.map((position) => signalEventKey(position.eventId, position.horizonHours))),
  );
  const signal = selection?.signal ?? null;
  const executableSignal = selection?.executableSignal ?? null;
  let action = "WAIT";
  let reason = scan.reason;
  if (riskReason) {
    action = "BLOCKED";
    reason = riskReason;
  } else if (positions.length >= config.maxConcurrentPositions) {
    action = "HOLD";
    reason = `${positions.length}件の仮想ポジションを保有中`;
  } else if (!signal) {
    action = "NO_SIGNAL";
  } else if (!selection?.actionable) {
    action = selection?.alreadyObserved ? "SKIP" : "WAIT";
    reason = selection?.reason ?? scan.reason;
  } else {
    const opened = await openShadowPosition(run, signal, executableSignal as CombinedLiveSignal, equity, config, now);
    run = opened.run;
    positions.push(opened.position);
    prices.set(opened.position.asset, signal.spotPrice);
    await maybeMirrorTestnetOrder(run, opened.position, "OPEN", signal.spotPrice);
    action = executableSignal?.side === "LONG" ? "OPEN_LONG" : "OPEN_SHORT";
    reason = `${signal.asset}・${formatSignalHorizon(signal.horizonHours)}を${executableSignal?.side === "LONG" ? "ロング" : "ショート"}で仮想発注`;
  }

  positions = await prisma.combinedShadowPosition.findMany({ where: { runId: run.id, status: "OPEN" }, orderBy: { openedAt: "asc" } });
  prices = await latestPrices(positions.map((position) => position.asset), precomputedPrices);
  if (signal) prices.set(signal.asset, prices.get(signal.asset) ?? signal.spotPrice);
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
    signal: executableSignal,
    scannedMarkets: scan.scannedMarkets,
    eligibleEvents: scan.eligibleEvents,
    threshold: config.minimumSignalZ,
    observedAt: now.toISOString(),
  };

  await prisma.combinedShadowDecision.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      eventId: signal?.eventId ?? null,
      marketId: signal?.marketId ?? null,
      asset: signal?.asset ?? null,
      action,
      reason,
      probability: signal?.marketProbability ?? null,
      spotPrice: signal?.spotPrice ?? null,
      targetPrice: signal?.impliedTarget ?? null,
      signalZ: signal?.signalZ ?? null,
      polymarketSide: signal?.side ?? null,
      strategySide: isFundingSignalRule(config.signalRule) && signal?.hyperliquidFunding24h === null
        ? null
        : executableSignal?.side ?? null,
      trendZ6h: signal?.trendZ6h ?? null,
      hyperliquidFunding24h: signal?.hyperliquidFunding24h ?? null,
      threshold: config.minimumSignalZ,
      horizonHours: signal?.horizonHours ?? config.observationHorizonHours,
      scannedMarkets: scan.scannedMarkets,
      structuredMarkets: scan.structuredMarkets,
      horizonEligibleMarkets: scan.horizonEligibleMarkets,
      groupedEvents: scan.groupedEvents,
      priceReadyEvents: scan.priceReadyEvents,
      marketBestBid: signal?.marketBestBid ?? null,
      marketBestAsk: signal?.marketBestAsk ?? null,
      marketSpread: signal?.marketSpread ?? null,
      polymarketReferencePrice: signal?.polymarketReferencePrice ?? null,
      referenceSource: signal?.referenceSource ?? null,
      referenceCapturedAt: signal?.referenceCapturedAt ? new Date(signal.referenceCapturedAt) : null,
      priceBasisPct: signal?.priceBasisPct ?? null,
      ladderViolations: signal?.ladderViolations ?? null,
      nextWindowAt: scan.nextWindowAt ? new Date(scan.nextWindowAt) : null,
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
    : await findPrimaryForwardRun();
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
  const runs = await findActiveForwardRuns();
  if (!runs.length) throw new Error("固定フォワード検証が起動していません");
  const readiness = getHyperliquidExecutionReadiness();
  const trackedTestnetOrders = await prisma.combinedExecutionOrder.count({ where: { environment: "TESTNET" } });
  const testnetVerificationRequired = readiness.accountConfigured
    || readiness.apiWalletConfigured
    || readiness.enabled
    || trackedTestnetOrders > 0;
  if (!stopped && testnetVerificationRequired) {
    if (!readiness.ready) {
      throw new Error("テストネットを確認できないため再開できません。口座・APIウォレット・有効化設定を復元してください");
    }
    const reconciliation = await reconcileHyperliquidTestnetOrders();
    const hasExposure = reconciliation.openOrders.length > 0
      || reconciliation.positions.some((position) => Math.abs(position.size ?? 0) > 1e-8)
      || reconciliation.orderMismatches.length > 0
      || reconciliation.positionMismatches.length > 0;
    if (hasExposure) throw new Error("テストネットに未約定注文、建玉、または照合不一致があるため再開できません");
  }
  await prisma.combinedShadowRun.updateMany({
    where: { id: { in: runs.map((run) => run.id) } },
    data: { emergencyStopped: stopped },
  });
  if (stopped && testnetVerificationRequired) {
    if (!readiness.ready) {
      throw new Error("緊急停止は有効ですが、テストネット口座を確認できません。資格情報を復元して取消と建玉解消を確認してください");
    }
    let cancellationIssue: string | null = null;
    let flattenIssue: string | null = null;
    try {
      const cancellation = await cancelOutstandingHyperliquidTestnetOrders();
      if (!cancellation.verified || cancellation.failed > 0 || cancellation.remainingOpenOrders.length > 0) {
        cancellationIssue = `未約定注文: 取消失敗${cancellation.failed}件・残存${cancellation.remainingOpenOrders.length}件`;
      }
    } catch (error) {
      cancellationIssue = `未約定注文: ${error instanceof Error ? error.message : "取消処理に失敗"}`;
    }
    try {
      const flatten = await flattenHyperliquidTestnetPositions();
      if (!flatten.verified || flatten.failed > 0 || flatten.remainingPositions.length > 0) {
        flattenIssue = `保有: 解消失敗${flatten.failed}件・残存${flatten.remainingPositions.length}件`;
      }
    } catch (error) {
      flattenIssue = `保有: ${error instanceof Error ? error.message : "解消処理に失敗"}`;
    }
    const issues = [cancellationIssue, flattenIssue].filter(Boolean);
    if (issues.length) throw new Error(`テストネット緊急停止の再照合に失敗しました（${issues.join(" / ")}）`);
  }
  return tickActiveForwardRuns();
}

export async function tickActiveForwardRuns(now = new Date()) {
  const runs = await findActiveForwardRuns();
  if (!runs.length) throw new Error("固定フォワード検証が起動していません");
  const [longHorizonScan, shortTermScan, markPrices] = await Promise.all([
    scanCombinedLiveSignal(now),
    runs.some((run) => isShortTermDirectionExperimentKey(parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.experimentKey))
      ? scanShortTermDirectionSignal(now)
      : Promise.resolve(null),
    loadCombinedMarkPrices(now),
  ]);
  const statuses = [];
  for (const run of runs) {
    const key = parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.experimentKey;
    statuses.push(await tickCombinedShadowRun(
      run.id,
      now,
      isShortTermDirectionExperimentKey(key) && shortTermScan ? shortTermScan : longHorizonScan,
      markPrices,
    ));
  }
  return statuses;
}

async function findActiveForwardRuns() {
  const runs = await prisma.combinedShadowRun.findMany({ where: { status: "running" }, orderBy: { startedAt: "desc" } });
  return runs.filter((run) => {
    const key = parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.experimentKey;
    return isForwardStrategyExperimentKey(key)
      || isForwardControlExperimentKey(key)
      || isShortTermDirectionExperimentKey(key);
  });
}

async function findPrimaryForwardRun() {
  const runs = await prisma.combinedShadowRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 });
  return runs.find((run) => isForwardStrategyExperimentKey(parseJson<Partial<CombinedShadowConfig>>(run.configJson)?.experimentKey))
    ?? runs[0]
    ?? null;
}

async function openShadowPosition(
  run: CombinedShadowRun,
  marketSignal: CombinedLiveSignal,
  executableSignal: CombinedLiveSignal,
  equity: number,
  config: CombinedShadowConfig,
  now: Date,
) {
  const sideMultiplier = executableSignal.side === "LONG" ? 1 : -1;
  const entryPrice = marketSignal.spotPrice * (1 + sideMultiplier * config.slippagePerSide);
  const notional = Math.max(0, Math.min(equity * config.positionPct, config.maxPositionNotional));
  const quantity = notional / entryPrice;
  const entryFee = notional * config.takerFeePerSide;
  const positionId = crypto.randomUUID();
  const position = await prisma.combinedShadowPosition.create({
    data: {
      id: positionId,
      runId: run.id,
      eventId: marketSignal.eventId,
      marketId: marketSignal.marketId,
      asset: marketSignal.asset,
      side: executableSignal.side,
      quantity,
      entryPrice,
      markPrice: marketSignal.spotPrice,
      impliedTarget: marketSignal.impliedTarget,
      signalZ: marketSignal.signalZ,
      polymarketSide: marketSignal.side,
      entrySpotPrice: marketSignal.spotPrice,
      entryTrendZ6h: marketSignal.trendZ6h,
      entryFunding24h: marketSignal.hyperliquidFunding24h,
      horizonHours: marketSignal.horizonHours,
      priceBasisPct: marketSignal.priceBasisPct,
      entryReferencePrice: marketSignal.polymarketReferencePrice,
      entryReferenceSource: marketSignal.referenceSource,
      entryReferenceCapturedAt: marketSignal.referenceCapturedAt ? new Date(marketSignal.referenceCapturedAt) : null,
      entryFee,
      status: "OPEN",
      openedAt: now,
      exitAt: new Date(marketSignal.exitAt),
    },
  });
  await prisma.combinedExecutionOrder.create({
    data: {
      id: crypto.randomUUID(),
      runId: run.id,
      positionId,
      environment: "SHADOW",
      clientOrderId: shadowClientOrderId(run.id, positionId, "OPEN"),
      asset: marketSignal.asset,
      side: executableSignal.side,
      action: "OPEN",
      quantity,
      referencePrice: marketSignal.spotPrice,
      status: "FILLED",
      reason: `rule=${config.signalRule} signalZ=${marketSignal.signalZ.toFixed(4)} target=${marketSignal.impliedTarget.toFixed(2)}`,
    },
  });
  const updatedRun = await prisma.combinedShadowRun.update({ where: { id: run.id }, data: { cash: run.cash - entryFee } });
  return { run: updatedRun, position };
}

export function applyCombinedSignalRule(signal: CombinedLiveSignal, rule: CombinedShadowConfig["signalRule"]): CombinedLiveSignal {
  if (rule === "contrarian") return { ...signal, side: signal.side === "LONG" ? "SHORT" : "LONG" };
  if (isHyperliquidSignalRule(rule)) {
    const momentumSide = signal.trendZ6h >= 0 ? "LONG" : "SHORT";
    return {
      ...signal,
      side: rule === "hyperliquid-reversion" ? (momentumSide === "LONG" ? "SHORT" : "LONG") : momentumSide,
    };
  }
  if (isFundingSignalRule(rule)) {
    const fundingSide = (signal.hyperliquidFunding24h ?? 0) >= 0 ? "LONG" : "SHORT";
    return {
      ...signal,
      side: rule === "hyperliquid-funding-momentum" ? fundingSide : (fundingSide === "LONG" ? "SHORT" : "LONG"),
    };
  }
  return signal;
}

export function selectCombinedSignalCandidate(
  signals: CombinedLiveSignal[],
  config: Pick<CombinedShadowConfig, "minimumSignalZ" | "minimumTrendZ" | "minimumFunding24h" | "signalRule">,
  observedEvents = new Set<string>(),
) {
  const evaluated = [...signals]
    .sort((left, right) => Math.abs(right.signalZ) - Math.abs(left.signalZ))
    .map((signal) => {
      const executableSignal = applyCombinedSignalRule(signal, config.signalRule);
      return {
        signal,
        executableSignal,
        rejectionReason: combinedSignalRejectionReason(signal, executableSignal, config),
        alreadyObserved: observedEvents.has(signalEventKey(signal.eventId, signal.horizonHours)),
      };
    });
  const actionable = evaluated.find((candidate) => !candidate.rejectionReason && !candidate.alreadyObserved);
  if (actionable) return { ...actionable, actionable: true as const, reason: null };
  const eligible = evaluated.find((candidate) => !candidate.rejectionReason);
  if (eligible) return {
    ...eligible,
    actionable: false as const,
    alreadyObserved: true,
    reason: "同じ予測テーマと時間軸はすでに検証済み",
  };
  const rejected = evaluated[0];
  return rejected ? {
    ...rejected,
    actionable: false as const,
    reason: rejected.rejectionReason,
  } : null;
}

function combinedSignalRejectionReason(
  signal: CombinedLiveSignal,
  executableSignal: CombinedLiveSignal,
  config: Pick<CombinedShadowConfig, "minimumSignalZ" | "minimumTrendZ" | "minimumFunding24h" | "signalRule">,
) {
  if (isHyperliquidSignalRule(config.signalRule) && Math.abs(signal.trendZ6h) < config.minimumTrendZ) {
    return `6時間値動き${Math.abs(signal.trendZ6h).toFixed(2)}が基準${config.minimumTrendZ.toFixed(2)}未満`;
  }
  if (config.signalRule === "trend-confirmed") {
    if (Math.abs(signal.trendZ6h) < config.minimumTrendZ) {
      return `開始後の値動き${Math.abs(signal.trendZ6h).toFixed(2)}が基準${config.minimumTrendZ.toFixed(2)}未満`;
    }
    const trendSide = signal.trendZ6h >= 0 ? "LONG" : "SHORT";
    if (trendSide !== signal.side) return "Polymarketの方向とHyperliquidの開始後トレンドが一致していません";
  }
  if (isFundingSignalRule(config.signalRule) && (signal.hyperliquidFunding24h === null || Math.abs(signal.hyperliquidFunding24h) < config.minimumFunding24h)) {
    return signal.hyperliquidFunding24h === null
      ? "24時間の資金調達率を確認中"
      : `24時間資金調達率${formatPct(Math.abs(signal.hyperliquidFunding24h))}が基準${formatPct(config.minimumFunding24h)}未満`;
  }
  if (config.signalRule === "polymarket-funding-consensus" && executableSignal.side !== signal.side) {
    return "Polymarketの方向と資金調達を受け取る方向が一致していません";
  }
  if (Math.abs(signal.signalZ) < config.minimumSignalZ) {
    return `シグナル強度${Math.abs(signal.signalZ).toFixed(2)}が基準${config.minimumSignalZ.toFixed(2)}未満`;
  }
  return null;
}

function signalEventKey(eventId: string, horizonHours: number | null | undefined) {
  return `${eventId}:${horizonHours ?? "legacy"}`;
}

async function closeShadowPosition(
  run: CombinedShadowRun,
  position: CombinedShadowPosition,
  markPrice: number,
  reason: string,
  config: CombinedShadowConfig,
  now: Date,
) {
  const settlementReference = await fetchPositionReference(position);
  const exitPriceBasisPct = settlementReference
    ? calculatePriceBasisPct(markPrice, settlementReference.price)
    : null;
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
    fundingRate24h: position.entryFunding24h,
  });
  await prisma.combinedShadowPosition.update({
    where: { id: position.id },
    data: {
      markPrice,
      accruedFunding: funding,
      realizedPnl,
      status: "CLOSED",
      closedAt: now,
      closeReason: reason,
      exitReferencePrice: settlementReference?.price ?? null,
      exitReferenceSource: settlementReference?.source ?? null,
      exitReferenceCapturedAt: settlementReference ? new Date(settlementReference.capturedAt) : null,
      exitPriceBasisPct,
    },
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

async function fetchPositionReference(position: CombinedShadowPosition) {
  if (!isReferenceAsset(position.asset)) return null;
  let preferredSource = normalizeReferenceSource(position.entryReferenceSource);
  if (preferredSource === "UNKNOWN") {
    const entryDecision = await prisma.combinedShadowDecision.findFirst({
      where: {
        runId: position.runId,
        eventId: position.eventId,
        asset: position.asset,
        referenceSource: { not: null },
        observedAt: { lte: position.openedAt },
      },
      orderBy: { observedAt: "desc" },
      select: { referenceSource: true },
    });
    preferredSource = normalizeReferenceSource(entryDecision?.referenceSource);
  }
  const prices = await fetchPolymarketReferencePrices([position.asset], 4_000).catch(() => []);
  return selectReferencePrice(prices, position.asset, preferredSource);
}

async function maybeMirrorTestnetOrder(run: CombinedShadowRun, position: CombinedShadowPosition, action: "OPEN" | "CLOSE", referencePrice: number) {
  const readiness = getHyperliquidExecutionReadiness();
  if (!readiness.ready || !readiness.autoMirrorEnabled) return;
  if (!readiness.supportedAssets.includes(position.asset)) return;
  if (action === "OPEN") {
    if (run.emergencyStopped || run.riskStatus !== "NORMAL") return;
    const latestEvaluation = await prisma.modelEvaluationRun.findFirst({ where: { status: "completed" }, orderBy: { completedAt: "desc" } });
    const metrics = parseJson<ModelEvaluationMetrics>(latestEvaluation?.metricsJson ?? null);
    const strategy = metrics?.combinedTrading?.selectedStrategy;
    const runConfig = normalizeConfig(parseJson<Partial<CombinedShadowConfig>>(run.configJson) ?? {});
    if (runConfig.forwardOnly) return;
    const qualified = metrics?.quality.status === "promising"
      && strategy?.id !== "no-trade guard"
      && metrics.combinedTrading?.statisticallyPositive === true
      && isExecutableSignalRule(strategy?.signalRule)
      && runConfig.modelVersion === metrics.modelVersion
      && runConfig.signalRule === strategy.signalRule
      && runConfig.minimumSignalZ === strategy.minimumSignalZ
      && runConfig.minimumTrendZ === strategy.minimumTrendZ
      && runConfig.minimumFunding24h === strategy.minimumFunding24h;
    if (!qualified) return;
  }
  const existing = await prisma.combinedExecutionOrder.findFirst({ where: { positionId: position.id, environment: "TESTNET", action } });
  if (existing) return;
  let mirroredOpenQuantity: number | null = null;
  if (action === "CLOSE") {
    const opened = await prisma.combinedExecutionOrder.findFirst({
      where: {
        positionId: position.id,
        environment: "TESTNET",
        action: "OPEN",
        status: { in: ["FILLED", "PARTIALLY_FILLED"] },
      },
    });
    if (!opened) return;
    mirroredOpenQuantity = opened.filledQuantity > 0 ? opened.filledQuantity : opened.quantity;
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
    await prisma.combinedExecutionOrder.update({
      where: { id: order.id },
      data: {
        status: response.evidence.status,
        exchangeOrderId: response.evidence.exchangeOrderId,
        exchangeStatus: response.evidence.exchangeStatus,
        filledQuantity: response.evidence.filledQuantity,
        averageFillPrice: response.evidence.averageFillPrice,
        feePaid: response.evidence.feePaid,
        reason: response.evidence.reason,
        responseJson: JSON.stringify(response.result ?? null),
        lastReconciledAt: new Date(),
      },
    });
  } catch (error) {
    const definitive = error instanceof HyperliquidDefinitiveOrderError;
    await prisma.combinedExecutionOrder.update({
      where: { id: order.id },
      data: {
        status: definitive ? "REJECTED" : "UNKNOWN",
        reason: error instanceof Error ? error.message : definitive ? "testnet order was rejected" : "testnet order result is unknown",
        lastReconciledAt: definitive ? new Date() : null,
      },
    });
  }
}

export async function loadCombinedMarkPrices(now = new Date()) {
  const liveStates = await fetchHyperliquidMarketStates().catch(() => []);
  if (liveStates.length) return new Map(liveStates.map((state) => [state.asset, state.midPrice]));
  const rows = await prisma.hyperliquidSnapshot.findMany({
    where: { asset: { in: ["BTC", "ETH", "SOL", "XRP"] }, capturedAt: { lte: now } },
    orderBy: { capturedAt: "desc" },
    take: 40,
  });
  const prices = new Map<string, number>();
  for (const row of rows) if (!prices.has(row.asset) && row.midPrice > 0) prices.set(row.asset, row.midPrice);
  return prices;
}

async function latestPrices(assets: string[], precomputed?: Map<string, number>) {
  const prices = new Map<string, number>();
  if (precomputed) {
    for (const asset of Array.from(new Set(assets))) {
      const price = precomputed.get(asset);
      if (price) prices.set(asset, price);
    }
    return prices;
  }
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
      fundingRate24h: position.entryFunding24h,
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
  fundingRate24h?: number | null;
}) {
  const sideMultiplier = input.side === "LONG" ? 1 : -1;
  const exitPrice = input.markPrice * (1 - sideMultiplier * input.slippagePerSide);
  const grossPnl = sideMultiplier * input.quantity * (exitPrice - input.entryPrice);
  const exitFee = input.quantity * exitPrice * input.takerFeePerSide;
  const holdingDays = Math.max(0, input.now.getTime() - input.openedAt.getTime()) / (24 * 60 * 60 * 1_000);
  const fundingRate = typeof input.fundingRate24h === "number" && Number.isFinite(input.fundingRate24h)
    ? sideMultiplier * input.fundingRate24h
    : input.fundingPer24h;
  const funding = input.quantity * input.entryPrice * fundingRate * holdingDays;
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
    experimentKey: normalizedText(override.experimentKey, defaultConfig.experimentKey),
    experimentLabel: normalizedText(override.experimentLabel, defaultConfig.experimentLabel),
    forwardOnly: override.forwardOnly === true,
    observationHorizonHours: isObservationHorizon(override.observationHorizonHours) ? override.observationHorizonHours : null,
    initialEquity: positive(override.initialEquity, defaultConfig.initialEquity),
    minimumSignalZ: clamp(override.minimumSignalZ ?? defaultConfig.minimumSignalZ, 0.1, 3),
    minimumTrendZ: clamp(override.minimumTrendZ ?? defaultConfig.minimumTrendZ, 0, 3),
    minimumFunding24h: clamp(override.minimumFunding24h ?? defaultConfig.minimumFunding24h, 0, 0.01),
    signalRule: isExecutableSignalRule(override.signalRule) ? override.signalRule : "polymarket-only",
    modelVersion: typeof override.modelVersion === "string" && override.modelVersion.trim() ? override.modelVersion.trim() : null,
    specificationHash: typeof override.specificationHash === "string" && override.specificationHash.trim()
      ? override.specificationHash.trim()
      : null,
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

export function validateFrozenExperimentConfig(existing: CombinedShadowConfig, expected: CombinedShadowConfig) {
  if (!expected.specificationHash) return "compatible" as const;
  if (existing.experimentKey !== expected.experimentKey) {
    throw new Error("frozen experiment keys do not match");
  }
  const existingWithoutHash = { ...existing, specificationHash: null };
  const expectedWithoutHash = { ...expected, specificationHash: null };
  if (JSON.stringify(existingWithoutHash) !== JSON.stringify(expectedWithoutHash)) {
    throw new Error(`fixed experiment ${expected.experimentKey} configuration changed; use a new experiment key`);
  }
  if (!existing.specificationHash) {
    throw new Error(`fixed experiment ${expected.experimentKey} has no specification hash; use a new experiment key`);
  }
  if (existing.specificationHash !== expected.specificationHash) {
    throw new Error(`fixed experiment ${expected.experimentKey} specification changed; use a new experiment key`);
  }
  return "compatible" as const;
}

function isExecutableSignalRule(rule: unknown): rule is CombinedShadowConfig["signalRule"] {
  return rule === "polymarket-only"
    || rule === "trend-confirmed"
    || rule === "contrarian"
    || rule === "hyperliquid-momentum"
    || rule === "hyperliquid-reversion"
    || rule === "hyperliquid-funding-carry"
    || rule === "hyperliquid-funding-momentum"
    || rule === "polymarket-funding-consensus";
}

function isObservationHorizon(value: unknown): value is number {
  return value === 0 || value === 6 || value === 12 || value === 24 || value === 48;
}

function isHyperliquidSignalRule(rule: CombinedShadowConfig["signalRule"]) {
  return rule === "hyperliquid-momentum" || rule === "hyperliquid-reversion";
}

function isFundingSignalRule(rule: CombinedShadowConfig["signalRule"]) {
  return rule === "hyperliquid-funding-carry"
    || rule === "hyperliquid-funding-momentum"
    || rule === "polymarket-funding-consensus";
}

function isReferenceAsset(asset: string): asset is CombinedLiveSignal["asset"] {
  return asset === "BTC" || asset === "ETH" || asset === "SOL" || asset === "XRP";
}

function normalizeReferenceSource(source: string | null | undefined): "BINANCE" | "CHAINLINK" | "UNKNOWN" {
  return source === "BINANCE" || source === "CHAINLINK" ? source : "UNKNOWN";
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

function normalizedText(value: string | undefined, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignalHorizon(horizonHours: number) {
  return horizonHours === 0 ? "15分" : `${horizonHours}時間`;
}
