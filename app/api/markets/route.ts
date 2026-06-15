import { NextResponse } from "next/server";

import { getMarketsDashboard } from "@/lib/server/dashboard";

export async function GET() {
  const payload = await getMarketsDashboard();
  return NextResponse.json(payload);
}
