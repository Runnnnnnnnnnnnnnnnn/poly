import { z } from "zod";

import { fetchWithTimeout, toNumber } from "@/lib/utils";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "@/src/lib/monitoring/heartbeat";
import { prisma } from "@/src/lib/server/prisma";

const HYPERLIQUID_INFO_API = "https://api.hyperliquid.xyz/info";
const trackedAssetNames = ["BTC", "ETH", "SOL", "XRP", "HYPE"] as const;
const trackedAssets = new Set<string>(trackedAssetNames);

const metaSchema = z.object({
  universe: z.array(z.object({ name: z.string() }).passthrough()),
}).passthrough();

const contextSchema = z.object({
  midPx: z.string().nullable().optional(),
  markPx: z.string(),
  oraclePx: z.string(),
  prevDayPx: z.string(),
  dayNtlVlm: z.string(),
  openInterest: z.string(),
  funding: z.string(),
}).passthrough();

const responseSchema = z.tuple([metaSchema, z.array(contextSchema)]);
const bookLevelSchema = z.object({
  px: z.string(),
  sz: z.string(),
  n: z.number(),
}).passthrough();
const l2BookSchema = z.object({
  coin: z.string(),
  time: z.number(),
  levels: z.tuple([z.array(bookLevelSchema), z.array(bookLevelSchema)]),
}).passthrough();

export type HyperliquidMarketState = {
  asset: string;
  midPrice: number;
  markPrice: number;
  oraclePrice: number;
  previousDayPrice: number;
  dayVolume: number;
  openInterest: number;
  fundingRate: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  bookUpdatedAt: Date | null;
  capturedAt: Date;
};

export async function collectHyperliquidSnapshots(providedStates?: HyperliquidMarketState[]) {
  await markPipelineAttempt("hyperliquid", "主要5銘柄を取得中");
  try {
    const states = providedStates ?? await fetchHyperliquidMarketStates();
    const snapshots = states.map((state) => ({ ...state, id: `${state.asset}:${state.capturedAt.getTime()}` }));

    if (snapshots.length) await prisma.hyperliquidSnapshot.createMany({ data: snapshots });
    await markPipelineSuccess("hyperliquid", snapshots.length, `${snapshots.length}銘柄を保存`);
    return { capturedAt: states[0]?.capturedAt.toISOString() ?? new Date().toISOString(), saved: snapshots.length, assets: snapshots.map((item) => item.asset) };
  } catch (error) {
    await markPipelineError("hyperliquid", error);
    throw error;
  }
}

export async function fetchHyperliquidMarketStates(): Promise<HyperliquidMarketState[]> {
  const [response, books] = await Promise.all([
    fetchWithTimeout(
      HYPERLIQUID_INFO_API,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      },
      20_000,
    ),
    fetchHyperliquidOrderBooks(),
  ]);
  if (!response.ok) throw new Error(`Hyperliquid info ${response.status}`);

  const [meta, contexts] = responseSchema.parse(await response.json());
  const capturedAt = new Date();
  return meta.universe.flatMap((asset, index) => {
    const context = contexts[index];
    if (!trackedAssets.has(asset.name) || !context) return [];
    const book = books.get(asset.name) ?? null;
    const markPrice = toNumber(context.markPx);
    const midPrice = book ? (book.bestBid + book.bestAsk) / 2 : toNumber(context.midPx) || markPrice;
    if (midPrice <= 0 || markPrice <= 0) return [];
    return [{
      asset: asset.name,
      midPrice,
      markPrice,
      oraclePrice: toNumber(context.oraclePx),
      previousDayPrice: toNumber(context.prevDayPx),
      dayVolume: toNumber(context.dayNtlVlm),
      openInterest: toNumber(context.openInterest),
      fundingRate: toNumber(context.funding),
      bestBid: book?.bestBid ?? null,
      bestAsk: book?.bestAsk ?? null,
      spread: book?.spread ?? null,
      bookUpdatedAt: book?.updatedAt ?? null,
      capturedAt,
    }];
  });
}

export function normalizeHyperliquidOrderBook(input: unknown) {
  const book = l2BookSchema.parse(input);
  const bestBid = toNumber(book.levels[0][0]?.px);
  const bestAsk = toNumber(book.levels[1][0]?.px);
  if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) return null;
  return {
    asset: book.coin,
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    updatedAt: new Date(book.time),
  };
}

async function fetchHyperliquidOrderBooks() {
  const books = await Promise.all(trackedAssetNames.map(async (asset) => {
    try {
      const response = await fetchWithTimeout(
        HYPERLIQUID_INFO_API,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "l2Book", coin: asset }),
        },
        15_000,
      );
      if (!response.ok) return null;
      return normalizeHyperliquidOrderBook(await response.json());
    } catch {
      return null;
    }
  }));
  return new Map(books.flatMap((book) => book ? [[book.asset, book] as const] : []));
}
