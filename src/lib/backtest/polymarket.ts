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
  })
  .passthrough();

const eventSchema = z.object({ markets: z.array(marketSchema).default([]) }).passthrough();
const searchSchema = z.object({ events: z.array(eventSchema).default([]) });
const marketsSchema = z.array(marketSchema).default([]);
const historySchema = z.object({ history: z.array(z.object({ t: z.number(), p: z.number() })).default([]) });
const bookSchema = z.object({
  bids: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
  asks: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
  min_order_size: z.union([z.string(), z.number()]).optional(),
  tick_size: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const SEARCHES = ["bitcoin", "btc", "ethereum", "eth", "solana", "sol", "xrp", "crypto price"];

export async function discoverCryptoMarkets(options: { includeResolved?: boolean; limit?: number; asset?: CryptoAsset } = {}) {
  const includeResolved = options.includeResolved ?? true;
  const limit = options.limit ?? 80;
  const searchResults = await Promise.allSettled(SEARCHES.map((query) => searchMarkets(query)));
  const searched = searchResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  const topMarkets = await fetchTopMarkets().catch(() => []);
  const all = [...searched, ...topMarkets]
    .map(toCryptoMarket)
    .filter((market): market is CryptoMarket => Boolean(market))
    .filter((market) => includeResolved || !market.resolved)
    .filter((market) => !options.asset || market.asset === options.asset);

  return Array.from(new Map(all.map((market) => [market.id, market])).values()).slice(0, limit);
}

export async function fetchHistoricalProbability(tokenId: string, options: { fidelity?: number; startTs?: number; endTs?: number } = {}) {
  const url = new URL(`${CLOB_API}/prices-history`);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("interval", "max");
  url.searchParams.set("fidelity", String(options.fidelity ?? 1440));
  if (options.startTs) url.searchParams.set("startTs", String(options.startTs));
  if (options.endTs) url.searchParams.set("endTs", String(options.endTs));

  const response = await fetchWithTimeout(url.toString(), {}, 20_000);
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
  const response = await fetchWithTimeout(url.toString(), {}, 15_000);
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
  const response = await fetchWithTimeout(url.toString(), {}, 15_000);
  if (!response.ok) throw new Error(`markets ${response.status}`);
  return marketsSchema.parse(await response.json());
}

function toCryptoMarket(market: z.infer<typeof marketSchema>): CryptoMarket | null {
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
  };
}

export async function fetchCurrentBook(tokenId: string) {
  const url = new URL(`${CLOB_API}/book`);
  url.searchParams.set("token_id", tokenId);
  const response = await fetchWithTimeout(url.toString(), {}, 15_000);
  if (!response.ok) throw new Error(`book ${response.status}`);
  const book = bookSchema.parse(await response.json());
  const bids = book.bids.map((level) => ({ price: toNumber(level.price), size: toNumber(level.size) })).filter((level) => level.price > 0 && level.size > 0);
  const asks = book.asks.map((level) => ({ price: toNumber(level.price), size: toNumber(level.size) })).filter((level) => level.price > 0 && level.size > 0);
  return {
    bids: bids.sort((a, b) => b.price - a.price),
    asks: asks.sort((a, b) => a.price - b.price),
    minOrderSize: Math.max(0, toNumber(book.min_order_size)),
    tickSize: toNumber(book.tick_size) || 0.01,
  };
}

function inferAsset(text: string): CryptoAsset | null {
  if (/\b(bitcoin|btc)\b/.test(text)) return "BTC";
  if (/\b(ethereum|ether|eth)\b/.test(text)) return "ETH";
  if (/\b(solana|sol)\b/.test(text)) return "SOL";
  if (/\b(xrp|ripple)\b/.test(text)) return "XRP";
  if (/\b(crypto|cryptocurrency|token)\b/.test(text)) return "OTHER";
  return null;
}

function resolveResult(market: z.infer<typeof marketSchema>, yesPrice: number | undefined, noPrice: number | undefined): 0 | 1 | null {
  if (!market.closed && !market.resolved) return null;
  if (market.resolved === false) return null;
  if (yesPrice !== undefined && yesPrice >= 0.999) return 1;
  if (noPrice !== undefined && noPrice >= 0.999) return 0;
  return null;
}
