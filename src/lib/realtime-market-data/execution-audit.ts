import {
  blockBootstrapMeanConfidenceInterval,
  deflatedSharpeProbability,
} from "@/src/lib/model-evaluation/combined-trading";

const defaultMinimumAuditedPositions = 50;
const defaultMaximumTimingErrorMs = 15_000;
const defaultMaximumPolymarketQuoteAgeMs = 2 * 60_000;
const defaultInitialEquity = 10_000;
const defaultRandomBenchmarkTrials = 200;
const defaultStrategyTrials = 11;
const minimumDeflatedSharpeProbability = 0.95;
const maximumDrawdownPct = 0.05;
const minimumDirectionalIndependentEvents = 5;
const cryptoTakerFeeRate = 0.07;

export type ExactExecutionAuditPosition = {
  eventId?: string;
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

export type ExactExecutionAuditAssetTick = {
  asset: string;
  hyperliquidBestBid: number;
  hyperliquidBestAsk: number;
  hyperliquidUpdatedAt: Date;
  capturedAt: Date;
};

export type ExactExecutionAuditResolution = {
  marketId: string;
  resolved: boolean;
  result: number | null;
};

export type ExactExecutionAuditInput = {
  positions: ExactExecutionAuditPosition[];
  controlPositions?: ExactExecutionAuditPosition[];
  ticks: ExactExecutionAuditTick[];
  assetTicks?: ExactExecutionAuditAssetTick[];
  resolutions: ExactExecutionAuditResolution[];
  collectionStartedAt: Date | null;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
  initialEquity?: number;
  settlementBasisStatus?: "collecting" | "healthy" | "attention";
  settlementResolutionStatus?: "collecting" | "healthy" | "attention";
  strategyTrials?: number;
  randomBenchmarkTrials?: number;
  minimumAuditedPositions?: number;
  maximumTimingErrorMs?: number;
  maximumPolymarketQuoteAgeMs?: number;
};

export type ExactExecutionAudit = ReturnType<typeof evaluateExactExecutionAudit>;

export function evaluateExactExecutionAudit(input: ExactExecutionAuditInput) {
  const maximumTimingErrorMs = input.maximumTimingErrorMs ?? defaultMaximumTimingErrorMs;
  const maximumPolymarketQuoteAgeMs = input.maximumPolymarketQuoteAgeMs ?? defaultMaximumPolymarketQuoteAgeMs;
  const minimumAuditedPositions = input.minimumAuditedPositions ?? defaultMinimumAuditedPositions;
  const initialEquity = positiveNumber(input.initialEquity ?? defaultInitialEquity)
    ? input.initialEquity ?? defaultInitialEquity
    : defaultInitialEquity;
  const strategyTrials = Math.max(1, Math.round(input.strategyTrials ?? defaultStrategyTrials));
  const randomBenchmarkTrials = Math.max(20, Math.round(input.randomBenchmarkTrials ?? defaultRandomBenchmarkTrials));
  const eligiblePositions = eligibleAuditPositions(input.positions, input.collectionStartedAt);
  const eligibleControlPositions = eligibleAuditPositions(input.controlPositions ?? [], input.collectionStartedAt);
  const ticksByMarket = groupTicksByMarket(input.ticks);
  const ticksByAsset = groupTicksByAsset(input.assetTicks ?? []);
  const resolutionsByMarket = new Map(input.resolutions.map((resolution) => [resolution.marketId, resolution]));
  const timingErrors: number[] = [];
  const polymarketQuoteAges: number[] = [];
  const closeDelays: number[] = [];
  const exactResults: ExactResult[] = [];
  const verifiedResults: ExactResult[] = [];
  const predictionResults: Array<{ correct: boolean; polymarketReturn: number | null }> = [];
  let missingEntry = 0;
  let missingExit = 0;
  let missingResolution = 0;
  let verifiedPositions = 0;

  for (const position of eligiblePositions) {
    const ticks = ticksByMarket.get(position.marketId) ?? [];
    const entry = selectCausalExecutionTick(ticks, position.openedAt, maximumTimingErrorMs);
    const exit = selectCausalAssetExecutionTick(
      ticksByAsset.get(position.asset) ?? [],
      position.exitAt,
      maximumTimingErrorMs,
    ) ?? selectCausalExecutionTick(ticks, position.exitAt, maximumTimingErrorMs);
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
          marketId: position.marketId,
          eventId: position.eventId ?? position.marketId,
          openedAt: position.openedAt,
          position,
          entryTick: entry.tick,
          exitTick: exit.tick,
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
    if (hasExactExecution && polymarketReturn !== null) {
      verifiedPositions += 1;
      const exactResult = exactResults.at(-1);
      if (exactResult?.marketId === position.marketId) verifiedResults.push(exactResult);
    }
  }

  const controlResults = exactExecutionResults({
    positions: eligibleControlPositions,
    ticksByMarket,
    ticksByAsset,
    maximumTimingErrorMs,
    takerFeePerSide: input.takerFeePerSide,
    slippagePerSide: input.slippagePerSide,
    fundingPer24h: input.fundingPer24h,
  });
  const resolvedMarketIds = new Set(input.resolutions.flatMap((resolution) => (
    resolution.resolved && (resolution.result === 0 || resolution.result === 1)
      ? [resolution.marketId]
      : []
  )));
  const verifiedControlResults = controlResults.filter((result) => resolvedMarketIds.has(result.marketId));
  const benchmark = buildExactBenchmarks({
    strategyResults: verifiedResults,
    controlResults: verifiedControlResults,
    initialEquity,
    takerFeePerSide: input.takerFeePerSide,
    slippagePerSide: input.slippagePerSide,
    fundingPer24h: input.fundingPer24h,
    randomBenchmarkTrials,
    strategyTrials,
  });

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
  const verifiedIndependentEvents = independentAuditWindows(verifiedResults).length;
  const enoughData = verifiedIndependentEvents >= minimumAuditedPositions;
  const directionCoverage = summarizeExactAuditDirectionCoverage(
    verifiedResults.map((result) => ({
      exitAt: result.position.exitAt,
      side: result.position.side,
    })),
  );
  const qualityPassed = verifiedCoverage >= 0.95
    && maximumObservedTimingErrorMs !== null
    && maximumObservedTimingErrorMs <= maximumTimingErrorMs
    && maximumObservedPolymarketQuoteAgeMs !== null
    && maximumObservedPolymarketQuoteAgeMs <= maximumPolymarketQuoteAgeMs;
  const portfolioNetReturnPct = verifiedResults.length
    ? sum(verifiedResults.map((result) => result.exactPnl)) / initialEquity
    : null;
  const storedPortfolioReturnPct = verifiedResults.length
    ? sum(verifiedResults.map((result) => result.storedPnl)) / initialEquity
    : null;
  const tradeReturns = independentAuditWindows(verifiedResults).map((window) => (
    sum(window.map((result) => result.exactPnl)) / sum(window.map((result) => result.notional))
  ));
  const meanTradeReturnConfidenceInterval95 = blockBootstrapMeanConfidenceInterval(tradeReturns);
  const maxDrawdown = maximumDrawdownFromPnl(verifiedResults, initialEquity);
  const attribution = {
    byAsset: summarizeExactAttribution(verifiedResults, initialEquity, (result) => result.position.asset)
      .map(({ key, ...slice }) => ({ asset: key, ...slice })),
    bySide: summarizeExactAttribution(verifiedResults, initialEquity, (result) => result.position.side)
      .map(({ key, ...slice }) => ({ side: key, ...slice })),
  };
  const controlCoverage = benchmark.comparableEvents
    ? benchmark.controlComparablePositions / benchmark.comparableEvents
    : 0;
  const gate = <Id extends string>(
    id: Id,
    label: string,
    evaluated: boolean,
    currentlyPassing: boolean,
  ) => ({
    id,
    label,
    state: !evaluated ? "pending" as const : currentlyPassing ? "passing" as const : "failing" as const,
    passed: enoughData && evaluated && currentlyPassing,
  });
  const settlementStatus = input.settlementResolutionStatus ?? input.settlementBasisStatus;
  const readinessGates = [
    gate("trades" as const, `${minimumAuditedPositions}件の独立時間枠を完全監査`, enoughData, true),
    gate(
      "directions" as const,
      `上昇・下落を各${minimumDirectionalIndependentEvents}独立枠で監査`,
      enoughData || directionCoverage.passed,
      directionCoverage.passed,
    ),
    gate("execution" as const, "実板・時刻・決着の監査率95%以上", eligiblePositions.length > 0, qualityPassed),
    gate("control" as const, "同時対照の再現率95%以上", benchmark.comparableEvents > 0, controlCoverage >= 0.95),
    gate("net-positive" as const, "全コスト控除後プラス", portfolioNetReturnPct !== null, (portfolioNetReturnPct ?? 0) > 0),
    gate("benchmark" as const, "最良の単純戦略を上回る", benchmark.excessReturnPct !== null, (benchmark.excessReturnPct ?? 0) > 0),
    gate("significance" as const, "対照との差の95%下限がプラス", benchmark.excessConfidenceInterval95 !== null, (benchmark.excessConfidenceInterval95?.[0] ?? 0) > 0),
    gate("selection-bias" as const, "試行補正後の確信度95%以上", benchmark.deflatedSharpeProbability !== null, (benchmark.deflatedSharpeProbability ?? 0) >= minimumDeflatedSharpeProbability),
    gate("drawdown" as const, "最大下落5%以内", verifiedIndependentEvents > 0, maxDrawdown <= maximumDrawdownPct),
    gate("settlement" as const, "Polymarket基準価格と公開RTDSの差を監査", settlementStatus !== undefined && settlementStatus !== "collecting", settlementStatus === "healthy"),
  ];
  const readinessStatus = !enoughData
    ? "collecting" as const
    : readinessGates.every((gate) => gate.passed)
      ? "promising" as const
      : "underperforming" as const;

  return {
    status: enoughData ? qualityPassed ? "healthy" as const : "attention" as const : "collecting" as const,
    readinessStatus,
    priceSources: {
      entry: "Polymarket CLOB 5秒板" as const,
      exit: "Hyperliquid L2 独立5秒板" as const,
      settlement: "Polymarket基準価格 + 公開RTDS監査" as const,
    },
    collectionStartedAt: input.collectionStartedAt?.toISOString() ?? null,
    minimumAuditedPositions,
    minimumIndependentEvents: minimumAuditedPositions,
    eligiblePositions: eligiblePositions.length,
    auditedPositions: exactResults.length,
    coverage,
    verifiedPositions,
    verifiedIndependentEvents,
    directionCoverage,
    verifiedCoverage,
    resolvedPredictions: predictionResults.length,
    predictionAccuracy: predictionResults.length
      ? predictionResults.filter((result) => result.correct).length / predictionResults.length
      : null,
    polymarketAuditedPositions: polymarketReturns.length,
    polymarketNetReturnPct: average(polymarketReturns),
    hyperliquidNetReturnPct,
    storedNetReturnPct,
    portfolioNetReturnPct,
    storedPortfolioReturnPct,
    meanTradeReturnConfidenceInterval95,
    benchmarkReturnPct: benchmark.bestReturnPct,
    benchmarkLabel: benchmark.bestLabel,
    excessReturnPct: benchmark.excessReturnPct,
    excessConfidenceInterval95: benchmark.excessConfidenceInterval95,
    deflatedSharpeProbability: benchmark.deflatedSharpeProbability,
    strategyTrials,
    randomBenchmarkTrials,
    maxDrawdownPct: maxDrawdown,
    attribution,
    controlComparablePositions: benchmark.controlComparablePositions,
    comparableEvents: benchmark.comparableEvents,
    comparableIndependentEvents: benchmark.comparableIndependentEvents,
    controlCoverage,
    benchmarks: benchmark.returns,
    passedReadinessGates: readinessGates.filter((gate) => gate.passed).length,
    currentlyPassingReadinessGates: readinessGates.filter((gate) => gate.state === "passing").length,
    evaluatedReadinessGates: readinessGates.filter((gate) => gate.state !== "pending").length,
    totalReadinessGates: readinessGates.length,
    readinessGates,
    settlementResolutionStatus: input.settlementResolutionStatus ?? input.settlementBasisStatus ?? "collecting",
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

type ExactResult = {
  marketId: string;
  eventId: string;
  openedAt: Date;
  position: ExactExecutionAuditPosition;
  entryTick: ExactExecutionAuditTick;
  exitTick: ExactExecutionAuditAssetTick;
  exactPnl: number;
  storedPnl: number;
  notional: number;
};

function summarizeExactAttribution(
  results: ExactResult[],
  initialEquity: number,
  keyFor: (result: ExactResult) => string,
) {
  const grouped = new Map<string, ExactResult[]>();
  for (const result of results) {
    const key = keyFor(result);
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }
  return Array.from(grouped, ([key, rows]) => {
    const netPnl = sum(rows.map((row) => row.exactPnl));
    return {
      key,
      trades: rows.length,
      wins: rows.filter((row) => row.exactPnl > 0).length,
      netPnl,
      returnContributionPct: netPnl / initialEquity,
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function eligibleAuditPositions(positions: ExactExecutionAuditPosition[], collectionStartedAt: Date | null) {
  return positions.filter((position) => (
    position.status === "CLOSED"
    && position.closedAt instanceof Date
    && typeof position.realizedPnl === "number"
    && Number.isFinite(position.realizedPnl)
    && collectionStartedAt instanceof Date
    && position.openedAt >= collectionStartedAt
  ));
}

function exactExecutionResults(input: {
  positions: ExactExecutionAuditPosition[];
  ticksByMarket: Map<string, ExactExecutionAuditTick[]>;
  ticksByAsset: Map<string, ExactExecutionAuditAssetTick[]>;
  maximumTimingErrorMs: number;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
}) {
  return input.positions.flatMap((position): ExactResult[] => {
    const ticks = input.ticksByMarket.get(position.marketId) ?? [];
    const entry = selectCausalExecutionTick(ticks, position.openedAt, input.maximumTimingErrorMs);
    const exit = selectCausalAssetExecutionTick(
      input.ticksByAsset.get(position.asset) ?? [],
      position.exitAt,
      input.maximumTimingErrorMs,
    ) ?? selectCausalExecutionTick(ticks, position.exitAt, input.maximumTimingErrorMs);
    if (!entry || !exit) return [];
    const exact = calculateHyperliquidBookPnl({
      position,
      entryTick: entry.tick,
      exitTick: exit.tick,
      takerFeePerSide: input.takerFeePerSide,
      slippagePerSide: input.slippagePerSide,
      fundingPer24h: input.fundingPer24h,
    });
    if (!exact) return [];
    return [{
      marketId: position.marketId,
      eventId: position.eventId ?? position.marketId,
      openedAt: position.openedAt,
      position,
      entryTick: entry.tick,
      exitTick: exit.tick,
      exactPnl: exact.realizedPnl,
      storedPnl: position.realizedPnl as number,
      notional: exact.notional,
    }];
  });
}

function buildExactBenchmarks(input: {
  strategyResults: ExactResult[];
  controlResults: ExactResult[];
  initialEquity: number;
  takerFeePerSide: number;
  slippagePerSide: number;
  fundingPer24h: number;
  randomBenchmarkTrials: number;
  strategyTrials: number;
}) {
  const strategyByMarket = new Map(input.strategyResults.map((result) => [result.marketId, result]));
  const controlByMarket = new Map(input.controlResults.map((result) => [result.marketId, result]));
  const comparableMarketIds = new Set([...strategyByMarket.keys(), ...controlByMarket.keys()]);
  const comparableResults = Array.from(comparableMarketIds).flatMap((marketId) => {
    const strategy = strategyByMarket.get(marketId);
    const control = controlByMarket.get(marketId);
    const reference = strategy ?? control;
    if (!reference) return [];
    return {
      marketId,
      strategy,
      control,
      reference,
    };
  });
  const strategyReturns = comparableResults.map(({ strategy }) => strategy ? strategy.exactPnl / strategy.notional : 0);
  const controlReturns = comparableResults.map(({ control }) => control ? control.exactPnl / control.notional : 0);
  const longReturns = comparableResults.map(({ reference }) => exactSideReturn(reference, "LONG", input));
  const shortReturns = comparableResults.map(({ reference }) => exactSideReturn(reference, "SHORT", input));
  const randomTrials = Array.from({ length: input.randomBenchmarkTrials }, (_, trial) => {
    const random = createSeededRandom(trial + 1);
    return comparableResults.map((_, index) => random() < 0.5 ? longReturns[index] : shortReturns[index]);
  });
  const randomMedian = medianTrial(randomTrials);
  const candidates = [
    { label: "現金待機" as const, returns: comparableResults.map(() => 0) },
    { label: "Polymarket方向のみ" as const, returns: controlReturns },
    { label: "常時ロング" as const, returns: longReturns },
    { label: "常時ショート" as const, returns: shortReturns },
    { label: "ランダム中央値" as const, returns: randomMedian },
  ].map((candidate) => ({
    ...candidate,
    returnPct: portfolioReturn(candidate.returns, comparableResults.map((result) => result.reference), input.initialEquity),
  }));
  const best = [...candidates].sort((left, right) => right.returnPct - left.returnPct)[0];
  const excessReturns = strategyReturns.map((value, index) => value - (best?.returns[index] ?? 0));
  const excessWindowReturns = independentAuditWindows(comparableResults.map(({ reference }) => reference)).map((window) => {
    const marketIds = new Set(window.map((result) => result.marketId));
    const positions = comparableResults.filter((result) => marketIds.has(result.marketId));
    const notional = sum(positions.map((result) => result.reference.notional));
    return notional > 0
      ? sum(positions.map((result) => {
          const index = comparableResults.indexOf(result);
          return excessReturns[index] * result.reference.notional;
        })) / notional
      : 0;
  });
  const excessPortfolioContributions = independentAuditWindows(comparableResults.map(({ reference }) => reference)).map((window) => {
    const marketIds = new Set(window.map((result) => result.marketId));
    return sum(comparableResults.flatMap((result, index) => marketIds.has(result.marketId)
      ? [excessReturns[index] * result.reference.notional / input.initialEquity]
      : []));
  });
  const contributionInterval = blockBootstrapMeanConfidenceInterval(excessPortfolioContributions);
  const excessConfidenceInterval95 = contributionInterval
    ? contributionInterval.map((value) => value * excessPortfolioContributions.length) as [number, number]
    : null;
  const strategyReturnPct = portfolioReturn(strategyReturns, comparableResults.map((result) => result.reference), input.initialEquity);
  const bestReturnPct = comparableResults.length ? best.returnPct : null;
  return {
    bestLabel: comparableResults.length ? best.label : null,
    bestReturnPct,
    excessReturnPct: bestReturnPct === null ? null : strategyReturnPct - bestReturnPct,
    excessConfidenceInterval95,
    deflatedSharpeProbability: deflatedSharpeProbability(excessWindowReturns, input.strategyTrials),
    controlComparablePositions: comparableResults.filter((result) => Boolean(result.control)).length,
    comparableEvents: comparableResults.length,
    comparableIndependentEvents: independentAuditWindows(comparableResults.map(({ reference }) => reference)).length,
    returns: {
      cashReturnPct: candidates[0].returnPct,
      polymarketOnlyReturnPct: candidates[1].returnPct,
      alwaysLongReturnPct: candidates[2].returnPct,
      alwaysShortReturnPct: candidates[3].returnPct,
      randomMedianReturnPct: candidates[4].returnPct,
    },
  };
}

function exactSideReturn(
  result: ExactResult,
  side: "LONG" | "SHORT",
  input: Pick<ExactExecutionAuditInput, "takerFeePerSide" | "slippagePerSide" | "fundingPer24h">,
) {
  const exact = calculateHyperliquidBookPnl({
    position: { ...result.position, side },
    entryTick: result.entryTick,
    exitTick: result.exitTick,
    takerFeePerSide: input.takerFeePerSide,
    slippagePerSide: input.slippagePerSide,
    fundingPer24h: input.fundingPer24h,
  });
  return exact ? exact.realizedPnl / exact.notional : 0;
}

function portfolioReturn(returns: number[], results: ExactResult[], initialEquity: number) {
  return returns.reduce((total, value, index) => total + value * (results[index]?.notional ?? 0), 0) / initialEquity;
}

function maximumDrawdownFromPnl(results: ExactResult[], initialEquity: number) {
  let equity = initialEquity;
  let peak = initialEquity;
  let maximumDrawdown = 0;
  for (const window of independentAuditWindows(results)) {
    equity += sum(window.map((result) => result.exactPnl));
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak : 1);
  }
  return maximumDrawdown;
}

function independentAuditWindows(results: ExactResult[]) {
  const grouped = new Map<number, ExactResult[]>();
  for (const result of results) {
    const key = independentAuditWindowKey(result.position.exitAt);
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }
  return Array.from(grouped.entries())
    .sort(([left], [right]) => left - right)
    .map(([, window]) => window);
}

export function summarizeExactAuditDirectionCoverage(
  rows: Array<{ exitAt: Date; side: string }>,
) {
  const longWindows = new Set<number>();
  const shortWindows = new Set<number>();
  for (const row of rows) {
    const key = independentAuditWindowKey(row.exitAt);
    if (row.side === "LONG") longWindows.add(key);
    if (row.side === "SHORT") shortWindows.add(key);
  }
  const longIndependentEvents = longWindows.size;
  const shortIndependentEvents = shortWindows.size;
  return {
    minimumIndependentEventsPerSide: minimumDirectionalIndependentEvents,
    longIndependentEvents,
    shortIndependentEvents,
    passed: longIndependentEvents >= minimumDirectionalIndependentEvents
      && shortIndependentEvents >= minimumDirectionalIndependentEvents,
  };
}

function independentAuditWindowKey(exitAt: Date) {
  const windowMs = 15 * 60_000;
  return Math.round(exitAt.getTime() / windowMs) * windowMs;
}

function medianTrial(trials: number[][]) {
  if (!trials.length) return [];
  return [...trials].sort((left, right) => sum(left) - sum(right))[Math.floor(trials.length / 2)];
}

function createSeededRandom(initialSeed: number) {
  let seed = Math.imul(initialSeed, 0x9e3779b9) >>> 0;
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
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
  exitTick: ExactExecutionAuditAssetTick;
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

function groupTicksByAsset(ticks: ExactExecutionAuditAssetTick[]) {
  const grouped = new Map<string, ExactExecutionAuditAssetTick[]>();
  for (const tick of ticks) {
    const rows = grouped.get(tick.asset) ?? [];
    rows.push(tick);
    grouped.set(tick.asset, rows);
  }
  for (const rows of grouped.values()) {
    rows.sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
  }
  return grouped;
}

export function selectCausalExecutionTick(
  ticks: ExactExecutionAuditTick[],
  target: Date,
  maximumDelayMs: number,
) {
  let first: { tick: ExactExecutionAuditTick; errorMs: number } | null = null;
  for (const tick of ticks) {
    const errorMs = tick.capturedAt.getTime() - target.getTime();
    if (errorMs < 0 || errorMs > maximumDelayMs) continue;
    if (!first || errorMs < first.errorMs) first = { tick, errorMs };
  }
  return first;
}

export function selectCausalAssetExecutionTick(
  ticks: ExactExecutionAuditAssetTick[],
  target: Date,
  maximumDelayMs: number,
) {
  let first: { tick: ExactExecutionAuditAssetTick; errorMs: number } | null = null;
  for (const tick of ticks) {
    const errorMs = tick.capturedAt.getTime() - target.getTime();
    if (errorMs < 0 || errorMs > maximumDelayMs) continue;
    if (!first || errorMs < first.errorMs) first = { tick, errorMs };
  }
  return first;
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
