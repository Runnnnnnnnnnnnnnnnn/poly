import { NextResponse } from "next/server";

import { getWalletIntelligenceDashboard } from "@/src/lib/wallet-intelligence/service";

export async function GET() {
  return NextResponse.json(await getWalletIntelligenceDashboard(), {
    headers: { "cache-control": "no-store" },
  });
}
