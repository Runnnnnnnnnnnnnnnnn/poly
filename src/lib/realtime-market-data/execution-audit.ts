const defaultMinimumAuditedPositions = 50;
const defaultMaximumTimingErrorMs = 15_000;
const defaultMaximumPolymarketQuoteAgeMs = 2 * 60_000;
const cryptoTakerFeeRate = 0.07;

export type ExactExecutionAuditPosition = {
  marketId: string;
  asset: string;
  side: string;
  quantity: number;
  entryPrice: number;
  entryFunding24h: number | null;
  polymarketSide: string | null;
  realizedPnl: number | null;
  status: string;
  openedAt: Date;
  exitAt: Date;
  closedAt: Date | null;
};

export type ExactExecutionAuditTick = {
  marketId: string;
  asset: string;
  marketStartAt: Date;
  marketEndAt: Date;
  polymarketBestAsk: number;
  polymarketUpdatedAt: Date;
  negativeBestAsk: number;
  negativeUpdatedAt: Date;
  hyperliquidBestBid: number;
  hyperliquidBestAsk: number;
  hyperliquidUpdatedAt: Date;
  referencePrice: number;
  referenceUpdatedAt: Date;
  capturedAt: Date;
};

export type ExactExecutionAuditResolution = {
  marketId: string;
  resolved: boolean;
  result: number | null;
};

export type ExactExecutionAuditInput = {
  positions: ExactExecutionAuditPosition[];
  ticks: ExactExecutionAuditTick[];
  resolutions: ExactExecutionAuditResolution[];
  collectionStartedAt: Date | null;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
  minimumAuditedPositions?: number;
  maximumTimingErrorMs?: number;
  maximumPolymarketQuoteAgeMs?: number;
};

export type ExactExecutionAudit = ReturnType<typeof evaluateExactExecutionAudit>;

export function evaluateExactExecutionAudit(input: ExactExecutionAuditInput) {
  const maximumTimingErrorMs = input.maximumTimingErrorMs ?? defaultMaximumTimingErrorMs;
  const maximumPolymarketQuoteAgeMs = input.maximumPolymarketQuoteAgeMs ?? defaultMaximumPolymarketQuoteAgeMs;
  const minimumAuditedPositions = input.minimumAuditedPositions ?? defaultMinimumAuditedPositions;
  const eligiblePositions = input.positions.filter((position) => (
    position.status === "CLOSED"
    && position.closedAt instanceof Date
    && typeof position.realizedPnl === "number"
    && Number.isFinite(position.realizedPnl)
    && input.collectionStartedAt instanceof Date
    && position.openedAt >= input.collectionStartedAt
  ));
  const ticksByMarket = groupTicksByMarket(input.ticks);
  const resolutionsByMarket = new Map(input.resolutions.map((resolution) => [resolution.marketId, resolution]));
  const timingErrors: number[] = [];
  const polymarketQuoteAges: number[] = [];
  const closeDelays: number[] = [];
  const exactResults: Array<{ exactPnl: number; storedPnl: number; notional: number }> = [];
  const predictionResults: Array<{ correct: boolean; polymarketReturn: number | null }> = [];
  let missingEntry = 0;
  let missingExit = 0;
  let missingResolution = 0;
  let verifiedPositions = 0;

  for (const position of eligiblePositions) {
    const ticks = ticksByMarket.get(position.marketId) ?? [];
    const entry = nearestTick(ticks, position.openedAt, (tick) => tick.hyperliquidUpdatedAt, maximumTimingErrorMs);
    const exit = nearestTick(ticks, position.exitAt, (tick) => tick.hyperliquidUpdatedAt, maximumTimingErrorMs);
    if (!entry) missingEntry += 1;
    if (!exit) missingExit += 1;

    let hasExactExecution = false;
    if (entry && exit) {
      timingErrors.push(entry.errorMs, exit.errorMs);
      closeDelays.push(Math.max(0, (position.closedAt as Date).getTime() - position.exitAt.getTime()));
      const exact = calculateHyperliquidBookPnl({
        position,
        entryTick: entry.tick,
        exitTick: exit.tick,
        takerFeePerSide: input.takerFeePerSide,
        slippagePerSide: input.slippagePerSide,
        fundingPer24h: input.fundingPer24h,
      });
      if (exact) {
        hasExactExecution = true;
        exactResults.push({
          exactPnl: exact.realizedPnl,
          storedPnl: position.realizedPnl as number,
          notional: exact.notional,
        });
      }
    }

    const resolution = resolutionsByMarket.get(position.marketId);
    if (!resolution?.resolved || (resolution.result !== 0 && resolution.result !== 1)) {
      missingResolution += 1;
      continue;
    }
    const predictedSide = position.polymarketSide === "LONG" || position.polymarketSide === "SHORT"
      ? position.polymarketSide
      : position.side;
    const actualSide = resolution.result === 1 ? "LONG" : "SHORT";
    const correct = predictedSide === actualSide;
    const tokenAsk = entry?.tick
      ? predictedSide === "LONG" ? entry.tick.polymarketBestAsk : entry.tick.negativeBestAsk
      : null;
    if (entry?.tick) {
      const quoteUpdatedAt = predictedSide === "LONG" ? entry.tick.polymarketUpdatedAt : entry.tick.negativeUpdatedAt;
      polymarketQuoteAges.push(Math.max(0, entry.tick.capturedAt.getTime() - quoteUpdatedAt.getTime()));
    }
    const polymarketReturn = tokenAsk ? calculatePolymarketTokenReturn(tokenAsk, correct) : null;
    predictionResults.push({
      correct,
      polymarketReturn,
    });
    if (hasExactExecution && polymarketReturn !== null) verifiedPositions += 1;
  }

  const auditedNotional = sum(exactResults.map((result) => result.notional));
  const hyperliquidNetReturnPct = auditedNotional > 0
    ? sum(exactResults.map((result) => result.exactPnl)) / auditedNotional
    : null;
  const storedNetReturnPct = auditedNotional > 0
    ? sum(exactResults.map((result) => result.storedPnl)) / auditedNotional
    : null;
  const polymarketReturns = predictionResults.flatMap((result) => (
    result.polymarketReturn === null ? [] : [result.polymarketReturn]
  ));
  const coverage = eligiblePositions.length ? exactResults.length / eligiblePositions.length : 0;
  const verifiedCoverage = eligiblePositions.length ? verifiedPositions / eligiblePositions.length : 0;
  const maximumObservedTimingErrorMs = timingErrors.length ? Math.max(...timingErrors) : null;
  const maximumObservedPolymarketQuoteAgeMs = polymarketQuoteAges.length ? Math.max(...polymarketQuoteAges) : null;
  const enoughData = verifiedPositions >= minimumAuditedPositions;
  const qualityPassed = verifiedCoverage >= 0.95
    && maximumObservedTimingErrorMs !== null
    && maximumObservedTimingErrorMs <= maximumTimingErrorMs
    && maximumObservedPolymarketQuoteAgeMs !== null
    && maximumObservedPolymarketQuoteAgeMs <= maximumPolymarketQuoteAgeMs;

  return {
    status: enoughData ? qualityPassed ? "healthy" as const : "attention" as const : "collecting" as const,
    collectionStartedAt: input.collectionStartedAt?.toISOString() ?? null,
    minimumAuditedPositions,
    eligiblePositions: eligiblePositions.length,
    auditedPositions: exactResults.length,
    coverage,
    verifiedPositions,
    verifiedCoverage,
    resolvedPredictions: predictionResults.length,
    predictionAccuracy: predictionResults.length
      ? predictionResults.filter((result) => result.correct).length / predictionResults.length
      : null,
    polymarketAuditedPositions: polymarketReturns.length,
    polymarketNetReturnPct: average(polymarketReturns),
    hyperliquidNetReturnPct,
    storedNetReturnPct,
    returnDifferencePct: hyperliquidNetReturnPct !== null && storedNetReturnPct !== null
      ? hyperliquidNetReturnPct - storedNetReturnPct
      : null,
    medianTimingErrorMs: median(timingErrors),
    maximumTimingErrorMs: maximumObservedTimingErrorMs,
    medianPolymarketQuoteAgeMs: median(polymarketQuoteAges),
    maximumPolymarketQuoteAgeMs: maximumObservedPolymarketQuoteAgeMs,
    medianCloseDelayMs: median(closeDelays),
    maximumCloseDelayMs: closeDelays.length ? Math.max(...closeDelays) : null,
    allowedTimingErrorMs: maximumTimingErrorMs,
    allowedPolymarketQuoteAgeMs: maximumPolymarketQuoteAgeMs,
    missingEntry,
    missingExit,
    missingResolution,
  };
}

export function calculatePolymarketTakerFee(shares: number, price: number) {
  if (!positiveNumber(shares) || !probability(price)) return 0;
  return roundFee(shares * cryptoTakerFeeRate * price * (1 - price));
}

function calculatePolymarketTokenReturn(price: number, correct: boolean) {
  if (!probability(price)) return null;
  const shares = 1 / price;
  const fee = calculatePolymarketTakerFee(shares, price);
  return (correct ? shares : 0) - 1 - fee;
}

function calculateHyperliquidBookPnl(input: {
  position: ExactExecutionAuditPosition;
  entryTick: ExactExecutionAuditTick;
  exitTick: ExactExecutionAuditTick;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
}) {
  const sideMultiplier = input.position.side === "LONG" ? 1 : -1;
  const entryBookPrice = sideMultiplier === 1
    ? input.entryTick.hyperliquidBestAsk
    : input.entryTick.hyperliquidBestBid;
  const exitBookPrice = sideMultiplier === 1
    ? input.exitTick.hyperliquidBestBid
    : input.exitTick.hyperliquidBestAsk;
  if (!positiveNumber(entryBookPrice) || !positiveNumber(exitBookPrice)) return null;
  const notional = input.position.quantity * input.position.entryPrice;
  if (!positiveNumber(notional)) return null;
  const entryPrice = entryBookPrice * (1 + sideMultiplier * input.slippagePerSide);
  const exitPrice = exitBookPrice * (1 - sideMultiplier * input.slippagePerSide);
  const quantity = notional / entryPrice;
  const grossPnl = sideMultiplier * quantity * (exitPrice - entryPrice);
  const entryFee = notional * input.takerFeePerSide;
  const exitFee = quantity * exitPrice * input.takerFeePerSide;
  const holdingDays = Math.max(
    0,
    input.position.exitAt.getTime() - input.position.openedAt.getTime(),
  ) / (24 * 60 * 60 * 1_000);
  const fundingRate = typeof input.position.entryFunding24h === "number" && Number.isFinite(input.position.entryFunding24h)
    ? sideMultiplier * input.position.entryFunding24h
    : input.fundingPer24h;
  const funding = notional * fundingRate * holdingDays;
  return {
    notional,
    entryPrice,
    exitPrice,
    realizedPnl: grossPnl - entryFee - exitFee - funding,
  };
}

function groupTicksByMarket(ticks: ExactExecutionAuditTick[]) {
  const grouped = new Map<string, ExactExecutionAuditTick[]>();
  for (const tick of ticks) {
    const rows = grouped.get(tick.marketId) ?? [];
    rows.push(tick);
    grouped.set(tick.marketId, rows);
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
  }
  return grouped;
}

function nearestTick(
  ticks: ExactExecutionAuditTick[],
  target: Date,
  timestamp: (tick: ExactExecutionAuditTick) => Date,
  maximumErrorMs: number,
) {
  let nearest: { tick: ExactExecutionAuditTick; errorMs: number } | null = null;
  for (const tick of ticks) {
    const errorMs = Math.abs(timestamp(tick).getTime() - target.getTime());
    if (errorMs <= maximumErrorMs && (!nearest || errorMs < nearest.errorMs)) nearest = { tick, errorMs };
  }
  return nearest;
}

function roundFee(value: number) {
  if (value < 0.000005) return 0;
  return Math.round(value * 100_000) / 100_000;
}

function probability(value: number) {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function positiveNumber(value: number) {
  return Number.isFinite(value) && value > 0;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
