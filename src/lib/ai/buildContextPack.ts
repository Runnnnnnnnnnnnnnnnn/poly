import { getMarketDetailDashboard, getMarketsDashboard, getNewsDashboard } from "@/lib/server/dashboard";
import type { MarketDetail, MarketSummary } from "@/lib/types";
import { formatDate, formatPercent, formatUsd } from "@/lib/utils";
import { newsToSourceCard, type SourceCard } from "@/src/lib/ai/compressSource";

export type MarketBrief = {
  marketId: string;
  titleJa: string;
  originalTitle: string;
  oneLineSummary: string;
  beginnerExplanation: string;
  currentProbabilityExplanation: string;
  resolutionConditionSummary: string;
  mainWatchPoints: string[];
  relatedOfficialSources: SourceCard[];
  recentDevelopments: string[];
  positiveFactors: string[];
  negativeFactors: string[];
  uncertainties: string[];
  riskNotes: string[];
  suggestedQuestions: string[];
};

export type ContextPack = {
  retrievedAt: string;
  dataStatus: "live" | "fallback" | "error";
  markets: MarketSummary[];
  selectedMarket: MarketBrief | null;
  sourceCards: SourceCard[];
};

export async function buildContextPack(options: { marketId?: string; query?: string }) {
  const [markets, news] = await Promise.all([getMarketsDashboard(), getNewsDashboard()]);
  const selectedMarket = options.marketId
    ? await getMarketDetailDashboard(options.marketId).then((result) => result.market).catch(() => null)
    : null;
  const sourceCards = news.items.slice(0, 10).map(newsToSourceCard);

  return {
    retrievedAt: new Date().toISOString(),
    dataStatus: markets.status,
    markets: filterMarkets(markets.markets, options.query).slice(0, 8),
    selectedMarket: selectedMarket ? marketToBrief(selectedMarket, sourceCards) : null,
    sourceCards,
  } satisfies ContextPack;
}

export function marketToBrief(market: MarketDetail, sourceCards: SourceCard[]): MarketBrief {
  const relatedOfficialSources = sourceCards
    .filter((card) => card.relatedCategories.includes(market.category) || card.possibleRelatedMarkets.includes(market.title))
    .slice(0, 5);

  return {
    marketId: market.id,
    titleJa: market.title,
    originalTitle: market.originalTitle,
    oneLineSummary: market.summaryJa,
    beginnerExplanation: `${market.title} は、Polymarket上で将来の出来事に対する市場参加者の見方を価格として表している市場です。`,
    currentProbabilityExplanation: `現在のYES価格は ${market.yesPrice.toFixed(2)} で、期待確率の目安としては ${formatPercent(market.probability)} です。`,
    resolutionConditionSummary: market.description.slice(0, 500),
    mainWatchPoints: market.watchPoints,
    relatedOfficialSources,
    recentDevelopments: relatedOfficialSources.map((card) => `${card.source}: ${card.summary}`).slice(0, 4),
    positiveFactors: ["公式情報の更新で論点が明確になる可能性があります。"],
    negativeFactors: ["市場流動性やスプレッドが読み取りを難しくする場合があります。"],
    uncertainties: ["解決条件の解釈、情報更新タイミング、流動性は確認が必要です。"],
    riskNotes: [
      `出来高: ${formatUsd(market.volume)}、流動性: ${formatUsd(market.liquidity)}、締切: ${formatDate(market.endDate)}`,
      "これは投資助言ではありません。",
    ],
    suggestedQuestions: [
      "この市場を初心者向けに説明して",
      "解決条件を短く要約して",
      "関連する公式情報だけ教えて",
      "上司に1分で説明する文面にして",
    ],
  };
}

function filterMarkets(markets: MarketSummary[], query?: string) {
  if (!query) return markets;
  const normalized = query.toLowerCase();
  return markets.filter((market) =>
    [market.title, market.originalTitle, market.summaryJa, market.category].join(" ").toLowerCase().includes(normalized),
  );
}
