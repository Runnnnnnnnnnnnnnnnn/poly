import { NextResponse } from "next/server";
import { z } from "zod";

import {
  cancelOutstandingHyperliquidTestnetOrders,
  cancelHyperliquidTestnetOrder,
  checkHyperliquidTestnetConnection,
  flattenHyperliquidTestnetPositions,
  getHyperliquidExecutionReadiness,
  reconcileHyperliquidTestnetOrders,
} from "@/src/lib/combined-trading/hyperliquid-execution";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getHyperliquidExecutionReadiness());
}

export async function POST(request: Request) {
  const parsed = z.object({
    action: z.enum(["check", "reconcile", "cancel", "cancel-all", "flatten"]).optional(),
    asset: z.enum(["BTC", "ETH", "SOL", "XRP"]).optional(),
    clientOrderId: z.string().min(1).max(100).optional(),
  }).safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid testnet request" }, { status: 400 });
  if (parsed.data.action === "reconcile") return NextResponse.json(await reconcileHyperliquidTestnetOrders());
  if (parsed.data.action === "cancel-all") return NextResponse.json(await cancelOutstandingHyperliquidTestnetOrders());
  if (parsed.data.action === "flatten") return NextResponse.json(await flattenHyperliquidTestnetPositions());
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
