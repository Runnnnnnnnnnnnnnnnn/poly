export type DataStatus = "live" | "fallback" | "error";
export type MarketScope = "global" | "japan";

export type MarketCategory =
  | "政治"
  | "金融"
  | "規制"
  | "テック"
  | "イベント"
  | "日銀"
  | "為替"
  | "暗号資産"
  | "選挙";

export type NewsKind = "公式情報" | "報道" | "市場情報";

export type SourceStatus = {
  source: string;
  status: DataStatus;
  message?: string;
};

export type ChartPoint = {
  label: string;
  value: number;
};

export type MarketSummary = {
  id: string;
  slug: string;
  title: string;
  originalTitle: string;
  summaryJa: string;
  scope: MarketScope;
  imageUrl: string;
  themeLabel: string;
  category: MarketCategory;
  probability: number;
  yesPrice: number;
  noPrice: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume: number;
  volume24h: number | null;
  volume1w: number | null;
  volume1m: number | null;
  liquidity: number;
  endDate: string | null;
  updatedAt: string;
  relatedNewsCount: number;
  status: DataStatus;
  source: string;
  url: string;
};

export type MarketDetail = MarketSummary & {
  description: string;
  resolutionSource: string;
  clobTokenIds: string[];
  outcomes: string[];
  priceHistory: ChartPoint[];
  volumeHistory: ChartPoint[];
  officialInfo: NewsItem[];
  relatedNews: NewsItem[];
  watchPoints: string[];
};

export type MarketsResponse = {
  status: DataStatus;
  updatedAt: string;
  markets: MarketSummary[];
  globalMarkets: MarketSummary[];
  japanMarkets: MarketSummary[];
  sourceStatuses: SourceStatus[];
};

export type NewsItem = {
  id: string;
  title: string;
  source: string;
  publishedAt: string | null;
  url: string;
  category: MarketCategory | "政策";
  relatedMarket: string | null;
  summary: string;
  kind: NewsKind;
  status: DataStatus;
};

export type NewsResponse = {
  status: DataStatus;
  updatedAt: string;
  items: NewsItem[];
  sourceStatuses: SourceStatus[];
};

export type RateResponse = {
  status: DataStatus;
  updatedAt: string;
  usdJpy: number;
  source: string;
};

export type AiEvaluationRating = "YES寄り" | "NO寄り" | "様子見";
export type AiEvaluationConfidence = "高" | "中" | "低";

export type MarketAiEvaluation = {
  id: string;
  tabId: string;
  tabLabel: string;
  marketId: string;
  title: string;
  category: MarketCategory;
  themeLabel: string;
  marketProbability: number;
  aiProbability: number;
  yesMultiplier: number | null;
  noMultiplier: number | null;
  expectedReturnYes: number | null;
  expectedReturnNo: number | null;
  rating: AiEvaluationRating;
  confidence: AiEvaluationConfidence;
  reasons: string[];
  evidence: string[];
  historySignals: {
    points: number;
    firstProbability: number | null;
    latestProbability: number | null;
    change7d: number | null;
    high7d: number | null;
    low7d: number | null;
  };
  scoreBreakdown: {
    liquidity: number;
    momentum: number;
    news: number;
    spreadPenalty: number;
  };
  evaluatedAt: string;
  model: string;
  status: DataStatus;
};

export type MarketAiEvaluationHistoryEntry = {
  id: string;
  marketId: string;
  tabLabel: string;
  title: string;
  marketProbability: number;
  aiProbability: number;
  expectedReturnYes: number | null;
  expectedReturnNo: number | null;
  rating: AiEvaluationRating;
  confidence: AiEvaluationConfidence;
  evaluatedAt: string;
  recordedAt: string;
  model: string;
  status: DataStatus;
  resolvedOutcome: 0 | 1 | null;
  brierScore: number | null;
};

export type MarketAiEvaluationHistorySummary = {
  total: number;
  pending: number;
  resolved: number;
  averageBrierScore: number | null;
  latestRecordedAt: string | null;
};

export type MarketAiEvaluationsResponse = {
  status: DataStatus;
  updatedAt: string;
  model: string;
  items: MarketAiEvaluation[];
  history: MarketAiEvaluationHistoryEntry[];
  historySummary: MarketAiEvaluationHistorySummary;
  sourceStatuses: SourceStatus[];
};
