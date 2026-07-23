import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const path = resolve(process.env.HYPERLIQUID_MODEL_OUTPUT ?? resolve(process.cwd(), "public/hyperliquid-model.json"));
    return NextResponse.json(JSON.parse(await readFile(path, "utf8")), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({
      generatedAt: null,
      status: "collecting",
      edgeConfirmed: false,
      verdict: "優位性未確認",
      reason: "Hyperliquidモデルの初回検証を準備中です",
    });
  }
}
