import { z } from "zod";

import {
  CATEGORY_KEYWORDS,
  GLOBAL_MARKET_QUERIES,
  JAPAN_KEYWORDS_EN,
  JAPAN_KEYWORDS_JA,
  PRIMARY_MARKET_QUERIES,
} from "@/lib/constants";
import { fallbackDetail, fallbackGlobalMarkets, fallbackMarkets } from "@/lib/sample-data";
import type {
  ChartPoint,
  DataStatus,
  MarketCategory,
  MarketDetail,
  MarketScope,
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

const titleTranslationSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1),
    }),
  ),
});

const titleTranslationCache = new Map<string, string>();
const titleTranslationSkipCache = new Set<string>();

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
      .filter((market) => !market.endDate || new Date(market.endDate).getTime() > Date.now() - 1000 * 60 * 60 * 24 * 60)
      .sort((a, b) => marketPriority(b) - marketPriority(a))
      .slice(0, 18);

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

    const enrichedGlobal = normalizedGlobalMarkets.length > 0 ? await enrichMarketsWithClob(normalizedGlobalMarkets.slice(0, 12)) : [];
    const enrichedJapan = await enrichMarketsWithClob(japanMarkets);
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
      url.searchParams.set("limit", "10");
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
    url.searchParams.set("limit", "48");
    url.searchParams.set("order", "volume24hr");
    url.searchParams.set("ascending", "false");
    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) throw new Error(`global markets ${response.status}`);
    return gammaMarketsSchema
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
      .slice(0, 18);
  } catch {
    return fetchGlobalMarketsBySearch();
  }
}

async function fetchGlobalMarketsBySearch() {
  const results = await Promise.allSettled(
    GLOBAL_MARKET_QUERIES.map(async (query) => {
      const url = new URL(`${GAMMA_API}/public-search`);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "8");
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) throw new Error(`public-search ${query}: ${response.status}`);
      return publicSearchSchema.parse(await response.json()).events;
    }),
  );

  return dedupeMarkets(
    results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .flatMap((event) => (event.markets ?? []).map((market) => normalizeMarket(market, event, "global"))),
  )
    .filter((market): market is NormalizedMarket => Boolean(market))
    .sort((a, b) => marketPriority(b) - marketPriority(a))
    .slice(0, 18);
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

function dedupeMarkets(markets: Array<NormalizedMarket | null>) {
  const seen = new Set<string>();
  return markets.filter((market) => {
    if (!market) return false;
    if (seen.has(market.id)) return false;
    seen.add(market.id);
    return true;
  });
}

function dedupeSummariesByTitle(markets: MarketSummary[]) {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = market.title.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRelevantMarket(market: NormalizedMarket) {
  const haystack = [
    market.originalTitle,
    market.description,
    market.resolutionSource,
  ]
    .join(" ")
    .toLowerCase();
  return JAPAN_KEYWORDS_EN.some((keyword) => keywordMatches(haystack, keyword)) || JAPAN_KEYWORDS_JA.some((keyword) => haystack.includes(keyword.toLowerCase()));
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

function buildResolutionSummary(market: NormalizedMarket) {
  const endDate = market.endDate ? formatEnglishDate(market.endDate) : "期日";
  const outcomeText = market.outcomes.length ? market.outcomes.join(" / ") : "YES / NO";
  return [
    `${market.title}について、Polymarket上の市場ルールに従って判定されます。`,
    `主な選択肢は ${outcomeText} です。期日は ${endDate} です。`,
    "市場ごとに判定条件や参照先が異なるため、詳細な条件はPolymarketの市場ページで確認してください。",
  ].join("\n");
}

async function translateMarketTitles(markets: MarketSummary[]) {
  if (process.env.SKIP_TITLE_AI === "1" || !process.env.DEEPSEEK_API_KEY || markets.length === 0) return markets;

  const pending = markets
    .filter((market) => !titleTranslationCache.has(translationCacheKey(market)) && !titleTranslationSkipCache.has(translationCacheKey(market)))
    .slice(0, 30)
    .map((market) => ({
      id: market.id,
      title: market.originalTitle,
      currentJapaneseTitle: market.title,
      category: market.category,
      scope: market.scope === "global" ? "世界" : "日本",
    }));

  if (pending.length > 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
          response_format: { type: "json_object" },
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "Polymarketの市場タイトルを、上司向けダッシュボードに載せる自然な日本語タイトルへ翻訳してください。売買推奨や投資助言はしない。英語の原題は残さない。固有名詞は一般的な日本語表記にし、分からない固有名詞はカタカナまたは原語の短い固有名詞だけ残す。必ずJSONだけで返す。",
            },
            {
              role: "user",
              content: JSON.stringify({
                format: { translations: [{ id: "string", title: "自然な日本語タイトル" }] },
                rules: [
                  "疑問形の市場は日本語でも疑問形にする",
                  "タイトルは40文字以内を目安にする",
                  "「取引」「買う」「売る」は使わない",
                  "日付がある場合は日本語の日付にする",
                ],
                markets: pending,
              }),
            },
          ],
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        const parsed = titleTranslationSchema.parse(JSON.parse(extractJsonObject(String(content ?? "{}"))));
        for (const item of parsed.translations) {
          const market = markets.find((candidate) => candidate.id === item.id);
          const title = normalizeTranslatedTitle(item.title);
          if (market && !hasUntranslatedEnglish(title)) {
            titleTranslationCache.set(translationCacheKey(market), title);
          } else if (market) {
            titleTranslationSkipCache.add(translationCacheKey(market));
          }
        }
      }
    } catch {
      // Heuristic titles remain available when translation fails.
      pending.forEach((market) => titleTranslationSkipCache.add(`${market.id}:${market.title}`));
    } finally {
      clearTimeout(timeout);
    }
  }

  return markets.map((market) => ({
    ...market,
    title: titleTranslationCache.get(translationCacheKey(market)) ?? market.title,
  }));
}

function translationCacheKey(market: MarketSummary) {
  return `${market.id}:${market.originalTitle}`;
}

function extractJsonObject(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) return "{}";
  return value.slice(start, end + 1);
}

function hasUntranslatedEnglish(value: string) {
  const allowed = /\b(AI|FRB|FOMC|NVIDIA|Tesla|S&P|NBA|NFL|FIFA|ETF|BTC|ETH|USD|JPY)\b/gi;
  return value.replace(allowed, "").split(/\s+/).some((part) => /[A-Za-z]{3,}/.test(part));
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
    keywords.some((keyword) => keywordMatches(normalized, keyword)),
  );
  return category?.[0] ?? "イベント";
}

function keywordMatches(text: string, keyword: string) {
  const normalizedKeyword = keyword.toLowerCase();
  if (/^[a-z0-9 /.-]+$/i.test(normalizedKeyword)) {
    return new RegExp(`\\b${escapeRegExp(normalizedKeyword)}\\b`, "i").test(text);
  }
  return text.includes(normalizedKeyword);
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

function inferScope(text: string): MarketScope {
  const normalized = text.toLowerCase();
  return [...JAPAN_KEYWORDS_EN.map((keyword) => keyword.toLowerCase()), ...JAPAN_KEYWORDS_JA].some((keyword) =>
    normalized.includes(keyword.toLowerCase()),
  )
    ? "japan"
    : "global";
}

function toJapaneseTitle(title: string, category: MarketCategory, scope: MarketScope) {
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(title)) return title;
  const normalized = title.replace(/\s+/g, " ").replace(/\?+$/, "").trim();
  const knownTitle = knownJapaneseTitle(normalized);
  if (knownTitle) return knownTitle;
  const dateMatch = normalized.match(/\bby ([A-Z][a-z]+ \d{1,2}, \d{4})$/);
  const dateText = dateMatch ? `${formatEnglishDate(dateMatch[1])}までに` : "";
  const withoutDate = dateMatch ? normalized.replace(/\s+by [A-Z][a-z]+ \d{1,2}, \d{4}$/, "") : normalized;
  const phrase = translatePhrase(withoutDate)
    .replace(/^Will\s+/i, "")
    .replace(/^Who will win\s+/i, "")
    .replace(/^Which .* will win\s+/i, "")
    .trim()
    .replace(/\s+/g, " ");

  if (/^World Cup Winner/i.test(normalized)) return "2026年ワールドカップの優勝国は？";
  if (/^Who will win/i.test(normalized)) return `${translatePhrase(normalized.replace(/^Who will win\s+/i, ""))}の勝者は？`;
  if (/^Will /i.test(normalized)) return `${phrase}は${dateText}実現する？`;
  if (/price|above|below|cross/i.test(normalized)) return `${phrase}の価格水準は注目ラインを超える？`;
  if (/winner|win/i.test(normalized)) return `${phrase}の勝者は？`;

  const prefix = scope === "global" ? "世界で注目される" : "日本関連の";
  return `${prefix}${themeLabel(category)}テーマ: ${phrase}`;
}

function knownJapaneseTitle(title: string) {
  if (/US x Iran permanent peace deal/i.test(title)) return "米国とイランは恒久的な和平合意に至る？";

  if (/Iranian regime fall|regime fall.*Iran/i.test(title)) return "イランの政権は6月30日までに崩壊する？";

  const usIranDeal = title.match(/US announces new Iran agreement\/ceasefire extension by (.+)$/i);
  if (usIranDeal) return `米国は${translateShortDate(usIranDeal[1])}までにイランとの合意または停戦延長を発表する？`;

  const fedChange = title.match(/Fed (increase|decrease|cut)s? (?:interest )?rates by (\d+)(\+)? bps after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (fedChange) {
    const direction = fedChange[1].toLowerCase() === "increase" ? "利上げ" : "利下げ";
    return `FRBは${formatMeetingMonth(fedChange[4])}会合後に${fedChange[2]}bp${fedChange[3] ? "以上" : ""}の${direction}をする？`;
  }

  const fedNoChange = title.match(/(?:there be )?no change in Fed (?:interest )?rates after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (fedNoChange) return `FRBは${formatMeetingMonth(fedNoChange[1])}会合後に金利を据え置く？`;

  const recession = title.match(/Japan recession in (\d{4})/i);
  if (recession) return `日本は${recession[1]}年に景気後退入りする？`;

  const bojHike = title.match(/Bank of Japan increase(?:s)? (?:interest )?rates by (\d+)(\+)? bps after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (bojHike) return `日銀は${formatMeetingMonth(bojHike[3])}会合後に${bojHike[1]}bp${bojHike[2] ? "以上" : ""}の利上げをする？`;

  const bojNoChange = title.match(/(?:there be )?No change in Bank of Japan.?s (?:interest )?rates after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (bojNoChange) return `日銀は${formatMeetingMonth(bojNoChange[1])}会合後に金利を据え置く？`;

  const bojCut = title.match(/Bank of Japan (?:cuts|decreases?) (?:interest )?rates(?: by (\d+)(\+)? bps)? after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (bojCut) return `日銀は${formatMeetingMonth(bojCut[3])}会合後に${bojCut[1] ? `${bojCut[1]}bp${bojCut[2] ? "以上" : ""}の` : ""}利下げをする？`;

  const usdJpyHit = title.match(/Will USD\/JPY hit ([\d.]+) \((High|Low)\) in (\d{4})/i);
  if (usdJpyHit) return `USD/JPYは${usdJpyHit[3]}年に${usdJpyHit[1]}円まで${usdJpyHit[2].toLowerCase() === "high" ? "上昇" : "下落"}する？`;

  const usdJpyClose = title.match(/Will the close USD\/JPY price at the end of (\d{4}) be between ([\d.]+) and ([\d.]+)/i);
  if (usdJpyClose) return `${usdJpyClose[1]}年末のUSD/JPY終値は${usdJpyClose[2]}円から${usdJpyClose[3]}円の間になる？`;

  const nikkeiBetween = title.match(/Will the official close price for the Nikkei 225 on the final trading day of December (\d{4}) be between ([\d,]+) and ([\d,]+)/i);
  if (nikkeiBetween) return `${nikkeiBetween[1]}年12月最終取引日の日経平均終値は${nikkeiBetween[2]}円から${nikkeiBetween[3]}円の間になる？`;

  const nikkeiAtLeast = title.match(/Will the official close price for the Nikkei 225 on the final trading day of December (\d{4}) be at least ([\d,]+)/i);
  if (nikkeiAtLeast) return `${nikkeiAtLeast[1]}年12月最終取引日の日経平均終値は${nikkeiAtLeast[2]}円以上になる？`;

  const nikkeiLessThan = title.match(/Will the official close price for the Nikkei 225 on the final trading day of December (\d{4}) be less than ([\d,]+)/i);
  if (nikkeiLessThan) return `${nikkeiLessThan[1]}年12月最終取引日の日経平均終値は${nikkeiLessThan[2]}円未満になる？`;

  if (/Trump say "crypto" or "Bitcoin" during events with Xi Jinping/i.test(title)) {
    return "トランプ氏は習近平氏との会談で暗号資産に言及する？";
  }

  if (/Trump say "Japan" or "Korea" during events with Xi Jinping/i.test(title)) {
    return "トランプ氏は習近平氏との会談で日本または韓国に言及する？";
  }

  if (/Japan declassifies new UFO files in 2026/i.test(title)) {
    return "日本は2026年にUFO関連の新資料を公開する？";
  }

  const chinaJapanClash = title.match(/China x Japan military clash before (\d{4})/i);
  if (chinaJapanClash) return `中国と日本は${chinaJapanClash[1]}年までに軍事衝突する？`;

  const tennisMatch = title.match(/^(Roland Garros WTA|Madrid Open):\s*(.+?)\s+vs\s+(.+)$/i);
  if (tennisMatch) return `${translateEventName(tennisMatch[1])}: ${translatePerson(tennisMatch[2])}対${translatePerson(tennisMatch[3])}`;

  const worldCup = title.match(/Will ([A-Za-z .'-]+) win the 2026 FIFA World Cup/i);
  if (worldCup) return `${translateCountry(worldCup[1])}は2026年FIFAワールドカップで優勝する？`;

  const hormuz = title.match(/Strait of Hormuz traffic returns to normal by (.+)$/i);
  if (hormuz) return `ホルムズ海峡の船舶通行は${translateShortDate(hormuz[1])}までに正常化する？`;

  return null;
}

function normalizeTranslatedTitle(value: string) {
  return value
    .replace(/ベーシスポイント/g, "bp")
    .replace(/５０/g, "50")
    .replace(/２５/g, "25")
    .trim();
}

function translatePhrase(value: string) {
  return Object.entries(translationGlossary)
    .reduce(
    (text, [english, japanese]) => text.replace(glossaryRegExp(english), japanese),
    value,
    )
    .replace(/\b(the|a|an)\b/gi, "")
    .replace(/\s+の\s+/g, "の")
    .replace(/\s+/g, " ")
    .trim();
}

function translateCountry(value: string) {
  return countryGlossary[value.trim()] ?? translatePhrase(value.trim());
}

function translateEventName(value: string) {
  const normalized = value.trim();
  const events: Record<string, string> = {
    "Roland Garros WTA": "全仏オープン女子",
    "Madrid Open": "マドリード・オープン",
  };
  return events[normalized] ?? translatePhrase(normalized);
}

function translatePerson(value: string) {
  const normalized = value.replace(/\?+$/, "").trim();
  const people: Record<string, string> = {
    "Aryna Sabalenka": "アリナ・サバレンカ",
    "Naomi Osaka": "大坂なおみ",
    "Iva Jovic": "イバ・ヨビッチ",
  };
  return people[normalized] ?? translatePhrase(normalized);
}

function translateShortDate(value: string) {
  const normalized = value.replace(/\?+$/, "").trim();
  if (/end of June/i.test(normalized)) return "6月末";
  const monthDay = normalized.match(/June (\d{1,2})/i);
  if (monthDay) return `6月${monthDay[1]}日`;
  return normalized;
}

function formatEnglishDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function formatMeetingMonth(value: string) {
  const date = new Date(`${value} 1`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(date);
}

function buildSummaryJa(title: string, category: MarketCategory, scope: MarketScope) {
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

function themeLabel(category: MarketCategory) {
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

function themeImage(category: MarketCategory, scope: MarketScope) {
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

const translationGlossary: Record<string, string> = {
  "US x Iran": "米国とイランの",
  "United States": "米国",
  "US": "米国",
  Iran: "イラン",
  China: "中国",
  Russia: "ロシア",
  Ukraine: "ウクライナ",
  Israel: "イスラエル",
  Japan: "日本",
  Japanese: "日本",
  "permanent peace deal": "恒久的な和平合意",
  "peace deal": "和平合意",
  "ceasefire": "停戦",
  "World Cup Winner": "ワールドカップ優勝国",
  "World Cup": "ワールドカップ",
  "presidential election": "大統領選挙",
  election: "選挙",
  "rate cut": "利下げ",
  "cut interest rates": "利下げ",
  "cut rates": "利下げ",
  "rate hike": "利上げ",
  "interest rates": "金利",
  "Federal Reserve": "FRB",
  Fed: "FRB",
  "Bank of Japan": "日本銀行",
  BOJ: "日銀",
  Yen: "円",
  JPY: "円",
  Bitcoin: "ビットコイン",
  BTC: "ビットコイン",
  Ethereum: "イーサリアム",
  crypto: "暗号資産",
  "artificial intelligence": "AI",
  AI: "AI",
  Nvidia: "NVIDIA",
  Tesla: "テスラ",
  Trump: "トランプ",
  Biden: "バイデン",
  "S&P 500": "S&P 500",
  inflation: "インフレ",
  CPI: "消費者物価指数",
  "oil": "原油",
  gold: "金",
  above: "上回る",
  below: "下回る",
  cross: "超える",
  by: "までに",
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function glossaryRegExp(value: string) {
  const escaped = escapeRegExp(value);
  return /^[A-Za-z0-9 /'-]+$/.test(value) ? new RegExp(`\\b${escaped}\\b`, "gi") : new RegExp(escaped, "gi");
}

const countryGlossary: Record<string, string> = {
  Spain: "スペイン",
  Mexico: "メキシコ",
  Germany: "ドイツ",
  Turkiye: "トルコ",
  Turkey: "トルコ",
  Sweden: "スウェーデン",
  Austria: "オーストリア",
  Australia: "オーストラリア",
  Brazil: "ブラジル",
  Argentina: "アルゼンチン",
  France: "フランス",
  England: "イングランド",
  Portugal: "ポルトガル",
  "Congo DR": "コンゴ民主共和国",
  USA: "米国",
  "South Korea": "韓国",
  Japan: "日本",
};
