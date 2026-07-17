import { NextResponse } from "next/server";

import { checkHyperliquidTestnetConnection, getHyperliquidExecutionReadiness, reconcileHyperliquidTestnetOrders } from "@/src/lib/combined-trading/hyperliquid-execution";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getHyperliquidExecutionReadiness());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { action?: unknown };
  return NextResponse.json(body.action === "reconcile"
    ? await reconcileHyperliquidTestnetOrders()
    : await checkHyperliquidTestnetConnection());
}
