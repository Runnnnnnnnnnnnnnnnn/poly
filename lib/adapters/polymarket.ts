import { z } from "zod";

import {
  CATEGORY_KEYWORDS,
  JAPAN_KEYWORDS_EN,
  JAPAN_KEYWORDS_JA,
  PRIMARY_MARKET_QUERIES,
} from "@/lib/constants";
import { fallbackDetail, fallbackMarkets } from "@/lib/sample-data";
import type {
  ChartPoint,
  DataStatus,
  MarketCategory,
  MarketDetail,
  MarketSummary,
  NewsItem,
  SourceStatus,
} from "@/lib/types";
import { clamp, fetchWithTimeout, safeJsonArray, toNumber } from "@/lib/utils";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

const gammaMarketSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    question: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().nullable().optional(),
    resolutionSource: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    outcomes: z.unknown().optional(),
    outcomePrices: z.unknown().optional(),
    clobTokenIds: z.unknown().optional(),
    volume: z.union([z.string(), z.number()]).optional(),
    volumeNum: z.number().optional(),
    volume24hr: z.union([z.string(), z.number()]).optional(),
    volume1wk: z.union([z.string(), z.number()]).optional(),
    volume1mo: z.union([z.string(), z.number()]).optional(),
    liquidity: z.union([z.string(), z.number()]).optional(),
    liquidityNum: z.number().optional(),
    active: z.boolean().optional(),
    closed: z.boolean().optional(),
    archived: z.boolean().optional(),
    enableOrderBook: z.boolean().optional(),
  })
  .passthrough();

const gammaEventSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    markets: z.array(gammaMarketSchema).optional(),
    tags: z.array(z.object({ label: z.string().optional(), slug: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const publicSearchSchema = z.object({
  events: z.array(gammaEventSchema).default([]),
});

const spreadSchema = z.object({
  spread: z.union([z.string(), z.number()]).optional(),
});

const bookSchema = z
  .object({
    bids: z.array(z.object({ price: z.string(), size: z.string() })).optional(),
    asks: z.array(z.object({ price: z.string(), size: z.string() })).optional(),
  })
  .passthrough();

const priceHistorySchema = z.object({
  history: z
    .array(
      z.object({
        t: z.number(),
        p: z.number(),
      }),
    )
    .default([]),
});

type GammaMarket = z.infer<typeof gammaMarketSchema>;
type GammaEvent = z.infer<typeof gammaEventSchema>;

type NormalizedMarket = MarketSummary & {
  description: string;
  resolutionSource: string;
  clobTokenIds: string[];
  outcomes: string[];
};

export async function fetchJapanMarkets(): Promise<{
  markets: MarketSummary[];
  status: DataStatus;
  sourceStatuses: SourceStatus[];
}> {
  const sourceStatuses: SourceStatus[] = [];

  try {
    const events = await fetchSearchEvents();
    const normalized = dedupeMarkets(
      events.flatMap((event) =>
        (event.markets ?? []).map((market) => normalizeMarket(market, event)),
      ),
    )
      .filter(Boolean)
      .filter((market): market is NormalizedMarket => Boolean(market))
      .filter(isRelevantMarket)
      .filter((market) => !market.endDate || new Date(market.endDate).getTime() > Date.now() - 1000 * 60 * 60 * 24 * 60)
      .sort((a, b) => marketPriority(b) - marketPriority(a))
      .slice(0, 18);

    if (normalized.length === 0) {
      sourceStatuses.push({
        source: "Polymarket Gamma API",
        status: "fallback",
        message: "日本関連の live 市場が見つからなかったため fallback を表示",
      });
      return {
        markets: fallbackMarkets,
        status: "fallback",
        sourceStatuses,
      };
    }

    const enriched = await enrichMarketsWithClob(normalized);
    sourceStatuses.push({
      source: "Polymarket Gamma API",
      status: "live",
      message: `${normalized.length} markets`,
    });
    sourceStatuses.push({
      source: "Polymarket CLOB public read endpoints",
      status: enriched.some((market) => market.spread !== null) ? "live" : "fallback",
      message: "spread/book enrichment",
    });

    return {
      markets: enriched.map(stripDetailFields),
      status: "live",
      sourceStatuses,
    };
  } catch (error) {
    sourceStatuses.push({
      source: "Polymarket APIs",
      status: "error",
      message: error instanceof Error ? error.message : "unknown error",
    });
    return {
      markets: fallbackMarkets,
      status: "fallback",
      sourceStatuses,
    };
  }
}

export async function fetchMarketDetail(
  id: string,
  newsItems: NewsItem[] = [],
): Promise<{ market: MarketDetail; status: DataStatus; sourceStatuses: SourceStatus[] }> {
  const sourceStatuses: SourceStatus[] = [];

  try {
    const response = await fetchWithTimeout(`${GAMMA_API}/markets/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Gamma market ${response.status}`);
    const parsed = gammaMarketSchema.parse(await response.json());
    const normalized = normalizeMarket(parsed, {
      id: parsed.id,
      title: parsed.question,
      slug: parsed.slug,
      description: parsed.description,
      endDate: parsed.endDate,
      updatedAt: parsed.updatedAt,
      markets: [parsed],
      tags: [],
    });

    if (!normalized) throw new Error("market payload could not be normalized");

    const [enriched] = await enrichMarketsWithClob([normalized]);
    const priceHistory = await fetchPriceHistory(enriched.clobTokenIds[0], enriched.probability);
    const relatedNews = relateNews(enriched, newsItems);

    sourceStatuses.push({ source: "Polymarket Gamma API", status: "live" });
    sourceStatuses.push({
      source: "Polymarket CLOB public read endpoints",
      status: priceHistory.length > 0 ? "live" : "fallback",
    });

    return {
      market: {
        ...stripDetailFields(enriched),
        description: enriched.description,
        resolutionSource: enriched.resolutionSource,
        clobTokenIds: enriched.clobTokenIds,
        outcomes: enriched.outcomes,
        priceHistory: priceHistory.length > 0 ? priceHistory : fallbackDetail(enriched.id).priceHistory,
        volumeHistory: buildVolumeHistory(enriched),
        officialInfo: relatedNews.filter((item) => item.kind === "公式情報").slice(0, 4),
        relatedNews: relatedNews.slice(0, 8),
        watchPoints: buildWatchPoints(enriched),
      },
      status: "live",
      sourceStatuses,
    };
  } catch (error) {
    sourceStatuses.push({
      source: "Polymarket market detail",
      status: "error",
      message: error instanceof Error ? error.message : "unknown error",
    });
    return {
      market: fallbackDetail(id),
      status: "fallback",
      sourceStatuses,
    };
  }
}

async function fetchSearchEvents() {
  const results = await Promise.allSettled(
    PRIMARY_MARKET_QUERIES.map(async (query) => {
      const url = new URL(`${GAMMA_API}/public-search`);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "10");
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) throw new Error(`public-search ${query}: ${response.status}`);
      return publicSearchSchema.parse(await response.json()).events;
    }),
  );

  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

function normalizeMarket(market: GammaMarket, event: GammaEvent): NormalizedMarket | null {
  const outcomes = safeJsonArray(market.outcomes);
  const prices = safeJsonArray(market.outcomePrices).map((price) => toNumber(price));
  const clobTokenIds = safeJsonArray(market.clobTokenIds);
  const yesIndex = findYesIndex(outcomes);
  const noIndex = findNoIndex(outcomes);
  const yesPrice = clamp(prices[yesIndex] ?? prices[0] ?? 0, 0, 1);
  const noPrice = clamp(prices[noIndex] ?? prices[1] ?? 1 - yesPrice, 0, 1);
  const originalTitle = market.question || event.title || "Untitled market";
  const text = [originalTitle, event.title, market.description, event.description].filter(Boolean).join(" ");
  const category = categorize(text);
  const volume = toNumber(market.volumeNum ?? market.volume);
  const liquidity = toNumber(market.liquidityNum ?? market.liquidity);

  if (market.archived || (!market.active && market.closed)) return null;

  return {
    id: String(market.id),
    slug: market.slug || String(market.id),
    title: toJapaneseTitle(originalTitle, category),
    originalTitle,
    summaryJa: buildSummaryJa(originalTitle, category),
    category,
    probability: yesPrice,
    yesPrice,
    noPrice,
    bestBid: null,
    bestAsk: null,
    spread: null,
    volume,
    volume24h: nullableNumber(market.volume24hr),
    volume1w: nullableNumber(market.volume1wk),
    volume1m: nullableNumber(market.volume1mo),
    liquidity,
    endDate: market.endDate ?? event.endDate ?? null,
    updatedAt: market.updatedAt ?? event.updatedAt ?? new Date().toISOString(),
    relatedNewsCount: estimateRelatedNewsCount(category, text),
    status: "live",
    source: "Polymarket Gamma API",
    url: `https://polymarket.com/event/${event.slug || market.slug || market.id}`,
    description: market.description || event.description || "",
    resolutionSource: market.resolutionSource || "",
    clobTokenIds,
    outcomes,
  };
}

function dedupeMarkets(markets: Array<NormalizedMarket | null>) {
  const seen = new Set<string>();
  return markets.filter((market) => {
    if (!market) return false;
    if (seen.has(market.id)) return false;
    seen.add(market.id);
    return true;
  });
}

function isRelevantMarket(market: NormalizedMarket) {
  const haystack = [
    market.originalTitle,
    market.title,
    market.description,
    market.resolutionSource,
    market.category,
  ]
    .join(" ")
    .toLowerCase();
  return [...JAPAN_KEYWORDS_EN.map((keyword) => keyword.toLowerCase()), ...JAPAN_KEYWORDS_JA].some((keyword) =>
    haystack.includes(keyword.toLowerCase()),
  );
}

async function enrichMarketsWithClob(markets: NormalizedMarket[]) {
  return Promise.all(
    markets.map(async (market, index) => {
      const yesTokenId = market.clobTokenIds[0];
      if (!yesTokenId || index > 11) return market;
      const [spread, book] = await Promise.all([fetchSpread(yesTokenId), fetchBook(yesTokenId)]);
      return {
        ...market,
        spread: spread ?? market.spread,
        bestBid: book.bestBid ?? market.bestBid,
        bestAsk: book.bestAsk ?? market.bestAsk,
      };
    }),
  );
}

async function fetchSpread(tokenId: string) {
  try {
    const response = await fetchWithTimeout(`${CLOB_API}/spread?token_id=${encodeURIComponent(tokenId)}`);
    if (!response.ok) return null;
    const parsed = spreadSchema.parse(await response.json());
    return nullableNumber(parsed.spread);
  } catch {
    return null;
  }
}

async function fetchBook(tokenId: string) {
  try {
    const response = await fetchWithTimeout(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!response.ok) return { bestBid: null, bestAsk: null };
    const parsed = bookSchema.parse(await response.json());
    const bids = parsed.bids?.map((bid) => toNumber(bid.price)).filter(Number.isFinite) ?? [];
    const asks = parsed.asks?.map((ask) => toNumber(ask.price)).filter(Number.isFinite) ?? [];
    return {
      bestBid: bids.length ? Math.max(...bids) : null,
      bestAsk: asks.length ? Math.min(...asks) : null,
    };
  } catch {
    return { bestBid: null, bestAsk: null };
  }
}

async function fetchPriceHistory(tokenId: string | undefined, fallbackProbability: number): Promise<ChartPoint[]> {
  if (!tokenId) return [];
  try {
    const url = new URL(`${CLOB_API}/prices-history`);
    url.searchParams.set("market", tokenId);
    url.searchParams.set("interval", "1w");
    url.searchParams.set("fidelity", "60");
    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) return [];
    const parsed = priceHistorySchema.parse(await response.json());
    const every = Math.max(1, Math.floor(parsed.history.length / 18));
    return parsed.history
      .filter((_, index) => index % every === 0)
      .slice(-18)
      .map((point) => ({
        label: new Intl.DateTimeFormat("ja-JP", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
        }).format(new Date(point.t * 1000)),
        value: clamp(point.p, 0, 1),
      }));
  } catch {
    return fallbackDetail("sample-boj-rate").priceHistory.map((point) => ({
      ...point,
      value: fallbackProbability,
    }));
  }
}

function buildVolumeHistory(market: MarketSummary): ChartPoint[] {
  return [
    { label: "24h", value: market.volume24h ?? market.volume * 0.12 },
    { label: "7d", value: market.volume1w ?? market.volume * 0.42 },
    { label: "30d", value: market.volume1m ?? market.volume * 0.72 },
    { label: "累計", value: market.volume },
  ];
}

function relateNews(market: MarketSummary, items: NewsItem[]) {
  const categoryMatches = items.filter((item) => item.category === market.category || item.relatedMarket === market.title);
  if (categoryMatches.length > 0) return categoryMatches;
  return items.slice(0, 4);
}

function buildWatchPoints(market: MarketSummary) {
  const points = [
    "解決条件と一次情報の更新タイミングを先に確認する",
    "YES価格は市場価格であり、実際の発生確率を保証しない",
  ];

  if ((market.spread ?? 0) > 0.04) points.push("スプレッドが広いため、価格の読み取りには注意が必要");
  if (market.liquidity < 10000) points.push("流動性が薄い市場では小さな取引でも価格が動きやすい");
  if (market.category === "日銀" || market.category === "為替") {
    points.push("日銀、為替、米金利など複数の一次情報を合わせて見る");
  }
  return points;
}

function marketPriority(market: MarketSummary) {
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

function stripDetailFields(market: NormalizedMarket): MarketSummary {
  return {
    id: market.id,
    slug: market.slug,
    title: market.title,
    originalTitle: market.originalTitle,
    summaryJa: market.summaryJa,
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

function findYesIndex(outcomes: string[]) {
  const index = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  return index >= 0 ? index : 0;
}

function findNoIndex(outcomes: string[]) {
  const index = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");
  return index >= 0 ? index : 1;
}

function categorize(text: string): MarketCategory {
  const normalized = text.toLowerCase();
  const category = (Object.entries(CATEGORY_KEYWORDS) as Array<[MarketCategory, string[]]>).find(([, keywords]) =>
    keywords.some((keyword) => normalized.includes(keyword.toLowerCase())),
  );
  return category?.[0] ?? "イベント";
}

function nullableNumber(value: unknown) {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateRelatedNewsCount(category: MarketCategory, text: string) {
  const base = category === "日銀" || category === "規制" || category === "選挙" ? 3 : 2;
  const keywordBonus = JAPAN_KEYWORDS_JA.filter((keyword) => text.includes(keyword)).length;
  return Math.min(8, base + keywordBonus);
}

function toJapaneseTitle(title: string, category: MarketCategory) {
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(title)) return title;
  if (category === "日銀" && /bank of japan|boj/i.test(title)) return `日銀関連: ${title}`;
  if (category === "為替" && /yen|jpy/i.test(title)) return `円・為替関連: ${title}`;
  if (category === "選挙" && /election/i.test(title)) return `日本選挙関連: ${title}`;
  if (category === "規制" && /regulation|tax|law|crypto/i.test(title)) return `日本規制関連: ${title}`;
  return title;
}

function buildSummaryJa(title: string, category: MarketCategory) {
  const categoryCopy: Record<MarketCategory, string> = {
    政治: "日本政治のイベントや政策判断に関係する市場です。",
    金融: "金利、物価、金融環境に関係する市場です。",
    規制: "法改正、規制、行政判断に関係する市場です。",
    テック: "日本企業、技術政策、デジタル領域に関係する市場です。",
    イベント: "日本で発生するイベントや社会的テーマに関係する市場です。",
    日銀: "日本銀行の政策判断や金融政策イベントに関係する市場です。",
    為替: "円相場、USD/JPY、為替水準に関係する市場です。",
    暗号資産: "暗号資産、ステーブルコイン、Web3規制に関係する市場です。",
    選挙: "国政選挙、内閣、政党勢力に関係する市場です。",
  };
  return `${categoryCopy[category]} 元タイトル: ${title}`;
}
