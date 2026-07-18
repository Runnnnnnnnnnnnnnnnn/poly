import { NextResponse } from "next/server";
import { z } from "zod";

import {
  cancelOutstandingHyperliquidTestnetOrders,
  cancelHyperliquidTestnetOrder,
  checkHyperliquidTestnetConnection,
  flattenHyperliquidTestnetPositions,
  getHyperliquidExecutionReadiness,
  reconcileHyperliquidTestnetOrders,
  runHyperliquidTestnetSmokeTest,
} from "@/src/lib/combined-trading/hyperliquid-execution";
import { fetchHyperliquidMarketStates } from "@/src/lib/monitoring/hyperliquid";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getHyperliquidExecutionReadiness());
}

export async function POST(request: Request) {
  const parsed = z.object({
    action: z.enum(["check", "reconcile", "cancel", "cancel-all", "flatten", "smoke-test"]).optional(),
    asset: z.enum(["BTC", "ETH", "SOL", "XRP"]).optional(),
    clientOrderId: z.string().min(1).max(100).optional(),
    notionalUsd: z.number().min(10).max(15).optional(),
    confirmation: z.literal("TESTNET_ONLY").optional(),
  }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid testnet request" }, { status: 400 });
  if (parsed.data.action === "reconcile") return NextResponse.json(await reconcileHyperliquidTestnetOrders());
  if (parsed.data.action === "cancel-all") return NextResponse.json(await cancelOutstandingHyperliquidTestnetOrders());
  if (parsed.data.action === "flatten") return NextResponse.json(await flattenHyperliquidTestnetPositions());
  if (parsed.data.action === "smoke-test") {
    if (parsed.data.confirmation !== "TESTNET_ONLY") {
      return NextResponse.json({ error: "confirmation TESTNET_ONLY is required" }, { status: 400 });
    }
    const asset = parsed.data.asset ?? "BTC";
    const states = await fetchHyperliquidMarketStates();
    const referencePrice = states.find((state) => state.asset === asset)?.midPrice ?? null;
    if (!referencePrice) return NextResponse.json({ error: `${asset} reference price is unavailable` }, { status: 503 });
    try {
      return NextResponse.json(await runHyperliquidTestnetSmokeTest({
        asset,
        notionalUsd: parsed.data.notionalUsd ?? 12,
        referencePrice,
      }));
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "testnet smoke test failed" }, { status: 409 });
    }
  }
  if (parsed.data.action === "cancel") {
    if (!parsed.data.asset || !parsed.data.clientOrderId) {
      return NextResponse.json({ error: "asset and clientOrderId are required" }, { status: 400 });
    }
    return NextResponse.json(await cancelHyperliquidTestnetOrder({
      asset: parsed.data.asset,
      clientOrderId: parsed.data.clientOrderId,
    }));
  }
  return NextResponse.json(await checkHyperliquidTestnetConnection());
}
