import type { CryptoAsset } from "@/src/lib/backtest/types";

export type EvaluationSample = {
  eventId: string;
  marketId: string;
  asset: CryptoAsset;
  title: string;
  endAt: string;
  observedAt: string;
  marketProbability: number;
  horizonHours?: number;
  observationLagMinutes?: number | null;
  structuralProbability?: number | null;
  spotPrice?: number | null;
  realizedVolatility24h?: number | null;
  hyperliquidEntryAt?: string | null;
  hyperliquidEntryPrice?: number | null;
  hyperliquidExitAt?: string | null;
  hyperliquidExitPrice?: number | null;
  hyperliquidEntryLagMinutes?: number | null;
  hyperliquidExitLeadMinutes?: number | null;
  hyperliquidMomentum6h?: number | null;
  hyperliquidMomentum24h?: number | null;
  thresholdKind?: "above" | "below" | "between" | null;
  thresholdLower?: number | null;
  thresholdUpper?: number | null;
  outcome: 0 | 1;
};

export type ModelCandidate = {
  id: string;
  kind: "market" | "logit-pool" | "ridge-logit-pool";
  structuralWeight: number;
  regularization: number;
  coefficients?: [number, number, number];
};

export type CombinedStrategyCandidate = {
  id: string;
  minimumSignalZ: number;
  signalRule: "polymarket-only" | "trend-confirmed";
  minimumTrendZ: number;
  positionPct: number;
};

export type CombinedCandidateDiagnostic = {
  strategy: CombinedStrategyCandidate;
  validationSignals: number;
  trades: number;
  netReturnPct: number;
  benchmarkReturnPct: number;
  excessReturnPct: number;
  profitableFolds: number;
  deflatedSharpeProbability: number | null;
  confidenceInterval95: [number, number] | null;
  passed: boolean;
  gates: Array<{
    id: "trades" | "significance" | "benchmark" | "folds" | "selection-bias";
    label: string;
    passed: boolean;
  }>;
};

export type ModelEvaluationMetrics = {
  methodology: "chronological-holdout" | "walk-forward-holdout";
  horizonHours: number;
  modelVersion: string;
  selectedCandidate: ModelCandidate;
  dataset: {
    hash: string;
    totalEvents: number;
    trainEvents: number;
    validationEvents: number;
    testEvents: number;
    totalMarkets: number;
    trainMarkets: number;
    validationMarkets: number;
    testMarkets: number;
    firstEndAt: string;
    lastEndAt: string;
    assets: Record<string, number>;
    structuralFeatureMarkets: number;
    structuralFeatureCoverage: number;
    executionFeatureMarkets: number;
    executionFeatureCoverage: number;
    testExecutionFeatureMarkets: number;
    testExecutionFeatureCoverage: number;
    medianObservationLagMinutes: number | null;
    medianEntryLagMinutes: number | null;
    medianExitLeadMinutes: number | null;
    maximumExecutionTimingErrorMinutes: number | null;
    probabilityLadderEvents: number;
    probabilityLadderViolationEvents: number;
  };
  probability: {
    modelBrierScore: number;
    marketBrierScore: number;
    brierSkill: number;
    relativeImprovement: number;
    confidenceInterval95: [number, number];
    statisticallyPositive: boolean;
    modelLogLoss: number;
    marketLogLoss: number;
    modelAccuracy: number;
    marketAccuracy: number;
  };
  trading: {
    initialCapital: number;
    endingCapital: number;
    netReturnPct: number;
    trades: number;
    wins: number;
    winRate: number | null;
    maxDrawdownPct: number;
    totalFees: number;
    assumedHalfSpread: number;
    assumedSlippage: number;
    entryEdge: number;
  };
  combinedTrading: {
    selectedStrategy: CombinedStrategyCandidate;
    selectedFromValidation: boolean;
    totalEligibleSignals: number;
    validationEligibleSignals: number;
    closestValidationCandidate: CombinedStrategyCandidate | null;
    candidateDiagnostics: CombinedCandidateDiagnostic[];
    eligibleSignals: number;
    initialCapital: number;
    endingCapital: number;
    netReturnPct: number;
    benchmarkReturnPct: number;
    excessReturnPct: number;
    benchmarks: {
      alwaysLongReturnPct: number;
      alwaysShortReturnPct: number;
      alternatingReturnPct: number;
      bestReturnPct: number;
      bestLabel: "常時ロング" | "常時ショート" | "交互売買";
    };
    trades: number;
    longTrades: number;
    shortTrades: number;
    wins: number;
    winRate: number | null;
    directionalAccuracy: number | null;
    averageNetTradeReturn: number | null;
    returnConfidenceInterval95: [number, number] | null;
    statisticallyPositive: boolean;
    deflatedSharpeProbability: number | null;
    walkForwardFolds: number;
    profitableValidationFolds: number;
    minimumRequiredTrades: number;
    maxDrawdownPct: number;
    totalFees: number;
    totalSlippage: number;
    totalFunding: number;
    assumedTakerFeePerSide: number;
    assumedSlippagePerSide: number;
    assumedFundingPer24h: number;
  };
  quality: {
    status: "promising" | "inconclusive" | "underperforming";
    gates: Array<{ id: string; label: string; passed: boolean }>;
  };
  horizonStudies?: Array<{
    horizonHours: number;
    status: "promising" | "inconclusive" | "underperforming" | "unavailable";
    totalEvents: number;
    testEvents: number;
    eligibleSignals: number;
    trades: number;
    netReturnPct: number | null;
    bestBenchmarkReturnPct: number | null;
    excessReturnPct: number | null;
    deflatedSharpeProbability: number | null;
    testExecutionFeatureCoverage: number | null;
    maximumExecutionTimingErrorMinutes: number | null;
    error?: string;
  }>;
};

export type ModelEvaluationResult = {
  id: string;
  modelVersion: string;
  status: string;
  datasetHash: string | null;
  startedAt: string;
  completedAt: string | null;
  metrics: ModelEvaluationMetrics | null;
  error: string | null;
};
