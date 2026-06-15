import type { MarketCategory } from "@/lib/types";

export const JAPAN_KEYWORDS_EN = [
  "Japan",
  "Japanese",
  "Tokyo",
  "JPY",
  "Yen",
  "BOJ",
  "Bank of Japan",
  "Nikkei",
  "Osaka",
  "Kyoto",
  "Japanese election",
  "Japan election",
  "Japanese politics",
  "Japan regulation",
  "Japan crypto",
  "Japan rates",
];

export const JAPAN_KEYWORDS_JA = [
  "日本",
  "日銀",
  "円",
  "為替",
  "金利",
  "政策金利",
  "参院選",
  "衆院選",
  "首相",
  "内閣",
  "金融庁",
  "経産省",
  "総務省",
  "デジタル庁",
  "暗号資産",
  "税制改正",
  "万博",
  "東京",
  "大阪",
];

export const MARKET_FILTERS = [
  "すべて",
  "世界",
  "日本",
  "政治",
  "金融",
  "規制",
  "テック",
  "イベント",
  "日銀",
  "為替",
  "暗号資産",
  "選挙",
  "高注目",
  "締切が近い順",
  "更新が新しい順",
] as const;

export const CATEGORY_KEYWORDS: Record<MarketCategory, string[]> = {
  政治: ["politic", "prime minister", "cabinet", "military", "geopolitic", "clash", "war", "内閣", "首相", "国会"],
  金融: ["rate", "inflation", "cpi", "金利", "インフレ", "金融"],
  規制: ["regulation", "law", "tax", "金融庁", "規制", "税制", "法改正"],
  テック: ["tech", "ai", "semiconductor", "digital", "半導体", "デジタル"],
  イベント: ["expo", "olympic", "event", "wta", "tennis", "open", "fifa", "nba", "nfl", "万博", "イベント"],
  日銀: ["boj", "bank of japan", "日銀", "植田"],
  為替: ["jpy", "yen", "usd/jpy", "為替", "円"],
  暗号資産: ["crypto", "bitcoin", "stablecoin", "暗号資産", "ステーブルコイン"],
  選挙: ["election", "vote", "参院選", "衆院選", "選挙"],
};

export const PRIMARY_MARKET_QUERIES = [
  "Bank of Japan",
  "Japan",
  "JPY",
  "Yen",
  "Japanese election",
  "Japan regulation",
  "Japan crypto",
  "Tokyo",
  "Osaka",
  "Nikkei",
];

export const GLOBAL_MARKET_QUERIES = [
  "United States",
  "Trump",
  "Fed",
  "Bitcoin",
  "crypto",
  "AI",
  "election",
  "World Cup",
  "interest rates",
  "geopolitics",
];
