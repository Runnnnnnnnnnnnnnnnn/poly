import { NextResponse } from "next/server";
import { z } from "zod";

import { listBacktests, runBacktest } from "@/src/lib/backtest/service";
import type { CryptoAsset } from "@/src/lib/backtest/types";

const requestSchema = z.object({
  asset: z.enum(["BTC", "ETH", "SOL", "XRP", "OTHER"]).default("BTC"),
  threshold: z.number().min(0.5).max(0.99).default(0.55),
  initialCapital: z.number().positive().default(1000),
  limit: z.number().int().positive().max(100).default(40),
});

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 20);
  return NextResponse.json({ items: await listBacktests(Number.isFinite(limit) ? limit : 20) }, { headers: noStore() });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = requestSchema.parse(body);
    const result = await runBacktest(input as { asset: CryptoAsset; threshold: number; initialCapital: number; limit: number });
    return NextResponse.json(result, { status: result.status === "failed" ? 502 : 200, headers: noStore() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid request" }, { status: 400, headers: noStore() });
  }
}

function noStore() { return { "cache-control": "no-store" }; }
