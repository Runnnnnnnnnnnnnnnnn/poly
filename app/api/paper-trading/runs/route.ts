import { NextResponse } from "next/server";
import { z } from "zod";

import { createPaperRun, listPaperRuns } from "@/src/lib/paper-trading/service";

const configSchema = z.object({
  initialCash: z.number().positive().optional(),
  entryEdge: z.number().min(0).max(0.5).optional(),
  maxPositionPct: z.number().min(0.001).max(1).optional(),
  spreadBps: z.number().min(0).max(10_000).optional(),
  slippageBps: z.number().min(0).max(10_000).optional(),
  takerFeeRate: z.number().min(0).max(1).optional(),
  minTrainingMarkets: z.number().int().min(0).max(100).optional(),
  calibrationPrior: z.number().min(0).max(100).optional(),
  maxMarkets: z.number().int().min(1).max(100).optional(),
});

const schema = z.object({
  accountId: z.string().optional(),
  accountName: z.string().trim().min(1).max(80).optional(),
  asset: z.enum(["BTC", "ETH", "SOL", "XRP", "OTHER"]).default("BTC"),
  mode: z.enum(["historical", "live"]).default("historical"),
  strategy: z.literal("calibrated_consensus").default("calibrated_consensus"),
  config: configSchema.default({}),
});

export async function GET(request: Request) {
  const accountId = new URL(request.url).searchParams.get("accountId") ?? undefined;
  return NextResponse.json({ items: await listPaperRuns(accountId) }, { headers: noStore() });
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json().catch(() => ({})));
    const result = await createPaperRun(input);
    return NextResponse.json(result, { status: result?.status === "failed" ? 502 : 200, headers: noStore() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "paper run failed" }, { status: 502, headers: noStore() });
  }
}

function noStore() { return { "cache-control": "no-store" }; }
