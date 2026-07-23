import { NextResponse } from "next/server";

import { getDeepSeekModel } from "@/src/lib/ai/deepseek";
import { probeDatabase } from "@/src/lib/server/database-health";

export async function GET() {
  const database = await probeDatabase();
  if (database.status !== "healthy") {
    return NextResponse.json({
      ok: false,
      app: "Polymarket Watch",
      code: database.code,
      database,
      timestamp: new Date().toISOString(),
    }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    app: "Polymarket Watch",
    database,
    deepSeekConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    deepSeekModel: getDeepSeekModel(),
    timestamp: new Date().toISOString(),
  });
}
