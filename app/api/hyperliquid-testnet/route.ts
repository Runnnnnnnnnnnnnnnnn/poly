import { NextResponse } from "next/server";

import { checkHyperliquidTestnetConnection, getHyperliquidExecutionReadiness } from "@/src/lib/combined-trading/hyperliquid-execution";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getHyperliquidExecutionReadiness());
}

export async function POST() {
  return NextResponse.json(await checkHyperliquidTestnetConnection());
}
