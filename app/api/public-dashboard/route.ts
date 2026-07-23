import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { listBacktests } from "@/src/lib/backtest/service";
import { getMonitoringSnapshot } from "@/src/lib/monitoring/service";
import { listModelEvaluationSummaries } from "@/src/lib/model-evaluation/service";
import { listPaperRuns } from "@/src/lib/paper-trading/service";
import { createAsyncStaleWhileRevalidateCache } from "@/src/lib/server/async-swr-cache";
import { isDatabaseCorruptionError, probeDatabase, readDatabaseHealth } from "@/src/lib/server/database-health";
import { prisma } from "@/src/lib/server/prisma";

const dashboardCache = createAsyncStaleWhileRevalidateCache({
  ttlMs: 15_000,
  load: loadDashboard,
  onBackgroundError: (error) => console.error(`public dashboard refresh failed: ${error instanceof Error ? error.message : error}`),
});

export async function GET() {
  try {
    const snapshot = await dashboardCache.get();
    return NextResponse.json(snapshot.value, {
      headers: {
        "cache-control": "no-store",
        "x-dashboard-data-age-ms": String(snapshot.ageMs),
        "x-dashboard-refreshing": snapshot.refreshing ? "1" : "0",
        "x-dashboard-source": "runtime",
      },
    });
  } catch (error) {
    console.error(`public dashboard unavailable: ${error instanceof Error ? error.message : error}`);
    const fallback = await loadStaticFallback(error);
    return NextResponse.json(fallback, {
      headers: {
        "cache-control": "no-store",
        "x-dashboard-source": "static-fallback",
      },
    });
  }
}

async function loadDashboard() {
  const [monitoring, runs, backtests, modelEvaluations, incidents, database] = await Promise.all([
    getMonitoringSnapshot(),
    listPaperRuns(),
    listBacktests(20),
    listModelEvaluationSummaries(12),
    prisma.dataQualityIncident.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
    probeDatabase(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    monitoring,
    runs: runs.slice(0, 20),
    backtests,
    modelEvaluations,
    dataQuality: {
      status: incidents.some((incident) => incident.status === "OPEN") ? "stopped" : incidents.length ? "recovered" : "healthy",
      source: "runtime",
      database,
      gaps: incidents.map((incident) => ({
        startedAt: incident.startedAt.toISOString(),
        endedAt: incident.endedAt?.toISOString() ?? null,
        scope: incident.scope,
        reason: incident.reason,
        status: incident.status,
      })),
    },
  };
}

async function loadStaticFallback(error: unknown) {
  const monitoring = JSON.parse(await readFile(resolve(process.cwd(), "public/monitoring-snapshot.json"), "utf8"));
  const message = error instanceof Error ? error.message : String(error);
  const database = readDatabaseHealth();
  return {
    generatedAt: monitoring.generatedAt ?? new Date().toISOString(),
    monitoring: {
      ...monitoring,
      status: "offline",
    },
    runs: [],
    backtests: [],
    modelEvaluations: [],
    dataQuality: {
      status: "stopped",
      source: "static-fallback",
      database,
      gaps: [{
        startedAt: "2026-07-22T11:13:02.974Z",
        endedAt: null,
        scope: "Hyperliquid・Polymarket高頻度ティック",
        reason: "SQLite破損による収集停止",
      }],
      code: isDatabaseCorruptionError(message) || database?.status === "corrupt"
        ? "DATABASE_CORRUPTION"
        : "DATABASE_UNAVAILABLE",
    },
  };
}
