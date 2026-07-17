import { z } from "zod";

import { fetchWithTimeout, safeJsonArray, toNumber } from "@/lib/utils";
import type { CryptoAsset, CryptoMarket, HistoricalProbability } from "@/src/lib/backtest/types";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

const marketSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    question: z.string().optional(),
    slug: z.string().nullable().optional(),
    outcomes: z.unknown().optional(),
    outcomePrices: z.unknown().optional(),
    clobTokenIds: z.unknown().optional(),
    endDate: z.string().nullable().optional(),
    closed: z.boolean().optional(),
    resolved: z.boolean().optional(),
    active: z.boolean().optional(),
    volume: z.union([z.string(), z.number()]).optional(),
    volumeNum: z.number().optional(),
    liquidity: z.union([z.string(), z.number()]).optional(),
    liquidityNum: z.number().optional(),
    minimumOrderSize: z.union([z.string(), z.number()]).optional(),
    minimum_tick_size: z.union([z.string(), z.number()]).optional(),
    feesEnabled: z.boolean().optional(),
    description: z.string().nullable().optional(),
    resolutionSource: z.string().nullable().optional(),
    events: z.array(z.object({ id: z.union([z.string(), z.number()]) }).passthrough()).optional(),
  })
  .passthrough();

const searchEventSchema = z.object({ markets: z.array(marketSchema).default([]) }).passthrough();
const searchSchema = z.object({ events: z.array(searchEventSchema).default([]) });
const historicalEventSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  closedTime: z.string().nullable().optional(),
  markets: z.array(marketSchema).default([]),
}).passthrough();
const eventKeysetSchema = z.object({
  events: z.array(historicalEventSchema).default([]),
  next_cursor: z.string().optional(),
});
const marketsSchema = z.array(marketSchema).default([]);
const historySchema = z.object({ history: z.array(z.object({ t: z.number(), p: z.number() })).default([]) });
const bookSchema = z.object({
  bids: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
  asks: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
  min_order_size: z.union([z.string(), z.number()]).optional(),
  tick_size: z.union([z.string(), z.number()]).optional(),
}).passthrough();
const batchBookSchema = z.array(bookSchema.extend({
  asset_id: z.string(),
  timestamp: z.union([z.string(), z.number()]).optional(),
}));

const SEARCHES = ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "xrp", "crypto price"];
const CRYPTO_PRICES_TAG_ID = "1312";
const RECENT_PRICE_SEARCHES = ["Bitcoin price", "Ethereum price", "Solana price", "XRP price"];

export type HistoricalCryptoEvent = {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  closedTime: string | null;
  markets: CryptoMarket[];
};

export async function discoverCryptoMarkets(options: { includeResolved?: boolean; limit?: number; asset?: CryptoAsset } = {}) {
  const includeResolved = options.includeResolved ?? true;
  const limit = options.limit ?? 80;
  const searchResults = await Promise.allSettled(SEARCHES.map((query) => searchMarkets(query)));
  const searched = searchResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  const topMarkets = await fetchTopMarkets().catch(() => []);
  const all = [...searched, ...topMarkets]
    .map((market) => toCryptoMarket(market))
    .filter((market): market is CryptoMarket => Boolean(market))
    .filter((market) => includeResolved || !market.resolved)
    .filter((market) => !options.asset || market.asset === options.asset);

  return Array.from(new Map(all.map((market) => [market.id, market])).values()).slice(0, limit);
}

export async function discoverActiveCryptoPriceMarkets(limit = 300) {
  const now = new Date();
  const url = new URL(`${GAMMA_API}/events`);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "200");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("end_date_min", now.toISOString());
  const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 20_000);
  if (!response.ok) throw new Error(`active crypto price events ${response.status}`);
  const events = z.array(historicalEventSchema).parse(await response.json());
  const markets = events.flatMap((event) => event.markets
    .filter((market) => isFixedTerminalPriceQuestion(market.question ?? ""))
    .map((market) => toCryptoMarket(market, String(event.id)))
    .filter((market): market is CryptoMarket => Boolean(market && market.asset !== "OTHER" && !market.resolved)));
  return Array.from(new Map(markets.map((market) => [market.id, market])).values()).slice(0, limit);
}

export async function discoverHistoricalCryptoEvents(options: { maxEvents?: number; horizonHours?: number; endDateMax?: Date } = {}) {
  const maxEvents = Math.min(300, Math.max(30, options.maxEvents ?? 180));
  const recentTarget = Math.floor(maxEvents * 0.8);
  const historicalTarget = maxEvents - recentTarget;
  const horizonHours = Math.max(1, options.horizonHours ?? 24);
  const endDateMax = options.endDateMax ?? new Date();
  const events: HistoricalCryptoEvent[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 10 && events.length < historicalTarget; page += 1) {
    const url = new URL(`${GAMMA_API}/events/keyset`);
    url.searchParams.set("closed", "true");
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");
    url.searchParams.set("tag_id", CRYPTO_PRICES_TAG_ID);
    url.searchParams.set("related_tags", "true");
    url.searchParams.set("end_date_min", "2024-01-01T00:00:00Z");
    url.searchParams.set("end_date_max", endDateMax.toISOString());
    if (cursor) url.searchParams.set("after_cursor", cursor);

    const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 30_000);
    if (!response.ok) throw new Error(`historical events ${response.status}`);
    const parsed = eventKeysetSchema.parse(await response.json());

    for (const event of parsed.events) {
      const historicalEvent = toHistoricalEvent(event, horizonHours, endDateMax);
      if (historicalEvent) events.push(historicalEvent);
      if (events.length >= historicalTarget) break;
    }

    cursor = parsed.next_cursor;
    if (!cursor || !parsed.events.length) break;
  }

  const recentPerAsset = Math.ceil(recentTarget / RECENT_PRICE_SEARCHES.length);
  const recentResults = await Promise.allSettled(RECENT_PRICE_SEARCHES.map((titleSearch) =>
    fetchRecentHistoricalEvents(titleSearch, recentPerAsset, horizonHours, endDateMax),
  ));
  for (const result of recentResults) {
    if (result.status === "fulfilled") events.push(...result.value);
  }

  return Array.from(new Map(events.map((event) => [event.id, event])).values())
    .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime())
    .slice(-maxEvents);
}

async function fetchRecentHistoricalEvents(titleSearch: string, target: number, horizonHours: number, endDateMax: Date) {
  const events: HistoricalCryptoEvent[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 10 && events.length < target; page += 1) {
    const url = new URL(`${GAMMA_API}/events/keyset`);
    url.searchParams.set("closed", "true");
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "false");
    url.searchParams.set("title_search", titleSearch);
    url.searchParams.set("end_date_min", "2025-01-01T00:00:00Z");
    url.searchParams.set("end_date_max", endDateMax.toISOString());
    if (cursor) url.searchParams.set("after_cursor", cursor);
    const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 30_000);
    if (!response.ok) throw new Error(`recent historical events ${titleSearch}: ${response.status}`);
    const parsed = eventKeysetSchema.parse(await response.json());
    for (const event of parsed.events) {
      const historicalEvent = toHistoricalEvent(event, horizonHours, endDateMax);
      if (historicalEvent) events.push(historicalEvent);
      if (events.length >= target) break;
    }
    cursor = parsed.next_cursor;
    if (!cursor || !parsed.events.length) break;
  }

  return Array.from(new Map(events.map((event) => [event.id, event])).values()).slice(0, target);
}

export async function fetchHistoricalProbability(tokenId: string, options: { fidelity?: number; startTs?: number; endTs?: number } = {}) {
  const url = new URL(`${CLOB_API}/prices-history`);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("fidelity", String(options.fidelity ?? 1440));
  if (options.startTs) url.searchParams.set("startTs", String(options.startTs));
  if (options.endTs) url.searchParams.set("endTs", String(options.endTs));
  if (!options.startTs && !options.endTs) url.searchParams.set("interval", "max");

  const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 20_000);
  if (!response.ok) throw new Error(`prices-history ${response.status}`);
  const parsed = historySchema.parse(await response.json());
  return parsed.history
    .filter((point) => Number.isFinite(point.p) && point.p >= 0 && point.p <= 1)
    .map<HistoricalProbability>((point) => ({ timestamp: new Date(point.t * 1000).toISOString(), probability: point.p }));
}

async function searchMarkets(query: string) {
  const url = new URL(`${GAMMA_API}/public-search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "50");
  const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 15_000);
  if (!response.ok) throw new Error(`public-search ${query}: ${response.status}`);
  return searchSchema
    .parse(await response.json())
    .events.flatMap((event) => event.markets);
}

async function fetchTopMarkets() {
  const url = new URL(`${GAMMA_API}/markets`);
  url.searchParams.set("limit", "200");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 15_000);
  if (!response.ok) throw new Error(`markets ${response.status}`);
  return marketsSchema.parse(await response.json());
}

function toCryptoMarket(market: z.infer<typeof marketSchema>, explicitEventId?: string): CryptoMarket | null {
  const text = (market.question ?? "").toLowerCase();
  const asset = inferAsset(text);
  const outcomes = safeJsonArray(market.outcomes).map(String);
  const prices = safeJsonArray(market.outcomePrices).map(toNumber);
  const tokenIds = safeJsonArray(market.clobTokenIds).map(String);
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "no");
  const yesPrice = prices[yesIndex >= 0 ? yesIndex : 0];
  const noPrice = prices[noIndex >= 0 ? noIndex : 1];
  const result = resolveResult(market, yesPrice, noPrice);

  if (!asset || !market.id || !tokenIds[yesIndex >= 0 ? yesIndex : 0]) return null;
  return {
    id: String(market.id),
    eventId: explicitEventId ?? (market.events?.[0] ? String(market.events[0].id) : null),
    asset,
    tokenId: tokenIds[yesIndex >= 0 ? yesIndex : 0],
    noTokenId: tokenIds[noIndex >= 0 ? noIndex : 1] ?? null,
    title: market.question ?? String(market.id),
    slug: market.slug ?? null,
    endDate: market.endDate ?? null,
    resolved: result !== null,
    result,
    currentProbability: Number.isFinite(yesPrice) ? Math.max(0, Math.min(1, yesPrice as number)) : null,
    volume: toNumber(market.volumeNum ?? market.volume),
    liquidity: toNumber(market.liquidityNum ?? market.liquidity),
    bestBid: null,
    bestAsk: null,
    minOrderSize: Math.max(0, toNumber(market.minimumOrderSize)),
    tickSize: toNumber(market.minimum_tick_size) || 0.01,
    feesEnabled: market.feesEnabled ?? true,
    referenceSource: inferReferenceSource(`${market.resolutionSource ?? ""} ${market.description ?? ""}`),
  };
}

function isFixedTerminalPriceQuestion(question: string) {
  const text = question.toLowerCase();
  const terminalPrice = /\$\s*[0-9]/.test(text) && /\b(above|below|between|higher than|lower than|greater than|less than|over|under)\b/.test(text);
  const pathDependent = /\b(dip|hit|reach|touch|before|during|all[- ]time high)\b|\bby\s/.test(text);
  return terminalPrice && !pathDependent;
}

function toHistoricalEvent(event: z.infer<typeof historicalEventSchema>, horizonHours: number, endDateMax: Date): HistoricalCryptoEvent | null {
  const startDate = parseDate(event.startDate);
  const endDate = parseDate(event.endDate);
  const closedTime = parseDate(event.closedTime);
  if (!startDate || !endDate || endDate > endDateMax) return null;
  const decisionAt = new Date(endDate.getTime() - horizonHours * 60 * 60 * 1_000);
  if (startDate >= decisionAt || (closedTime && closedTime <= decisionAt)) return null;

  const eventId = String(event.id);
  const markets = event.markets
    .filter((market) => isFixedTerminalPriceQuestion(market.question ?? ""))
    .map((market) => toCryptoMarket(market, eventId))
    .filter((market): market is CryptoMarket => Boolean(market?.resolved && market.result !== null))
    .filter((market) => market.asset !== "OTHER");
  if (!markets.length) return null;
  return {
    id: eventId,
    title: event.title ?? markets[0].title,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    closedTime: closedTime?.toISOString() ?? null,
    markets,
  };
}

function parseDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function fetchCurrentBook(tokenId: string) {
  const url = new URL(`${CLOB_API}/book`);
  url.searchParams.set("token_id", tokenId);
  const response = await fetchWithTimeout(url.toString(), { cache: "no-store" }, 15_000);
  if (!response.ok) throw new Error(`book ${response.status}`);
  return normalizeBook(bookSchema.parse(await response.json()));
}

export async function fetchCurrentBooks(tokenIds: string[]) {
  const unique = Array.from(new Set(tokenIds.filter(Boolean))).slice(0, 500);
  if (!unique.length) return new Map<string, ReturnType<typeof normalizeBook> & { capturedAt: Date; updatedAt: Date | null }>();
  const response = await fetchWithTimeout(`${CLOB_API}/books`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(unique.map((tokenId) => ({ token_id: tokenId }))),
  }, 20_000);
  if (!response.ok) throw new Error(`books ${response.status}`);
  const capturedAt = new Date();
  return new Map(batchBookSchema.parse(await response.json()).map((book) => [
    book.asset_id,
    { ...normalizeBook(book), capturedAt, updatedAt: parseBookTimestamp(book.timestamp) },
  ]));
}

function normalizeBook(book: z.infer<typeof bookSchema>) {
  const bids = book.bids.map((level) => ({ price: toNumber(level.price), size: toNumber(level.size) })).filter((level) => level.price > 0 && level.size > 0);
  const asks = book.asks.map((level) => ({ price: toNumber(level.price), size: toNumber(level.size) })).filter((level) => level.price > 0 && level.size > 0);
  return {
    bids: bids.sort((a, b) => b.price - a.price),
    asks: asks.sort((a, b) => a.price - b.price),
    minOrderSize: Math.max(0, toNumber(book.min_order_size)),
    tickSize: toNumber(book.tick_size) || 0.01,
  };
}

function parseBookTimestamp(value: string | number | undefined) {
  if (value === undefined) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferAsset(text: string): CryptoAsset | null {
  if (/\b(bitcoin|btc)\b/.test(text)) return "BTC";
  if (/\b(ethereum|ether|eth)\b/.test(text)) return "ETH";
  if (/\b(solana|sol)\b/.test(text)) return "SOL";
  if (/\b(xrp|ripple)\b/.test(text)) return "XRP";
  if (/\b(crypto|cryptocurrency|token)\b/.test(text)) return "OTHER";
  return null;
}

function inferReferenceSource(text: string): CryptoMarket["referenceSource"] {
  if (/binance/i.test(text)) return "BINANCE";
  if (/chainlink/i.test(text)) return "CHAINLINK";
  return "UNKNOWN";
}

function resolveResult(market: z.infer<typeof marketSchema>, yesPrice: number | undefined, noPrice: number | undefined): 0 | 1 | null {
  if (!market.closed && !market.resolved) return null;
  if (market.resolved === false) return null;
  if (yesPrice !== undefined && yesPrice >= 0.999) return 1;
  if (noPrice !== undefined && noPrice >= 0.999) return 0;
  return null;
}
