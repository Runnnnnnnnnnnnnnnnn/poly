import type { CryptoAsset } from "@/src/lib/backtest/types";

export type EvaluationSample = {
  eventId: string;
  marketId: string;
  asset: CryptoAsset;
  title: string;
  endAt: string;
  observedAt: string;
  marketProbability: number;
  structuralProbability?: number | null;
  spotPrice?: number | null;
  realizedVolatility24h?: number | null;
  hyperliquidEntryAt?: string | null;
  hyperliquidEntryPrice?: number | null;
  hyperliquidExitAt?: string | null;
  hyperliquidExitPrice?: number | null;
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
  positionPct: number;
};

export type ModelEvaluationMetrics = {
  methodology: "chronological-holdout";
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
    eligibleSignals: number;
    initialCapital: number;
    endingCapital: number;
    netReturnPct: number;
    benchmarkReturnPct: number;
    excessReturnPct: number;
    trades: number;
    longTrades: number;
    shortTrades: number;
    wins: number;
    winRate: number | null;
    directionalAccuracy: number | null;
    averageNetTradeReturn: number | null;
    returnConfidenceInterval95: [number, number] | null;
    statisticallyPositive: boolean;
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
