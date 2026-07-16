import { NextResponse } from "next/server";

import { getMonitoringSnapshot } from "@/src/lib/monitoring/service";

export async function GET() {
  return NextResponse.json(await getMonitoringSnapshot(), {
    headers: { "cache-control": "no-store" },
  });
}
