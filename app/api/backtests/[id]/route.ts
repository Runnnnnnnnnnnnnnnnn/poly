import { NextResponse } from "next/server";

import { getBacktest } from "@/src/lib/backtest/service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await getBacktest(id);
  if (!result) return NextResponse.json({ error: "backtest not found" }, { status: 404 });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
