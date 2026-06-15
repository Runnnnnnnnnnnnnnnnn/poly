import { z } from "zod";

import { GLOBAL_MARKET_QUERIES, PRIMARY_MARKET_QUERIES } from "@/lib/constants";
import { fallbackDetail, fallbackGlobalMarkets, fallbackMarkets } from "@/lib/sample-data";
import type {
  ChartPoint,
  DataStatus,
  MarketDetail,
  MarketScope,
  MarketSummary,
  NewsItem,
  SourceStatus,
} from "@/lib/types";
import { clamp, fetchWithTimeout, safeJsonArray, toNumber } from "@/lib/utils";
import {
  buildSummaryJa,
  categorize,
  dedupeMarkets,
  dedupeSummariesByTitle,
  estimateRelatedNewsCount,
  findNoIndex,
  findYesIndex,
  inferScope,
  isRelevantMarket,
  marketPriority,
  nullableNumber,
  stripDetailFields,
  themeImage,
  themeLabel,
  type NormalizedMarket,
} from "@/lib/adapters/polymarket/market-utils";
import { formatMarketDate, toJapaneseTitle, translateMarketTitles } from "@/lib/adapters/polymarket/titles";

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
    image: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
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
    image: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    markets: z.array(gammaMarketSchema).optional(),
    tags: z.array(z.object({ label: z.string().optional(), slug: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const publicSearchSchema = z.object({
  events: z.array(gammaEventSchema).default([]),
});

const gammaMarketsSchema = z.array(gammaMarketSchema).default([]);

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

export async function fetchMarkets(): Promise<{
  markets: MarketSummary[];
  globalMarkets: MarketSummary[];
  japanMarkets: MarketSummary[];
  status: DataStatus;
  sourceStatuses: SourceStatus[];
}> {
  const sourceStatuses: SourceStatus[] = [];

  try {
    const [globalResult, japanEvents] = await Promise.allSettled([fetchGlobalMarkets(), fetchSearchEvents()]);
    const normalizedGlobalMarkets = globalResult.status === "fulfilled" && globalResult.value.length > 0 ? globalResult.value : [];
    const events = japanEvents.status === "fulfilled" ? japanEvents.value : [];
    const japanMarkets = dedupeMarkets(
      events.flatMap((event) =>
        (event.markets ?? []).map((market) => normalizeMarket(market, event, "japan")),
      ),
    )
      .filter(Boolean)
      .filter((market): market is NormalizedMarket => Boolean(market))
      .filter(isRelevantMarket)
      .filter((market) => !market.endDate || new Date(market.endDate).getTime() > Date.now() - 1000 * 60 * 60 * 24 * 60);
    const selectedJapanMarkets = selectDiverseMarkets(japanMarkets, 36);

    if (japanMarkets.length === 0 && normalizedGlobalMarkets.length === 0) {
      sourceStatuses.push({
        source: "Polymarket Gamma API",
        status: "fallback",
        message: "公開市場データを取得できなかったためサンプルを表示",
      });
      const fallbackAll = [...fallbackGlobalMarkets, ...fallbackMarkets];
      return {
        markets: fallbackAll,
        globalMarkets: fallbackGlobalMarkets,
        japanMarkets: fallbackMarkets,
        status: "fallback",
        sourceStatuses,
      };
    }

    const enrichedGlobal = normalizedGlobalMarkets.length > 0 ? await enrichMarketsWithClob(normalizedGlobalMarkets) : [];
    const enrichedJapan = await enrichMarketsWithClob(selectedJapanMarkets);
    const globalSummaries = dedupeSummariesByTitle(await translateMarketTitles(enrichedGlobal.length > 0 ? enrichedGlobal.map(stripDetailFields) : fallbackGlobalMarkets));
    const japanSummaries = dedupeSummariesByTitle(await translateMarketTitles(enrichedJapan.length > 0 ? enrichedJapan.map(stripDetailFields) : fallbackMarkets));
    sourceStatuses.push({
      source: "Polymarket Gamma API",
      status: "live",
      message: `${globalSummaries.length + japanSummaries.length} markets`,
    });
    sourceStatuses.push({
      source: "Polymarket CLOB public read endpoints",
      status: [...globalSummaries, ...japanSummaries].some((market) => market.spread !== null) ? "live" : "fallback",
      message: "spread/book enrichment",
    });

    return {
      markets: [...globalSummaries, ...japanSummaries],
      globalMarkets: globalSummaries,
      japanMarkets: japanSummaries,
      status: "live",
      sourceStatuses,
    };
  } catch (error) {
    sourceStatuses.push({
      source: "Polymarket APIs",
      status: "error",
      message: error instanceof Error ? error.message : "unknown error",
    });
    const fallbackAll = [...fallbackGlobalMarkets, ...fallbackMarkets];
    return {
      markets: fallbackAll,
      globalMarkets: fallbackGlobalMarkets,
      japanMarkets: fallbackMarkets,
      status: "fallback",
      sourceStatuses,
    };
  }
}

export const fetchJapanMarkets = fetchMarkets;

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
      image: parsed.image,
      icon: parsed.icon,
      markets: [parsed],
      tags: [],
    }, inferScope(parsed.question ?? parsed.description ?? ""));

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
        description: buildResolutionSummary(enriched),
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
      url.searchParams.set("limit", "14");
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) throw new Error(`public-search ${query}: ${response.status}`);
      return publicSearchSchema.parse(await response.json()).events;
    }),
  );

  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

async function fetchGlobalMarkets() {
  try {
    const url = new URL(`${GAMMA_API}/markets`);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "80");
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) throw new Error(`global markets ${response.status}`);
    const topMarkets = gammaMarketsSchema
      .parse(await response.json())
      .map((market) =>
        normalizeMarket(
          market,
          {
            id: market.id,
            title: market.question,
            slug: market.slug,
            description: market.description,
            endDate: market.endDate,
            updatedAt: market.updatedAt,
            image: market.image,
            icon: market.icon,
            markets: [market],
            tags: [],
          },
          "global",
        ),
      )
      .filter((market): market is NormalizedMarket => Boolean(market))
      .filter((market) => !market.endDate || new Date(market.endDate).getTime() > Date.now() - 1000 * 60 * 60 * 24 * 3)
      .sort((a, b) => marketPriority(b) - marketPriority(a))
      .slice(0, 36);
    const searchedMarkets = await fetchGlobalMarketsBySearch().catch(() => []);
    return selectDiverseMarkets(dedupeMarkets([...topMarkets, ...searchedMarkets]), 48);
  } catch {
    return fetchGlobalMarketsBySearch();
  }
}

async function fetchGlobalMarketsBySearch() {
  const results = await Promise.allSettled(
    GLOBAL_MARKET_QUERIES.map(async (query) => {
      const url = new URL(`${GAMMA_API}/public-search`);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "12");
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) throw new Error(`public-search ${query}: ${response.status}`);
      return publicSearchSchema.parse(await response.json()).events;
    }),
  );

  return selectDiverseMarkets(dedupeMarkets(
    results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .flatMap((event) => (event.markets ?? []).map((market) => normalizeMarket(market, event, "global"))),
  ).filter((market): market is NormalizedMarket => Boolean(market)), 36);
}

function selectDiverseMarkets(markets: NormalizedMarket[], limit: number) {
  const sorted = [...markets].sort((a, b) => marketPriority(b) - marketPriority(a));
  const selected = new Map<string, NormalizedMarket>();
  const categoryTargets = [
    ["イベント", 6],
    ["暗号資産", 6],
    ["テック", 5],
    ["金融", 5],
    ["為替", 5],
    ["日銀", 5],
    ["政治", 5],
    ["選挙", 5],
    ["規制", 5],
  ] as const;

  for (const [category, target] of categoryTargets) {
    for (const market of sorted.filter((item) => item.category === category).slice(0, target)) {
      selected.set(market.id, market);
    }
  }

  for (const market of sorted) {
    selected.set(market.id, market);
    if (selected.size >= limit) break;
  }

  return Array.from(selected.values())
    .sort((a, b) => marketPriority(b) - marketPriority(a))
    .slice(0, limit);
}

function normalizeMarket(market: GammaMarket, event: GammaEvent, scope: MarketScope): NormalizedMarket | null {
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
    title: toJapaneseTitle(originalTitle, category, scope),
    originalTitle,
    summaryJa: buildSummaryJa(originalTitle, category, scope),
    scope,
    imageUrl: market.image || market.icon || event.image || event.icon || themeImage(category, scope),
    themeLabel: `${scope === "global" ? "世界" : "日本"}・${themeLabel(category)}`,
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
    "市場価格は参加者の見方であり、実際の発生確率を保証しない",
  ];

  if ((market.spread ?? 0) > 0.04) points.push("スプレッドが広いため、価格の読み取りには注意が必要");
  if (market.liquidity < 10000) points.push("流動性が薄い市場では小さな取引でも価格が動きやすい");
  if (market.category === "日銀" || market.category === "為替") {
    points.push("日銀、為替、米金利など複数の一次情報を合わせて見る");
  }
  return points;
}

function buildResolutionSummary(market: NormalizedMarket) {
  const endDate = market.endDate ? formatMarketDate(market.endDate) : "期日";
  const outcomeText = market.outcomes.length ? market.outcomes.join(" / ") : "はい / いいえ";
  return [
    `${market.title}について、Polymarket上の市場ルールに従って判定されます。`,
    `主な選択肢は ${outcomeText} です。期日は ${endDate} です。`,
    "市場ごとに判定条件や参照先が異なるため、詳細な条件はPolymarketの市場ページで確認してください。",
  ].join("\n");
}
