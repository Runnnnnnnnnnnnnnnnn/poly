import { NextResponse } from "next/server";

import { getDeepSeekModel } from "@/src/lib/ai/deepseek";

export async function GET() {
  return NextResponse.json({
    ok: true,
    app: "Polymarket Watch",
    deepSeekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    deepSeekModel: getDeepSeekModel(),
    timestamp: new Date().toISOString(),
  });
}
