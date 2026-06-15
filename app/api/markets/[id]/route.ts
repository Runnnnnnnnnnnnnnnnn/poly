import { NextResponse } from "next/server";

import { getMarketDetailDashboard } from "@/lib/server/dashboard";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const payload = await getMarketDetailDashboard(id);
  return NextResponse.json(payload);
}
