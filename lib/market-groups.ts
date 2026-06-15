import type { MarketCategory, MarketScope, MarketSummary } from "@/lib/types";

export const MARKET_THEME_TABS = [
  { id: "featured", label: "注目", description: "出来高・流動性・関連市場数から優先して表示" },
  { id: "japan", label: "日本国内", description: "日銀、為替、選挙、規制など日本に関係するテーマ" },
  { id: "global", label: "国外", description: "海外政治、金融、テック、暗号資産などのテーマ" },
  { id: "sports", label: "スポーツ", description: "大会、試合、優勝予想などのスポーツ市場" },
  { id: "finance", label: "金融・為替", description: "金利、為替、株価指数、インフレ関連" },
  { id: "politics", label: "政治・地政学", description: "選挙、政策、国際情勢、規制関連" },
  { id: "crypto", label: "暗号資産", description: "Bitcoin、Ethereum、規制、価格帯関連" },
  { id: "tech", label: "テック", description: "AI、半導体、主要テック企業関連" },
  { id: "all", label: "すべて", description: "グループ化した全テーマ" },
] as const;

export type MarketThemeTabId = (typeof MARKET_THEME_TABS)[number]["id"];
export type MarketTagId = Exclude<MarketThemeTabId, "featured" | "all">;

export type MarketThemeGroup = {
  id: string;
  label: string;
  summary: string;
  primaryMarket: MarketSummary;
  markets: MarketSummary[];
  tags: MarketTagId[];
  scope: MarketScope | "mixed";
  category: MarketCategory;
  totalVolume: number;
  totalLiquidity: number;
  probabilityMin: number;
  probabilityMax: number;
  rank: number;
};

type MarketThemeGroupDraft = {
  id: string;
  markets: MarketSummary[];
  tags: Set<MarketTagId>;
};

const KNOWN_GROUP_LABELS: Record<string, string> = {
  "theme:usd-jpy": "USD/JPYの水準・レンジ",
  "theme:nikkei-225": "日経平均・日本株指数",
  "theme:boj-policy": "日銀の金融政策",
  "theme:japan-election": "日本の選挙・政局",
  "theme:japan-crypto-regulation": "日本の暗号資産規制",
  "theme:fed-policy": "FRBの金融政策",
  "theme:bitcoin-price": "ビットコインの価格帯",
  "theme:ethereum-price": "イーサリアムの価格帯",
  "theme:solana-price": "Solanaの価格帯",
  "theme:world-cup-2026": "2026年FIFAワールドカップ",
  "theme:us-politics": "米国政治・選挙",
  "theme:iran-geopolitics": "中東・地政学",
  "theme:ai-tech": "AI・半導体テーマ",
  "theme:oil-gold": "原油・金などコモディティ",
};

const TAG_LABELS: Record<MarketTagId, string> = Object.fromEntries(
  MARKET_THEME_TABS.filter((tab) => tab.id !== "featured" && tab.id !== "all").map((tab) => [tab.id, tab.label]),
) as Record<MarketTagId, string>;

export function groupMarkets(markets: MarketSummary[]) {
  const drafts = new Map<string, MarketThemeGroupDraft>();

  for (const market of markets) {
    const id = getMarketGroupKey(market);
    const draft = drafts.get(id) ?? { id, markets: [], tags: new Set<MarketTagId>() };
    draft.markets.push(market);
    for (const tag of getMarketTags(market)) draft.tags.add(tag);
    drafts.set(id, draft);
  }

  return Array.from(drafts.values())
    .map(finalizeGroup)
    .sort((a, b) => b.rank - a.rank);
}

export function filterMarketGroups(groups: MarketThemeGroup[], tabId: MarketThemeTabId) {
  if (tabId === "all") return groups;
  if (tabId === "featured") return groups.slice(0, 12);
  return groups.filter((group) => group.tags.includes(tabId));
}

export function labelForMarketTag(tag: MarketTagId) {
  return TAG_LABELS[tag];
}

function finalizeGroup(draft: MarketThemeGroupDraft): MarketThemeGroup {
  const markets = [...draft.markets].sort((a, b) => b.volume + b.liquidity - (a.volume + a.liquidity));
  const primaryMarket = markets[0];
  const totalVolume = markets.reduce((sum, market) => sum + market.volume, 0);
  const totalLiquidity = markets.reduce((sum, market) => sum + market.liquidity, 0);
  const probabilities = markets.map((market) => market.probability);
  const scopes = new Set(markets.map((market) => market.scope));
  const label = KNOWN_GROUP_LABELS[draft.id] ?? trimQuestion(primaryMarket.title);
  const summary =
    markets.length > 1
      ? `${label}に関連する個別市場を${markets.length}件まとめています。価格帯や条件の違いを同じテーマ内で比較できます。`
      : primaryMarket.summaryJa;

  return {
    id: draft.id,
    label,
    summary,
    primaryMarket,
    markets,
    tags: Array.from(draft.tags),
    scope: scopes.size === 1 ? primaryMarket.scope : "mixed",
    category: primaryMarket.category,
    totalVolume,
    totalLiquidity,
    probabilityMin: Math.min(...probabilities),
    probabilityMax: Math.max(...probabilities),
    rank: totalVolume + totalLiquidity * 0.45 + Math.max(0, markets.length - 1) * 50_000,
  };
}

function getMarketGroupKey(market: MarketSummary) {
  const text = normalizedMarketText(market);

  if (matches(text, ["usd/jpy", "usdjpy", "dollar yen", "dollar/yen"]) || (matches(text, ["yen", "jpy"]) && /\b1[3-8]\d\b/.test(text))) {
    return "theme:usd-jpy";
  }
  if (matches(text, ["nikkei", "日経", "japan 225", "japanese stocks"])) return "theme:nikkei-225";
  if (matches(text, ["bank of japan", "boj", "ueda", "日銀", "植田"])) return "theme:boj-policy";
  if (matches(text, ["japan election", "japanese election", "参院", "衆院", "japan prime minister", "首相", "内閣"])) {
    return "theme:japan-election";
  }
  if (market.scope === "japan" && matches(text, ["crypto", "bitcoin", "stablecoin", "暗号資産", "ステーブルコイン", "金融庁"])) {
    return "theme:japan-crypto-regulation";
  }
  if (matches(text, ["fomc", "fed", "federal reserve", "interest rate", "rate cut", "rate hike"])) return "theme:fed-policy";
  if (matches(text, ["bitcoin", "btc"])) return "theme:bitcoin-price";
  if (matches(text, ["ethereum", "ether", "eth"])) return "theme:ethereum-price";
  if (matches(text, ["solana", "sol"])) return "theme:solana-price";
  if (matches(text, ["world cup", "fifa"])) return "theme:world-cup-2026";
  if (matches(text, ["trump", "biden", "us election", "u.s. election", "midterm", "republican", "democrat"])) {
    return "theme:us-politics";
  }
  if (matches(text, ["iran", "israel", "ukraine", "russia", "ceasefire", "peace deal", "geopolitic"])) return "theme:iran-geopolitics";
  if (matches(text, ["nvidia", "openai", "ai", "semiconductor", "chip", "半導体"])) return "theme:ai-tech";
  if (matches(text, ["oil", "crude", "gold", "commodity"])) return "theme:oil-gold";

  return `market:${market.scope}:${market.category}:${slugPart(market.slug || market.id)}`;
}

function getMarketTags(market: MarketSummary): MarketTagId[] {
  const text = normalizedMarketText(market);
  const tags = new Set<MarketTagId>();

  tags.add(market.scope === "japan" ? "japan" : "global");

  if (isSportsMarket(text)) tags.add("sports");
  if (["金融", "日銀", "為替"].includes(market.category) || matches(text, ["rate", "inflation", "cpi", "jpy", "yen", "nikkei", "stock", "gold", "oil"])) {
    tags.add("finance");
  }
  if (["政治", "規制", "選挙"].includes(market.category) || matches(text, ["election", "vote", "war", "peace", "ceasefire", "regulation", "tax", "geopolitic"])) {
    tags.add("politics");
  }
  if (market.category === "暗号資産" || matches(text, ["crypto", "bitcoin", "ethereum", "solana", "stablecoin", "暗号資産"])) tags.add("crypto");
  if (market.category === "テック" || matches(text, ["ai", "nvidia", "openai", "semiconductor", "chip", "tech", "半導体"])) tags.add("tech");

  return Array.from(tags);
}

function isSportsMarket(text: string) {
  return matches(text, [
    "fifa",
    "world cup",
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "premier league",
    "champions league",
    "tennis",
    "wimbledon",
    "us open",
    "french open",
    "super bowl",
    "olympic",
  ]);
}

function normalizedMarketText(market: MarketSummary) {
  return [market.title, market.originalTitle, market.summaryJa, market.themeLabel, market.category, market.slug].join(" ").toLowerCase();
}

function matches(text: string, words: string[]) {
  return words.some((word) => text.includes(word.toLowerCase()));
}

function slugPart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function trimQuestion(value: string) {
  return value.replace(/[?？]\s*$/u, "");
}
