import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  const path = resolve(process.env.WALLET_BACKTEST_OUTPUT ?? resolve(process.cwd(), "public/wallet-backtest.json"));
  try {
    return NextResponse.json(JSON.parse(await readFile(path, "utf8")), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({
      generatedAt: null,
      status: "collecting",
      edgeConfirmed: false,
      reason: "最初のウォレット追随結果を収集中です",
      reports: [],
    });
  }
}
