import { createHash } from "node:crypto";

import {
  blockBootstrapMeanConfidenceInterval,
  deflatedSharpeProbability,
} from "@/src/lib/model-evaluation/combined-trading";
import { calculatePolymarketTakerFee } from "@/src/lib/realtime-market-data/execution-audit";

export const realtimeShortTermReplaySpecification = Object.freeze({
  version: 4,
  purpose: "diagnostic_only",
  promotionPolicy: "new_forward_cohort_required",
  synchronizationVersion: "websocket-v6-near-term-discovery",
  assetSynchronizationVersion: "websocket-asset-v1",
  entryOffsetsSeconds: [30, 60, 120] as const,
  strategies: ["market_direction", "trend_confirmed", "fair_value"] as const,
  strategyTrials: 9,
  randomBenchmarkTrials: 200,
  marketProbabilityThreshold: 0.58,
  fairValueMinimumEdge: 0.03,
  trendMinimumLogReturn: 0,
  maximumExecutionDelayMs: 15_000,
  maximumSourceAgeMs: 15_000,
  maximumBoundaryErrorMs: 15_000,
  volatilityLookbackMinutes: 30,
  minimumVolatilitySamples: 20,
  fallbackVolatility24h: 0.02,
  minimumVolatility24h: 0.005,
  maximumVolatility24h: 0.25,
  probabilityVolatilityFloor: 0.0003,
  polymarketCryptoFeeRate: 0.07,
  hyperliquidTakerFeePerSide: 0.00045,
  hyperliquidSlippagePerSide: 0.0002,
  positionPct: 0.05,
  maximumConcurrentPositions: 3,
  calibrationFraction: 0.6,
  walkForwardFolds: 4,
  walkForwardInitialFraction: 0.2,
  minimumHoldoutWindows: 20,
  minimumHoldoutWindowsPerSide: 5,
});

export type RealtimeReplayStrategy = (typeof realtimeShortTermReplaySpecification.strategies)[number];
export type RealtimeReplayBenchmark = "polymarket_only" | "hyperliquid_only" | "always_long" | "always_short" | "random_median";

export type RealtimeReplayMarketTick = {
  id: string;
  eventId: string | null;
  marketId: string;
  asset: string;
  marketStartAt: Date;
  marketEndAt: Date;
  polymarketBestBid: number;
  polymarketBestAsk: number;
  polymarketUpdatedAt: Date;
  negativeBestBid: number;
  negativeBestAsk: number;
  negativeUpdatedAt: Date;
  hyperliquidBestBid: number;
  hyperliquidBestAsk: number;
  hyperliquidMidPrice: number;
  hyperliquidFundingRate: number | null;
  hyperliquidUpdatedAt: Date;
  chainlinkPrice: number | null;
  chainlinkUpdatedAt: Date | null;
  referencePrice: number;
  referenceUpdatedAt: Date;
  captureSkewMs: number;
  capturedAt: Date;
};

export type RealtimeReplayAssetTick = {
  id: string;
  asset: string;
  hyperliquidBestBid: number;
  hyperliquidBestAsk: number;
  hyperliquidMidPrice: number;
  hyperliquidUpdatedAt: Date;
  chainlinkPrice: number | null;
  chainlinkUpdatedAt: Date | null;
  captureSkewMs: number;
  capturedAt: Date;
};

export type RealtimeReplayResolution = {
  marketId: string;
  result: number;
};

export type RealtimeShortTermReplayInput = {
  generatedAt: Date;
  marketTicks: RealtimeReplayMarketTick[];
  assetTicks: RealtimeReplayAssetTick[];
  resolutions: RealtimeReplayResolution[];
  codeRevision?: string | null;
};

type PriceTick = {
  id: string;
  asset: string;
  hyperliquidBestBid: number;
  hyperliquidBestAsk: number;
  hyperliquidMidPrice: number;
  hyperliquidUpdatedAt: Date;
  chainlinkPrice: number | null;
  chainlinkUpdatedAt: Date | null;
  captureSkewMs: number;
  capturedAt: Date;
  source: "asset" | "market";
};

export type RealtimeReplayTrade = {
  variantId: string;
  strategy: RealtimeReplayStrategy;
  entryOffsetSeconds: number;
  windowAt: string;
  marketId: string;
  eventId: string;
  asset: string;
  side: "LONG" | "SHORT";
  officialResult: 0 | 1;
  correct: boolean;
  observedAt: string;
  entryAt: string;
  exitAt: string;
  entryDelayMs: number;
  exitDelayMs: number;
  startReferencePrice: number;
  entryReferencePrice: number;
  endReferencePrice: number;
  marketProbability: number;
  fairProbability: number;
  probabilityEdge: number;
  trendLogReturn: number;
  volatility24h: number;
  signalStrength: number;
  polymarketEntryPrice: number;
  polymarketFeePct: number;
  polymarketReturnPct: number;
  hyperliquidEntryPrice: number;
  hyperliquidExitPrice: number;
  hyperliquidReturnPct: number;
  equalWeightReturnPct: number;
  longEqualWeightReturnPct: number;
  shortEqualWeightReturnPct: number;
};

export function buildRealtimeShortTermReplay(input: RealtimeShortTermReplayInput) {
  const resolutionByMarket = new Map(input.resolutions.flatMap((row) => (
    row.result === 0 || row.result === 1 ? [[row.marketId, row.result as 0 | 1] as const] : []
  )));
  const ticksByMarket = groupBy(input.marketTicks, (tick) => tick.marketId);
  const priceTicksByAsset = buildPriceTicksByAsset(input.marketTicks, input.assetTicks);
  const allTrades: RealtimeReplayTrade[] = [];
  const skipped = new Map<string, number>();
  let completeMarkets = 0;
  let replayableMarkets = 0;

  for (const ticks of ticksByMarket.values()) {
    ticks.sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
    const market = ticks[0];
    if (!market || market.marketEndAt.getTime() > input.generatedAt.getTime()) continue;
    completeMarkets += 1;
    const officialResult = resolutionByMarket.get(market.marketId);
    if (officialResult === undefined) {
      increment(skipped, "official_resolution_missing");
      continue;
    }
    const assetPrices = priceTicksByAsset.get(market.asset) ?? [];
    const endBoundary = selectCausalReferenceBoundary(ticks, market.marketEndAt, input.generatedAt, realtimeShortTermReplaySpecification.maximumBoundaryErrorMs)
      ?? selectAssetReferenceBoundary(assetPrices, market.marketEndAt, realtimeShortTermReplaySpecification.maximumBoundaryErrorMs);
    const exitExecution = selectPreferredCausalPriceTick(assetPrices, market.marketEndAt, realtimeShortTermReplaySpecification.maximumExecutionDelayMs)
      ?? selectCausalMarketPriceTick(ticks, market.marketEndAt, realtimeShortTermReplaySpecification.maximumExecutionDelayMs);
    if (!endBoundary || !exitExecution) {
      increment(skipped, "end_boundary_or_exit_missing");
      continue;
    }
    let marketHasReplay = false;
    for (const entryOffsetSeconds of realtimeShortTermReplaySpecification.entryOffsetsSeconds) {
      const targetAt = new Date(market.marketStartAt.getTime() + entryOffsetSeconds * 1_000);
      const entry = selectCausalDecisionTick(ticks, targetAt, realtimeShortTermReplaySpecification.maximumExecutionDelayMs);
      if (!entry) {
        increment(skipped, `entry_${entryOffsetSeconds}s_missing`);
        continue;
      }
      const startBoundary = selectCausalReferenceBoundary(
        ticks,
        market.marketStartAt,
        entry.capturedAt,
        realtimeShortTermReplaySpecification.maximumBoundaryErrorMs,
      );
      if (!startBoundary) {
        increment(skipped, "start_boundary_missing");
        continue;
      }
      const boundaryResult = endBoundary.price > startBoundary.price ? 1 : 0;
      if (boundaryResult !== officialResult) {
        increment(skipped, "official_boundary_mismatch");
        continue;
      }
      const entryReferencePrice = referencePrice(entry);
      if (!positive(entryReferencePrice)) {
        increment(skipped, "entry_reference_missing");
        continue;
      }
      const volatility24h = estimateVolatility24h(
        assetPrices,
        entry.capturedAt,
        realtimeShortTermReplaySpecification.volatilityLookbackMinutes,
      );
      const remainingHours = Math.max((market.marketEndAt.getTime() - entry.capturedAt.getTime()) / 3_600_000, 1 / 3_600);
      const fairProbability = calculateDigitalFairProbability({
        thresholdPrice: startBoundary.price,
        currentPrice: entryReferencePrice,
        volatility24h,
        remainingHours,
      });
      const marketProbability = clamp((entry.polymarketBestBid + entry.polymarketBestAsk) / 2, 0.01, 0.99);
      const trendLogReturn = Math.log(entry.hyperliquidMidPrice / startBoundary.hyperliquidMidPrice);
      const candidates = buildStrategyCandidates({
        entry,
        marketProbability,
        fairProbability,
        trendLogReturn,
      });
      for (const candidate of candidates) {
        const longPolymarket = calculatePolymarketReplayReturn({
          price: entry.polymarketBestAsk,
          correct: officialResult === 1,
        });
        const shortPolymarket = calculatePolymarketReplayReturn({
          price: entry.negativeBestAsk,
          correct: officialResult === 0,
        });
        const longHyperliquid = calculateHyperliquidReplayReturn({
          side: "LONG",
          entryBestBid: entry.hyperliquidBestBid,
          entryBestAsk: entry.hyperliquidBestAsk,
          exitBestBid: exitExecution.hyperliquidBestBid,
          exitBestAsk: exitExecution.hyperliquidBestAsk,
          fundingRatePerHour: entry.hyperliquidFundingRate,
          holdingHours: Math.max(0, (market.marketEndAt.getTime() - entry.capturedAt.getTime()) / 3_600_000),
        });
        const shortHyperliquid = calculateHyperliquidReplayReturn({
          side: "SHORT",
          entryBestBid: entry.hyperliquidBestBid,
          entryBestAsk: entry.hyperliquidBestAsk,
          exitBestBid: exitExecution.hyperliquidBestBid,
          exitBestAsk: exitExecution.hyperliquidBestAsk,
          fundingRatePerHour: entry.hyperliquidFundingRate,
          holdingHours: Math.max(0, (market.marketEndAt.getTime() - entry.capturedAt.getTime()) / 3_600_000),
        });
        if (!longPolymarket || !shortPolymarket || !longHyperliquid || !shortHyperliquid) continue;
        const polymarket = candidate.side === "LONG" ? longPolymarket : shortPolymarket;
        const hyperliquid = candidate.side === "LONG" ? longHyperliquid : shortHyperliquid;
        marketHasReplay = true;
        allTrades.push({
          variantId: variantId(candidate.strategy, entryOffsetSeconds),
          strategy: candidate.strategy,
          entryOffsetSeconds,
          windowAt: market.marketStartAt.toISOString(),
          marketId: market.marketId,
          eventId: market.eventId ?? market.marketId,
          asset: market.asset,
          side: candidate.side,
          officialResult,
          correct: candidate.side === "LONG" ? officialResult === 1 : officialResult === 0,
          observedAt: targetAt.toISOString(),
          entryAt: entry.capturedAt.toISOString(),
          exitAt: exitExecution.capturedAt.toISOString(),
          entryDelayMs: entry.capturedAt.getTime() - targetAt.getTime(),
          exitDelayMs: exitExecution.capturedAt.getTime() - market.marketEndAt.getTime(),
          startReferencePrice: startBoundary.price,
          entryReferencePrice,
          endReferencePrice: endBoundary.price,
          marketProbability,
          fairProbability,
          probabilityEdge: candidate.probabilityEdge,
          trendLogReturn,
          volatility24h,
          signalStrength: candidate.signalStrength,
          polymarketEntryPrice: candidate.polymarketEntryPrice,
          polymarketFeePct: polymarket.feePct,
          polymarketReturnPct: polymarket.returnPct,
          hyperliquidEntryPrice: hyperliquid.entryPrice,
          hyperliquidExitPrice: hyperliquid.exitPrice,
          hyperliquidReturnPct: hyperliquid.returnPct,
          equalWeightReturnPct: (polymarket.returnPct + hyperliquid.returnPct) / 2,
          longEqualWeightReturnPct: (longPolymarket.returnPct + longHyperliquid.returnPct) / 2,
          shortEqualWeightReturnPct: (shortPolymarket.returnPct + shortHyperliquid.returnPct) / 2,
        });
      }
    }
    if (marketHasReplay) replayableMarkets += 1;
  }

  const selectedTrades = applyConcurrentPositionLimit(allTrades);
  const windows = uniqueSorted(selectedTrades.map((trade) => trade.windowAt));
  const splitIndex = Math.max(1, Math.floor(windows.length * realtimeShortTermReplaySpecification.calibrationFraction));
  const calibrationWindows = new Set(windows.slice(0, splitIndex));
  const holdoutWindows = new Set(windows.slice(splitIndex));
  const variantDefinitions = realtimeShortTermReplaySpecification.strategies.flatMap((strategy) => (
    realtimeShortTermReplaySpecification.entryOffsetsSeconds.map((entryOffsetSeconds) => ({
      id: variantId(strategy, entryOffsetSeconds),
      strategy,
      entryOffsetSeconds,
    }))
  ));
  const variants = variantDefinitions.map(({ id, strategy, entryOffsetSeconds }) => {
      const trades = selectedTrades.filter((trade) => trade.strategy === strategy && trade.entryOffsetSeconds === entryOffsetSeconds);
      const calibration = summarizeReplayTrades(trades.filter((trade) => calibrationWindows.has(trade.windowAt)));
      const holdout = summarizeReplayTrades(trades.filter((trade) => holdoutWindows.has(trade.windowAt)));
      return {
        id,
        strategy,
        entryOffsetSeconds,
        calibration,
        holdout,
        walkForward: walkForwardSummary(trades, windows),
      };
    });
  const walkForwardSelection = expandingWalkForwardSelectionSummary(selectedTrades, windows, variantDefinitions);
  const selectedExploratoryCandidate = [...variants]
    .filter((variant) => variant.calibration.independentWindows > 0)
    .sort((left, right) => (
      (right.calibration.excessAverageReturnPct ?? Number.NEGATIVE_INFINITY)
      - (left.calibration.excessAverageReturnPct ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;
  const selectedHoldout = selectedExploratoryCandidate?.holdout ?? null;
  const holdoutCoverage = replayHoldoutCoverage(selectedHoldout);
  const status = !selectedHoldout || !holdoutCoverage.passed
    ? "insufficient" as const
    : selectedHoldout.equalWeightNetReturnPct > 0
      && (selectedHoldout.excessReturnPct ?? 0) > 0
      && (selectedHoldout.excessConfidenceInterval95?.[0] ?? 0) > 0
      && (selectedHoldout.excessDeflatedSharpeProbability ?? 0) >= 0.95
      && walkForwardSelection.benchmarkBeatingFolds >= 3
      ? "promising" as const
      : "rejected" as const;
  const inputRows = {
    marketTicks: input.marketTicks.map((tick) => ({
      id: tick.id,
      marketId: tick.marketId,
      capturedAt: tick.capturedAt.toISOString(),
      polymarketBestBid: tick.polymarketBestBid,
      polymarketBestAsk: tick.polymarketBestAsk,
      negativeBestBid: tick.negativeBestBid,
      negativeBestAsk: tick.negativeBestAsk,
      hyperliquidBestBid: tick.hyperliquidBestBid,
      hyperliquidBestAsk: tick.hyperliquidBestAsk,
      chainlinkPrice: tick.chainlinkPrice,
      chainlinkUpdatedAt: tick.chainlinkUpdatedAt?.toISOString() ?? null,
      referencePrice: tick.referencePrice,
      referenceUpdatedAt: tick.referenceUpdatedAt.toISOString(),
    })),
    assetTicks: input.assetTicks.map((tick) => ({
      id: tick.id,
      asset: tick.asset,
      capturedAt: tick.capturedAt.toISOString(),
      hyperliquidBestBid: tick.hyperliquidBestBid,
      hyperliquidBestAsk: tick.hyperliquidBestAsk,
      chainlinkPrice: tick.chainlinkPrice,
      chainlinkUpdatedAt: tick.chainlinkUpdatedAt?.toISOString() ?? null,
    })),
    resolutions: [...input.resolutions].sort((left, right) => left.marketId.localeCompare(right.marketId)),
  };
  const generatedAt = input.generatedAt.toISOString();
  return {
    generatedAt,
    methodology: {
      status: "exploratory_replay_only" as const,
      warning: "This replay selects a candidate on calibration data. It cannot modify or authorize the active 50-window forward cohort.",
      independentSampleUnit: "15-minute-window" as const,
      split: "chronological 60% calibration / 40% holdout" as const,
      walkForwardSelection: "expanding calibration; each next block uses a candidate selected only from earlier windows" as const,
      directionCoverage: `holdout requires at least ${realtimeShortTermReplaySpecification.minimumHoldoutWindowsPerSide} independent long and short windows` as const,
      execution: "first complete synchronized 5-second executable book after each fixed entry offset" as const,
      settlement: "official Polymarket result with Chainlink boundary audit" as const,
      costs: {
        polymarket: "official crypto taker fee curve" as const,
        hyperliquidTakerFeePerSide: realtimeShortTermReplaySpecification.hyperliquidTakerFeePerSide,
        hyperliquidSlippagePerSide: realtimeShortTermReplaySpecification.hyperliquidSlippagePerSide,
        funding: "entry hourly funding rate prorated to holding time" as const,
      },
    },
    specification: realtimeShortTermReplaySpecification,
    coverage: {
      marketTicks: input.marketTicks.length,
      assetTicks: input.assetTicks.length,
      discoveredMarkets: ticksByMarket.size,
      completeMarkets,
      replayableMarkets,
      independentWindows: windows.length,
      selectedTrades: selectedTrades.length,
      skipped: Object.fromEntries([...skipped.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    selection: {
      status,
      promotionAllowed: false,
      reason: status === "insufficient"
        ? `holdout coverage ${holdoutCoverage.total.observed}/${holdoutCoverage.total.required}; long ${holdoutCoverage.long.observed}/${holdoutCoverage.long.required}; short ${holdoutCoverage.short.observed}/${holdoutCoverage.short.required}`
        : status === "promising"
          ? "diagnostic gate passed; a new frozen forward cohort is still required"
          : "holdout, benchmark, selection-bias, or walk-forward gate failed",
      selectedExploratoryCandidateId: selectedExploratoryCandidate?.id ?? null,
      strategyTrials: realtimeShortTermReplaySpecification.strategyTrials,
      holdoutCoverage,
    },
    variants,
    walkForwardSelection,
    reproducibility: {
      runId: generatedAt.replaceAll(":", "-"),
      codeRevision: input.codeRevision?.trim() || null,
      hashAlgorithm: "sha256" as const,
      specificationSha256: sha256Json(realtimeShortTermReplaySpecification),
      datasetSha256: sha256Json(inputRows),
      tradeRows: selectedTrades.length,
    },
    trades: selectedTrades,
  };
}

export function calculateDigitalFairProbability(input: {
  thresholdPrice: number;
  currentPrice: number;
  volatility24h: number;
  remainingHours: number;
}) {
  if (!positive(input.thresholdPrice) || !positive(input.currentPrice) || !positive(input.volatility24h) || !positive(input.remainingHours)) return 0.5;
  const remainingVolatility = Math.max(
    input.volatility24h * Math.sqrt(input.remainingHours / 24),
    realtimeShortTermReplaySpecification.probabilityVolatilityFloor,
  );
  const d2 = (Math.log(input.currentPrice / input.thresholdPrice) - 0.5 * remainingVolatility ** 2) / remainingVolatility;
  return clamp(normalCdf(d2), 0.01, 0.99);
}

export function calculatePolymarketReplayReturn(input: { price: number; correct: boolean }) {
  if (!probability(input.price)) return null;
  const shares = 1 / input.price;
  const fee = calculatePolymarketTakerFee(shares, input.price);
  const capital = 1 + fee;
  return {
    feePct: fee / capital,
    returnPct: ((input.correct ? shares : 0) - capital) / capital,
  };
}

export function calculateHyperliquidReplayReturn(input: {
  side: "LONG" | "SHORT";
  entryBestBid: number;
  entryBestAsk: number;
  exitBestBid: number;
  exitBestAsk: number;
  fundingRatePerHour: number | null;
  holdingHours: number;
}) {
  const side = input.side === "LONG" ? 1 : -1;
  const rawEntry = side === 1 ? input.entryBestAsk : input.entryBestBid;
  const rawExit = side === 1 ? input.exitBestBid : input.exitBestAsk;
  if (!positive(rawEntry) || !positive(rawExit)) return null;
  const entryPrice = rawEntry * (1 + side * realtimeShortTermReplaySpecification.hyperliquidSlippagePerSide);
  const exitPrice = rawExit * (1 - side * realtimeShortTermReplaySpecification.hyperliquidSlippagePerSide);
  const grossReturn = side * (exitPrice / entryPrice - 1);
  const fees = realtimeShortTermReplaySpecification.hyperliquidTakerFeePerSide
    + realtimeShortTermReplaySpecification.hyperliquidTakerFeePerSide * exitPrice / entryPrice;
  const funding = typeof input.fundingRatePerHour === "number" && Number.isFinite(input.fundingRatePerHour)
    ? side * input.fundingRatePerHour * input.holdingHours
    : 0;
  return { entryPrice, exitPrice, returnPct: grossReturn - fees - funding };
}

function buildStrategyCandidates(input: {
  entry: RealtimeReplayMarketTick;
  marketProbability: number;
  fairProbability: number;
  trendLogReturn: number;
}) {
  const marketSide = input.marketProbability >= 0.5 ? "LONG" as const : "SHORT" as const;
  const confidence = Math.max(input.marketProbability, 1 - input.marketProbability);
  const yesFee = calculatePolymarketTakerFee(1, input.entry.polymarketBestAsk);
  const noFee = calculatePolymarketTakerFee(1, input.entry.negativeBestAsk);
  const yesEdge = input.fairProbability - input.entry.polymarketBestAsk - yesFee;
  const noEdge = (1 - input.fairProbability) - input.entry.negativeBestAsk - noFee;
  const fairSide = yesEdge >= noEdge ? "LONG" as const : "SHORT" as const;
  const fairEntryPrice = fairSide === "LONG" ? input.entry.polymarketBestAsk : input.entry.negativeBestAsk;
  const fairEdge = Math.max(yesEdge, noEdge);
  const marketEntryPrice = marketSide === "LONG" ? input.entry.polymarketBestAsk : input.entry.negativeBestAsk;
  const candidates: Array<{
    strategy: RealtimeReplayStrategy;
    side: "LONG" | "SHORT";
    signalStrength: number;
    probabilityEdge: number;
    polymarketEntryPrice: number;
  }> = [];
  if (confidence >= realtimeShortTermReplaySpecification.marketProbabilityThreshold) {
    candidates.push({
      strategy: "market_direction",
      side: marketSide,
      signalStrength: confidence - 0.5,
      probabilityEdge: marketSide === "LONG" ? yesEdge : noEdge,
      polymarketEntryPrice: marketEntryPrice,
    });
    const trendSide = input.trendLogReturn >= realtimeShortTermReplaySpecification.trendMinimumLogReturn ? "LONG" : "SHORT";
    if (trendSide === marketSide) {
      candidates.push({
        strategy: "trend_confirmed",
        side: marketSide,
        signalStrength: confidence - 0.5 + Math.abs(input.trendLogReturn),
        probabilityEdge: marketSide === "LONG" ? yesEdge : noEdge,
        polymarketEntryPrice: marketEntryPrice,
      });
    }
  }
  if (fairEdge >= realtimeShortTermReplaySpecification.fairValueMinimumEdge) {
    candidates.push({
      strategy: "fair_value",
      side: fairSide,
      signalStrength: fairEdge,
      probabilityEdge: fairEdge,
      polymarketEntryPrice: fairEntryPrice,
    });
  }
  return candidates;
}

function summarizeReplayTrades(trades: RealtimeReplayTrade[]) {
  const windowReturns = groupedWindowReturns(trades, (trade) => trade.equalWeightReturnPct);
  const hyperliquidWindowReturns = groupedWindowReturns(trades, (trade) => trade.hyperliquidReturnPct);
  const polymarketWindowReturns = groupedWindowReturns(trades, (trade) => trade.polymarketReturnPct);
  const benchmark = buildRealtimeReplayBenchmarkSummary(trades);
  const directionCoverage = summarizeReplayDirectionCoverage(trades);
  return {
    independentWindows: windowReturns.length,
    ...directionCoverage,
    trades: trades.length,
    correctTrades: trades.filter((trade) => trade.correct).length,
    directionAccuracy: trades.length ? trades.filter((trade) => trade.correct).length / trades.length : null,
    equalWeightWinRate: trades.length ? trades.filter((trade) => trade.equalWeightReturnPct > 0).length / trades.length : null,
    equalWeightAverageReturnPct: average(trades.map((trade) => trade.equalWeightReturnPct)),
    equalWeightNetReturnPct: sum(windowReturns),
    equalWeightConfidenceInterval95: blockBootstrapMeanConfidenceInterval(windowReturns),
    deflatedSharpeProbability: deflatedSharpeProbability(windowReturns, realtimeShortTermReplaySpecification.strategyTrials),
    hyperliquidAverageReturnPct: average(trades.map((trade) => trade.hyperliquidReturnPct)),
    hyperliquidNetReturnPct: sum(hyperliquidWindowReturns),
    polymarketAverageReturnPct: average(trades.map((trade) => trade.polymarketReturnPct)),
    polymarketNetReturnPct: sum(polymarketWindowReturns),
    maximumDrawdownPct: maximumDrawdown(windowReturns),
    ...benchmark,
  };
}

export function summarizeReplayDirectionCoverage(trades: Array<Pick<RealtimeReplayTrade, "windowAt" | "side">>) {
  const longTrades = trades.filter((trade) => trade.side === "LONG");
  const shortTrades = trades.filter((trade) => trade.side === "SHORT");
  return {
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longIndependentWindows: new Set(longTrades.map((trade) => trade.windowAt)).size,
    shortIndependentWindows: new Set(shortTrades.map((trade) => trade.windowAt)).size,
  };
}

function replayHoldoutCoverage(summary: ReturnType<typeof summarizeReplayTrades> | null) {
  const totalObserved = summary?.independentWindows ?? 0;
  const longObserved = summary?.longIndependentWindows ?? 0;
  const shortObserved = summary?.shortIndependentWindows ?? 0;
  const totalRequired = realtimeShortTermReplaySpecification.minimumHoldoutWindows;
  const sideRequired = realtimeShortTermReplaySpecification.minimumHoldoutWindowsPerSide;
  return {
    passed: totalObserved >= totalRequired && longObserved >= sideRequired && shortObserved >= sideRequired,
    total: { observed: totalObserved, required: totalRequired, passed: totalObserved >= totalRequired },
    long: { observed: longObserved, required: sideRequired, passed: longObserved >= sideRequired },
    short: { observed: shortObserved, required: sideRequired, passed: shortObserved >= sideRequired },
  };
}

export function buildRealtimeReplayBenchmarkSummary(trades: Array<Pick<
  RealtimeReplayTrade,
  "windowAt" | "polymarketReturnPct" | "hyperliquidReturnPct" | "equalWeightReturnPct" | "longEqualWeightReturnPct" | "shortEqualWeightReturnPct"
>>) {
  const strategyReturns = groupedWindowReturnEntries(trades, (trade) => trade.equalWeightReturnPct);
  const polymarketOnly = groupedWindowReturnEntries(trades, (trade) => trade.polymarketReturnPct);
  const hyperliquidOnly = groupedWindowReturnEntries(trades, (trade) => trade.hyperliquidReturnPct);
  const alwaysLong = groupedWindowReturnEntries(trades, (trade) => trade.longEqualWeightReturnPct);
  const alwaysShort = groupedWindowReturnEntries(trades, (trade) => trade.shortEqualWeightReturnPct);
  const randomTrials = Array.from({ length: realtimeShortTermReplaySpecification.randomBenchmarkTrials }, (_, trial) => {
    const random = createSeededRandom(trial + 1);
    return groupedWindowReturnEntries(trades, (trade) => (
      random() < 0.5 ? trade.longEqualWeightReturnPct : trade.shortEqualWeightReturnPct
    ));
  });
  const randomMedian = medianWindowTrial(randomTrials);
  const candidates: Array<{ id: RealtimeReplayBenchmark; returns: Array<{ windowAt: string; value: number }> }> = [
    { id: "polymarket_only", returns: polymarketOnly },
    { id: "hyperliquid_only", returns: hyperliquidOnly },
    { id: "always_long", returns: alwaysLong },
    { id: "always_short", returns: alwaysShort },
    { id: "random_median", returns: randomMedian },
  ];
  const ranked = candidates.map((candidate) => ({ ...candidate, netReturnPct: sum(candidate.returns.map((row) => row.value)) }))
    .sort((left, right) => right.netReturnPct - left.netReturnPct);
  const best = strategyReturns.length ? ranked[0] : null;
  const bestByWindow = new Map(best?.returns.map((row) => [row.windowAt, row.value]) ?? []);
  const excessReturns = strategyReturns.map((row) => row.value - (bestByWindow.get(row.windowAt) ?? 0));
  const strategyNetReturnPct = sum(strategyReturns.map((row) => row.value));
  const bestBenchmarkNetReturnPct = best?.netReturnPct ?? null;
  return {
    bestBenchmarkId: best?.id ?? null,
    bestBenchmarkNetReturnPct,
    excessReturnPct: bestBenchmarkNetReturnPct === null ? null : strategyNetReturnPct - bestBenchmarkNetReturnPct,
    excessAverageReturnPct: average(excessReturns),
    excessConfidenceInterval95: blockBootstrapMeanConfidenceInterval(excessReturns),
    excessDeflatedSharpeProbability: deflatedSharpeProbability(excessReturns, realtimeShortTermReplaySpecification.strategyTrials),
    benchmarks: {
      polymarketOnlyNetReturnPct: sum(polymarketOnly.map((row) => row.value)),
      hyperliquidOnlyNetReturnPct: sum(hyperliquidOnly.map((row) => row.value)),
      alwaysLongNetReturnPct: sum(alwaysLong.map((row) => row.value)),
      alwaysShortNetReturnPct: sum(alwaysShort.map((row) => row.value)),
      randomMedianNetReturnPct: sum(randomMedian.map((row) => row.value)),
    },
  };
}

function walkForwardSummary(trades: RealtimeReplayTrade[], windows: string[]) {
  const folds = Array.from({ length: realtimeShortTermReplaySpecification.walkForwardFolds }, (_, index) => {
    const start = Math.floor(index * windows.length / realtimeShortTermReplaySpecification.walkForwardFolds);
    const end = Math.floor((index + 1) * windows.length / realtimeShortTermReplaySpecification.walkForwardFolds);
    const validation = new Set(windows.slice(start, end));
    const summary = summarizeReplayTrades(trades.filter((trade) => validation.has(trade.windowAt)));
    return { fold: index + 1, ...summary };
  });
  return {
    folds,
    profitableFolds: folds.filter((fold) => fold.equalWeightNetReturnPct > 0).length,
    benchmarkBeatingFolds: folds.filter((fold) => (fold.excessReturnPct ?? 0) > 0).length,
    totalFolds: folds.length,
  };
}

type RealtimeReplayVariantDefinition = {
  id: string;
  strategy: RealtimeReplayStrategy;
  entryOffsetSeconds: number;
};

function expandingWalkForwardSelectionSummary(
  trades: RealtimeReplayTrade[],
  windows: string[],
  variants: RealtimeReplayVariantDefinition[],
) {
  const folds = buildExpandingReplayFolds(
    windows,
    realtimeShortTermReplaySpecification.walkForwardFolds,
    realtimeShortTermReplaySpecification.walkForwardInitialFraction,
  ).map((range, index) => {
    const calibrationWindows = new Set(range.calibration);
    const validationWindows = new Set(range.validation);
    const selected = variants.map((variant) => ({
      ...variant,
      calibration: summarizeReplayTrades(trades.filter((trade) => (
        trade.variantId === variant.id && calibrationWindows.has(trade.windowAt)
      ))),
    }))
      .filter((variant) => variant.calibration.independentWindows > 0)
      .sort((left, right) => (
        (right.calibration.excessAverageReturnPct ?? Number.NEGATIVE_INFINITY)
        - (left.calibration.excessAverageReturnPct ?? Number.NEGATIVE_INFINITY)
        || left.id.localeCompare(right.id)
      ))[0] ?? null;
    const validation = summarizeReplayTrades(selected ? trades.filter((trade) => (
      trade.variantId === selected.id && validationWindows.has(trade.windowAt)
    )) : []);
    return {
      fold: index + 1,
      calibrationWindows: range.calibration.length,
      validationWindows: range.validation.length,
      selectedCandidateId: selected?.id ?? null,
      validation,
    };
  });
  return {
    methodology: "expanding-calibration-next-block" as const,
    folds,
    profitableFolds: folds.filter((fold) => fold.validation.equalWeightNetReturnPct > 0).length,
    benchmarkBeatingFolds: folds.filter((fold) => (fold.validation.excessReturnPct ?? 0) > 0).length,
    totalFolds: folds.length,
  };
}

export function buildExpandingReplayFolds(windows: string[], foldCount = 4, initialFraction = 0.2) {
  const ordered = uniqueSorted(windows);
  if (ordered.length < 2 || foldCount < 1) return [];
  const initialCount = Math.max(1, Math.min(ordered.length - 1, Math.floor(ordered.length * initialFraction)));
  const remaining = ordered.length - initialCount;
  return Array.from({ length: foldCount }, (_, index) => {
    const validationStart = initialCount + Math.floor(index * remaining / foldCount);
    const validationEnd = initialCount + Math.floor((index + 1) * remaining / foldCount);
    return {
      calibration: ordered.slice(0, validationStart),
      validation: ordered.slice(validationStart, validationEnd),
    };
  }).filter((fold) => fold.validation.length > 0);
}

function groupedWindowReturns(trades: RealtimeReplayTrade[], valueFor: (trade: RealtimeReplayTrade) => number) {
  return groupedWindowReturnEntries(trades, valueFor).map((row) => row.value);
}

function groupedWindowReturnEntries<T extends { windowAt: string }>(trades: T[], valueFor: (trade: T) => number) {
  const grouped = groupBy(trades, (trade) => trade.windowAt);
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([windowAt, rows]) => ({
      windowAt,
      value: sum(rows.map((trade) => valueFor(trade) * realtimeShortTermReplaySpecification.positionPct)),
    }));
}

function applyConcurrentPositionLimit(trades: RealtimeReplayTrade[]) {
  const grouped = groupBy(trades, (trade) => `${trade.variantId}:${trade.windowAt}`);
  return [...grouped.values()].flatMap((rows) => (
    [...rows]
      .sort((left, right) => right.signalStrength - left.signalStrength || left.asset.localeCompare(right.asset))
      .slice(0, realtimeShortTermReplaySpecification.maximumConcurrentPositions)
  )).sort((left, right) => (
    left.windowAt.localeCompare(right.windowAt)
    || left.variantId.localeCompare(right.variantId)
    || left.asset.localeCompare(right.asset)
  ));
}

function buildPriceTicksByAsset(marketTicks: RealtimeReplayMarketTick[], assetTicks: RealtimeReplayAssetTick[]) {
  const values: PriceTick[] = [
    ...assetTicks.map((tick): PriceTick => ({ ...tick, source: "asset" })),
    ...marketTicks.map((tick): PriceTick => ({
      id: tick.id,
      asset: tick.asset,
      hyperliquidBestBid: tick.hyperliquidBestBid,
      hyperliquidBestAsk: tick.hyperliquidBestAsk,
      hyperliquidMidPrice: tick.hyperliquidMidPrice,
      hyperliquidUpdatedAt: tick.hyperliquidUpdatedAt,
      chainlinkPrice: tick.chainlinkPrice,
      chainlinkUpdatedAt: tick.chainlinkUpdatedAt,
      captureSkewMs: tick.captureSkewMs,
      capturedAt: tick.capturedAt,
      source: "market",
    })),
  ];
  const grouped = groupBy(values, (tick) => tick.asset);
  for (const [asset, rows] of grouped) {
    const seen = new Set<string>();
    grouped.set(asset, rows
      .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime() || (left.source === "asset" ? -1 : 1))
      .filter((tick) => {
        const key = `${Math.round(tick.capturedAt.getTime() / 1_000)}:${tick.hyperliquidMidPrice}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
  }
  return grouped;
}

function selectCausalDecisionTick(ticks: RealtimeReplayMarketTick[], target: Date, maximumDelayMs: number) {
  return ticks.find((tick) => {
    const delay = tick.capturedAt.getTime() - target.getTime();
    if (delay < 0 || delay > maximumDelayMs || tick.captureSkewMs > realtimeShortTermReplaySpecification.maximumSourceAgeMs) return false;
    const sourceTimes = [
      tick.polymarketUpdatedAt,
      tick.negativeUpdatedAt,
      tick.hyperliquidUpdatedAt,
      tick.referenceUpdatedAt,
    ];
    return sourceTimes.every((updatedAt) => {
      const age = tick.capturedAt.getTime() - updatedAt.getTime();
      return age >= -5_000 && age <= realtimeShortTermReplaySpecification.maximumSourceAgeMs;
    });
  }) ?? null;
}

function selectCausalPriceTick(ticks: PriceTick[], target: Date, maximumDelayMs: number) {
  return ticks.find((tick) => {
    const delay = tick.capturedAt.getTime() - target.getTime();
    const age = tick.capturedAt.getTime() - tick.hyperliquidUpdatedAt.getTime();
    return delay >= 0 && delay <= maximumDelayMs && age >= -5_000 && age <= realtimeShortTermReplaySpecification.maximumSourceAgeMs;
  }) ?? null;
}

function selectPreferredCausalPriceTick(ticks: PriceTick[], target: Date, maximumDelayMs: number) {
  return selectCausalPriceTick(ticks.filter((tick) => tick.source === "asset"), target, maximumDelayMs)
    ?? selectCausalPriceTick(ticks.filter((tick) => tick.source === "market"), target, maximumDelayMs);
}

function selectCausalMarketPriceTick(ticks: RealtimeReplayMarketTick[], target: Date, maximumDelayMs: number): PriceTick | null {
  const tick = ticks.find((row) => {
    const delay = row.capturedAt.getTime() - target.getTime();
    return delay >= 0 && delay <= maximumDelayMs;
  });
  return tick ? {
    id: tick.id,
    asset: tick.asset,
    hyperliquidBestBid: tick.hyperliquidBestBid,
    hyperliquidBestAsk: tick.hyperliquidBestAsk,
    hyperliquidMidPrice: tick.hyperliquidMidPrice,
    hyperliquidUpdatedAt: tick.hyperliquidUpdatedAt,
    chainlinkPrice: tick.chainlinkPrice,
    chainlinkUpdatedAt: tick.chainlinkUpdatedAt,
    captureSkewMs: tick.captureSkewMs,
    capturedAt: tick.capturedAt,
    source: "market",
  } : null;
}

export function selectCausalReferenceBoundary(
  ticks: Array<Pick<RealtimeReplayMarketTick, "capturedAt" | "chainlinkPrice" | "chainlinkUpdatedAt" | "hyperliquidMidPrice">>,
  target: Date,
  knownBy: Date,
  maximumErrorMs: number,
) {
  const candidates = ticks.flatMap((tick) => {
    if (!positive(tick.chainlinkPrice) || !tick.chainlinkUpdatedAt || tick.capturedAt.getTime() > knownBy.getTime()) return [];
    const errorMs = Math.abs(tick.chainlinkUpdatedAt.getTime() - target.getTime());
    return tick.chainlinkUpdatedAt.getTime() <= knownBy.getTime() && errorMs <= maximumErrorMs
      ? [{ price: tick.chainlinkPrice, hyperliquidMidPrice: tick.hyperliquidMidPrice, updatedAt: tick.chainlinkUpdatedAt, errorMs }]
      : [];
  });
  return candidates.sort((left, right) => left.errorMs - right.errorMs || left.updatedAt.getTime() - right.updatedAt.getTime())[0] ?? null;
}

function selectAssetReferenceBoundary(ticks: PriceTick[], target: Date, maximumErrorMs: number) {
  const candidates = ticks.flatMap((tick) => {
    if (!positive(tick.chainlinkPrice) || !tick.chainlinkUpdatedAt) return [];
    const errorMs = Math.abs(tick.chainlinkUpdatedAt.getTime() - target.getTime());
    return errorMs <= maximumErrorMs ? [{ price: tick.chainlinkPrice, errorMs }] : [];
  });
  return candidates.sort((left, right) => left.errorMs - right.errorMs)[0] ?? null;
}

function estimateVolatility24h(ticks: PriceTick[], observedAt: Date, lookbackMinutes: number) {
  const start = observedAt.getTime() - lookbackMinutes * 60_000;
  const rows = ticks.filter((tick) => tick.capturedAt.getTime() >= start && tick.capturedAt.getTime() < observedAt.getTime());
  if (rows.length < realtimeShortTermReplaySpecification.minimumVolatilitySamples) {
    return realtimeShortTermReplaySpecification.fallbackVolatility24h;
  }
  const returns = rows.slice(1).map((row, index) => Math.log(row.hyperliquidMidPrice / rows[index].hyperliquidMidPrice)).filter(Number.isFinite);
  const elapsedMs = rows.at(-1)!.capturedAt.getTime() - rows[0].capturedAt.getTime();
  if (!returns.length || elapsedMs <= 0) return realtimeShortTermReplaySpecification.fallbackVolatility24h;
  const realized = Math.sqrt(sum(returns.map((value) => value ** 2)) * (24 * 60 * 60_000 / elapsedMs));
  return clamp(
    realized,
    realtimeShortTermReplaySpecification.minimumVolatility24h,
    realtimeShortTermReplaySpecification.maximumVolatility24h,
  );
}

function referencePrice(tick: RealtimeReplayMarketTick) {
  if (positive(tick.chainlinkPrice) && tick.chainlinkUpdatedAt) {
    const ageMs = tick.capturedAt.getTime() - tick.chainlinkUpdatedAt.getTime();
    if (ageMs >= -5_000 && ageMs <= realtimeShortTermReplaySpecification.maximumSourceAgeMs) return tick.chainlinkPrice;
  }
  return tick.referencePrice;
}

function maximumDrawdown(returns: number[]) {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak > 0 ? (peak - equity) / peak : 1);
  }
  return drawdown;
}

function medianWindowTrial(trials: Array<Array<{ windowAt: string; value: number }>>) {
  if (!trials.length) return [];
  return [...trials].sort((left, right) => sum(left.map((row) => row.value)) - sum(right.map((row) => row.value)))[Math.floor(trials.length / 2)];
}

function createSeededRandom(initialSeed: number) {
  let seed = Math.imul(initialSeed, 0x9e3779b9) >>> 0;
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const polynomial = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * polynomial - 1.453152027) * polynomial) + 1.421413741)
    * polynomial - 0.284496736) * polynomial + 0.254829592) * polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function variantId(strategy: RealtimeReplayStrategy, entryOffsetSeconds: number) {
  return `${strategy}-${entryOffsetSeconds}s`;
}

function groupBy<T>(values: T[], keyFor: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(keyFor(value), [...(grouped.get(keyFor(value)) ?? []), value]);
  return grouped;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function increment(values: Map<string, number>, key: string) {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function sha256Json(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : null;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function probability(value: number) {
  return Number.isFinite(value) && value > 0 && value < 1;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
