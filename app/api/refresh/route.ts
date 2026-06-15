import { NextResponse } from "next/server";

import { getMarketsDashboard, getNewsDashboard } from "@/lib/server/dashboard";

export async function POST() {
  const [markets, news] = await Promise.all([getMarketsDashboard(), getNewsDashboard()]);
  return NextResponse.json(
    {
      ok: true,
      refreshedAt: new Date().toISOString(),
      markets: {
        status: markets.status,
        count: markets.markets.length,
      },
      news: {
        status: news.status,
        count: news.items.length,
      },
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
