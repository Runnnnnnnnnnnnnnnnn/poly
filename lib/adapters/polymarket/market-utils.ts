import { CATEGORY_KEYWORDS, JAPAN_KEYWORDS_EN, JAPAN_KEYWORDS_JA } from "@/lib/constants";
import type { MarketCategory, MarketScope, MarketSummary } from "@/lib/types";
import { toNumber } from "@/lib/utils";

export type NormalizedMarket = MarketSummary & {
  description: string;
  resolutionSource: string;
  clobTokenIds: string[];
  outcomes: string[];
};

export function dedupeMarkets(markets: Array<NormalizedMarket | null>) {
  const seen = new Set<string>();
  return markets.filter((market): market is NormalizedMarket => {
    if (!market) return false;
    if (seen.has(market.id)) return false;
    seen.add(market.id);
    return true;
  });
}

export function dedupeSummariesByTitle(markets: MarketSummary[]) {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = market.title.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isRelevantMarket(market: NormalizedMarket) {
  const haystack = [market.originalTitle, market.description, market.resolutionSource].join(" ").toLowerCase();
  return JAPAN_KEYWORDS_EN.some((keyword) => keywordMatches(haystack, keyword)) || JAPAN_KEYWORDS_JA.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function marketPriority(market: MarketSummary) {
  const categoryWeight: Record<MarketCategory, number> = {
    日銀: 900,
    為替: 800,
    規制: 700,
    選挙: 650,
    政治: 600,
    暗号資産: 550,
    金融: 500,
    テック: 350,
    イベント: 100,
  };
  return categoryWeight[market.category] * 1_000_000 + market.volume + market.liquidity;
}

export function stripDetailFields(market: NormalizedMarket): MarketSummary {
  return {
    id: market.id,
    slug: market.slug,
    title: market.title,
    originalTitle: market.originalTitle,
    summaryJa: market.summaryJa,
    scope: market.scope,
    imageUrl: market.imageUrl,
    themeLabel: market.themeLabel,
    category: market.category,
    probability: market.probability,
    yesPrice: market.yesPrice,
    noPrice: market.noPrice,
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    spread: market.spread,
    volume: market.volume,
    volume24h: market.volume24h,
    volume1w: market.volume1w,
    volume1m: market.volume1m,
    liquidity: market.liquidity,
    endDate: market.endDate,
    updatedAt: market.updatedAt,
    relatedNewsCount: market.relatedNewsCount,
    status: market.status,
    source: market.source,
    url: market.url,
  };
}

export function findYesIndex(outcomes: string[]) {
  const index = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  return index >= 0 ? index : 0;
}

export function findNoIndex(outcomes: string[]) {
  const index = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");
  return index >= 0 ? index : 1;
}

export function categorize(text: string): MarketCategory {
  const normalized = text.toLowerCase();
  const category = (Object.entries(CATEGORY_KEYWORDS) as Array<[MarketCategory, string[]]>).find(([, keywords]) =>
    keywords.some((keyword) => keywordMatches(normalized, keyword)),
  );
  return category?.[0] ?? "イベント";
}

export function nullableNumber(value: unknown) {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function estimateRelatedNewsCount(category: MarketCategory, text: string) {
  const base = category === "日銀" || category === "規制" || category === "選挙" ? 3 : 2;
  const keywordBonus = JAPAN_KEYWORDS_JA.filter((keyword) => text.includes(keyword)).length;
  return Math.min(8, base + keywordBonus);
}

export function inferScope(text: string): MarketScope {
  const normalized = text.toLowerCase();
  return JAPAN_KEYWORDS_EN.some((keyword) => keywordMatches(normalized, keyword)) || JAPAN_KEYWORDS_JA.some((keyword) => normalized.includes(keyword.toLowerCase()))
    ? "japan"
    : "global";
}

export function buildSummaryJa(_title: string, category: MarketCategory, scope: MarketScope) {
  const categoryCopy: Record<MarketCategory, string> = {
    政治: "政治や国際情勢の変化を市場参加者がどう見ているかを確認できます。",
    金融: "金利、物価、金融環境への見方を価格と出来高から確認できます。",
    規制: "法改正、規制、行政判断に関する期待を整理できます。",
    テック: "テクノロジーや企業ニュースへの市場の反応を確認できます。",
    イベント: "スポーツ、社会イベント、注目ニュースへの見方を追えます。",
    日銀: "日本銀行の政策判断や金融政策イベントへの見方を確認できます。",
    為替: "円相場や主要通貨の水準に関する市場の見方を確認できます。",
    暗号資産: "暗号資産やWeb3関連テーマへの期待を確認できます。",
    選挙: "選挙や政党勢力に関する見方を整理できます。",
  };
  const region = scope === "global" ? "世界の注目テーマ" : "日本関連テーマ";
  return `${region}です。${categoryCopy[category]}`;
}

export function themeLabel(category: MarketCategory) {
  const labels: Record<MarketCategory, string> = {
    政治: "政治・地政学",
    金融: "金融",
    規制: "規制",
    テック: "テック",
    イベント: "イベント",
    日銀: "日銀",
    為替: "為替",
    暗号資産: "暗号資産",
    選挙: "選挙",
  };
  return labels[category];
}

export function themeImage(category: MarketCategory, scope: MarketScope) {
  const images: Record<MarketCategory, string> = {
    政治: "https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?auto=format&fit=crop&w=900&q=80",
    金融: "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?auto=format&fit=crop&w=900&q=80",
    規制: "https://images.unsplash.com/photo-1589829545856-d10d557cf95f?auto=format&fit=crop&w=900&q=80",
    テック: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=80",
    イベント: "https://images.unsplash.com/photo-1461896836934-ffe607ba8211?auto=format&fit=crop&w=900&q=80",
    日銀: "https://images.unsplash.com/photo-1542051841857-5f90071e7989?auto=format&fit=crop&w=900&q=80",
    為替: "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?auto=format&fit=crop&w=900&q=80",
    暗号資産: "https://images.unsplash.com/photo-1518546305927-5a555bb7020d?auto=format&fit=crop&w=900&q=80",
    選挙: "https://images.unsplash.com/photo-1540910419892-4a36d2c3266c?auto=format&fit=crop&w=900&q=80",
  };
  return scope === "japan" && category === "イベント"
    ? "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=900&q=80"
    : images[category];
}

function keywordMatches(text: string, keyword: string) {
  const normalizedKeyword = keyword.toLowerCase();
  if (/^[a-z0-9 /.-]+$/i.test(normalizedKeyword)) {
    return new RegExp(`\\b${escapeRegExp(normalizedKeyword)}\\b`, "i").test(text);
  }
  return text.includes(normalizedKeyword);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
