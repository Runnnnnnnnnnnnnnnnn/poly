import { NextResponse } from "next/server";
import { z } from "zod";

import { collectCryptoSnapshots } from "@/src/lib/backtest/service";

const requestSchema = z.object({
  assets: z.array(z.enum(["BTC", "ETH", "SOL", "XRP", "OTHER"])).optional(),
  limit: z.number().int().positive().max(100).default(80),
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await collectCryptoSnapshots(requestSchema.parse(body));
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "collection failed" }, { status: 502 });
  }
}
