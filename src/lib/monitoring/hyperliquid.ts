import { z } from "zod";

import { fetchWithTimeout, toNumber } from "@/lib/utils";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "@/src/lib/monitoring/heartbeat";
import { prisma } from "@/src/lib/server/prisma";

const HYPERLIQUID_INFO_API = "https://api.hyperliquid.xyz/info";
const trackedAssets = new Set(["BTC", "ETH", "SOL", "XRP", "HYPE"]);

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

export async function collectHyperliquidSnapshots() {
  await markPipelineAttempt("hyperliquid", "主要5銘柄を取得中");
  try {
    const response = await fetchWithTimeout(
      HYPERLIQUID_INFO_API,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      },
      20_000,
    );
    if (!response.ok) throw new Error(`Hyperliquid info ${response.status}`);

    const [meta, contexts] = responseSchema.parse(await response.json());
    const capturedAt = new Date();
    const snapshots = meta.universe.flatMap((asset, index) => {
      const context = contexts[index];
      if (!trackedAssets.has(asset.name) || !context) return [];
      const markPrice = toNumber(context.markPx);
      const midPrice = toNumber(context.midPx) || markPrice;
      if (midPrice <= 0 || markPrice <= 0) return [];
      return [{
        id: `${asset.name}:${capturedAt.getTime()}`,
        asset: asset.name,
        midPrice,
        markPrice,
        oraclePrice: toNumber(context.oraclePx),
        previousDayPrice: toNumber(context.prevDayPx),
        dayVolume: toNumber(context.dayNtlVlm),
        openInterest: toNumber(context.openInterest),
        fundingRate: toNumber(context.funding),
        capturedAt,
      }];
    });

    if (snapshots.length) await prisma.hyperliquidSnapshot.createMany({ data: snapshots });
    await markPipelineSuccess("hyperliquid", snapshots.length, `${snapshots.length}銘柄を保存`);
    return { capturedAt: capturedAt.toISOString(), saved: snapshots.length, assets: snapshots.map((item) => item.asset) };
  } catch (error) {
    await markPipelineError("hyperliquid", error);
    throw error;
  }
}
