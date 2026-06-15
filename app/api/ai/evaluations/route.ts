import { NextResponse } from "next/server";

import { getMarketAiEvaluations } from "@/src/lib/ai/market-evaluations";

export async function GET() {
  const payload = await getMarketAiEvaluations();
  return NextResponse.json(payload, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
