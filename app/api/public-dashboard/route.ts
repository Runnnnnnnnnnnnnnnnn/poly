import { NextResponse } from "next/server";

import { listBacktests } from "@/src/lib/backtest/service";
import { getMonitoringSnapshot } from "@/src/lib/monitoring/service";
import { listModelEvaluationSummaries } from "@/src/lib/model-evaluation/service";
import { listPaperRuns } from "@/src/lib/paper-trading/service";
import { createAsyncStaleWhileRevalidateCache } from "@/src/lib/server/async-swr-cache";

const dashboardCache = createAsyncStaleWhileRevalidateCache({
  ttlMs: 15_000,
  load: loadDashboard,
  onBackgroundError: (error) => console.error(`public dashboard refresh failed: ${error instanceof Error ? error.message : error}`),
});

export async function GET() {
  const snapshot = await dashboardCache.get();
  return NextResponse.json(snapshot.value, {
    headers: {
      "cache-control": "no-store",
      "x-dashboard-data-age-ms": String(snapshot.ageMs),
      "x-dashboard-refreshing": snapshot.refreshing ? "1" : "0",
    },
  });
}

async function loadDashboard() {
  const [monitoring, runs, backtests, modelEvaluations] = await Promise.all([
    getMonitoringSnapshot(),
    listPaperRuns(),
    listBacktests(20),
    listModelEvaluationSummaries(12),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    monitoring,
    runs: runs.slice(0, 20),
    backtests,
    modelEvaluations,
  };
}
