import { NextResponse } from "next/server";

import { listBacktests } from "@/src/lib/backtest/service";
import { getMonitoringSnapshot } from "@/src/lib/monitoring/service";
import { listModelEvaluationSummaries } from "@/src/lib/model-evaluation/service";
import { listPaperRuns } from "@/src/lib/paper-trading/service";

export async function GET() {
  const [monitoring, runs, backtests, modelEvaluations] = await Promise.all([
    getMonitoringSnapshot(),
    listPaperRuns(),
    listBacktests(20),
    listModelEvaluationSummaries(12),
  ]);

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      monitoring,
      runs: runs.slice(0, 20),
      backtests,
      modelEvaluations,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
