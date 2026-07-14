import { NextResponse } from "next/server";
import { z } from "zod";

import { getCryptoForecast } from "@/src/lib/backtest/service";

const querySchema = z.object({
  asset: z.enum(["BTC", "ETH", "SOL", "XRP", "OTHER"]).default("BTC"),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const query = querySchema.parse({ asset: params.get("asset") ?? "BTC", targetDate: params.get("targetDate") ?? undefined });
    return NextResponse.json(await getCryptoForecast(query.asset, query.targetDate), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "forecast failed" }, { status: 502 });
  }
}
