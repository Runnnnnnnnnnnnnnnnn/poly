import type { MarketCategory, NewsItem } from "@/lib/types";

export type SourceCard = {
  title: string;
  source: string;
  publishedAt: string | null;
  retrievedAt: string;
  url: string;
  sourceType: "公式情報" | "報道" | "市場情報";
  summary: string;
  keyFacts: string[];
  relatedKeywords: string[];
  relatedCategories: Array<MarketCategory | "政策">;
  possibleRelatedMarkets: string[];
  relevanceScore: number;
  reliability: "high" | "medium" | "low";
  whyItMatters: string;
  notableUncertainties: string[];
};

export function newsToSourceCard(item: NewsItem): SourceCard {
  return {
    title: item.title,
    source: item.source,
    publishedAt: item.publishedAt,
    retrievedAt: new Date().toISOString(),
    url: item.url,
    sourceType: item.kind,
    summary: item.summary,
    keyFacts: [item.summary].filter(Boolean),
    relatedKeywords: keywordsForText(`${item.title} ${item.summary}`),
    relatedCategories: [item.category],
    possibleRelatedMarkets: item.relatedMarket ? [item.relatedMarket] : [],
    relevanceScore: item.status === "live" ? 0.8 : 0.45,
    reliability: item.kind === "公式情報" ? "high" : "medium",
    whyItMatters: "市場価格の背景にある一次情報や制度変更を確認する材料になります。",
    notableUncertainties: item.status === "live" ? [] : ["fallback data のため最新性は確認が必要です。"],
  };
}

function keywordsForText(text: string) {
  const candidates = ["日銀", "円", "為替", "金利", "暗号資産", "規制", "選挙", "日本銀行", "日経", "Reuters", "Bloomberg"];
  return candidates.filter((keyword) => text.includes(keyword)).slice(0, 8);
}
