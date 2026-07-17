import { NextResponse } from "next/server";

import { listBacktests } from "@/src/lib/backtest/service";
import { getMonitoringSnapshot } from "@/src/lib/monitoring/service";
import { listPaperRuns } from "@/src/lib/paper-trading/service";

export async function GET() {
  const [monitoring, runs, backtests] = await Promise.all([
    getMonitoringSnapshot(),
    listPaperRuns(),
    listBacktests(20),
  ]);

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      monitoring,
      runs: runs.slice(0, 20),
      backtests,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
