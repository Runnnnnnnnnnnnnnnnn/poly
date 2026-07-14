export type CryptoAsset = "BTC" | "ETH" | "SOL" | "XRP" | "OTHER";

export type CryptoMarket = {
  id: string;
  asset: CryptoAsset;
  tokenId: string;
  noTokenId: string | null;
  title: string;
  slug: string | null;
  endDate: string | null;
  resolved: boolean;
  result: 0 | 1 | null;
  currentProbability: number | null;
  volume: number;
  liquidity: number;
  bestBid: number | null;
  bestAsk: number | null;
  minOrderSize: number;
  tickSize: number;
  feesEnabled: boolean;
};

export type HistoricalProbability = {
  timestamp: string;
  probability: number;
};

export type BacktestMetrics = {
  markets: number;
  observations: number;
  accuracy: number | null;
  brierScore: number | null;
  logLoss: number | null;
  calibration: Array<{ bucket: string; predicted: number; actual: number; count: number }>;
  tradedMarkets: number;
  totalPnl: number;
  returnPct: number;
};

export type BacktestResult = {
  id: string;
  asset: CryptoAsset;
  status: string;
  threshold: number;
  initialCapital: number;
  startedAt: string;
  completedAt: string | null;
  metrics: BacktestMetrics | null;
  markets: Array<{
    marketId: string;
    title: string;
    result: 0 | 1;
    observations: number;
    firstProbability: number | null;
    lastProbability: number | null;
  }>;
  error: string | null;
};

export type CryptoForecast = {
  asset: CryptoAsset;
  targetDate: string | null;
  marketCount: number;
  impliedMedian: number | null;
  quantiles: { p10: number | null; p25: number | null; p75: number | null; p90: number | null };
  curve: Array<{ marketId: string; title: string; threshold: number; probability: number }>;
  generatedAt: string;
};

export type PaperStrategyConfig = {
  initialCash: number;
  entryEdge: number;
  maxPositionPct: number;
  spreadBps: number;
  slippageBps: number;
  takerFeeRate: number;
  minTrainingMarkets: number;
  calibrationPrior: number;
  maxMarkets: number;
};

export type PaperRunMetrics = {
  startingCash: number;
  endingCash: number;
  totalReturn: number;
  totalReturnPct: number;
  orders: number;
  filledOrders: number;
  rejectedOrders: number;
  settledMarkets: number;
  winningMarkets: number;
  losingMarkets: number;
  winRate: number | null;
  totalFees: number;
  maxDrawdownPct: number;
  sharpeLike: number | null;
  brierScore: number | null;
  logLoss: number | null;
};
