import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { prisma } from "../src/lib/server/prisma";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const intervalMs = Math.max(60 * 60_000, Number(process.env.SHORT_TERM_RESEARCH_INTERVAL_MS ?? 6 * 60 * 60_000));
const reportPath = resolve(root, "public/short-term-research.json");
const historyPath = resolve(root, "public/short-term-research-history.json");
let running = false;

async function cycle() {
  if (running) return;
  const freshReport = await loadFreshReport();
  if (freshReport) {
    await markPipelineSuccess(
      "short-term-backtest",
      freshReport.coverage.completeMarkets,
      `保存済み15分市場${freshReport.coverage.completeMarkets}件 / 現行モデル ${freshReport.screening.baseline.status}`,
    );
    return;
  }
  running = true;
  try {
    await markPipelineAttempt("short-term-backtest", "15分固定モデルの過去72時間を検証中");
    await runBacktest();
    const report = await loadReport();
    await markPipelineSuccess(
      "short-term-backtest",
      report.coverage.completeMarkets,
      `15分市場${report.coverage.completeMarkets}件 / 現行モデル ${report.screening.baseline.status}`,
    );
    console.log(JSON.stringify({
      type: "short-term-history-backtest",
      generatedAt: report.generatedAt,
      completeMarkets: report.coverage.completeMarkets,
      status: report.screening.baseline.status,
    }));
  } catch (error) {
    await markPipelineError("short-term-backtest", error);
    console.error(error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

async function loadReport() {
  return JSON.parse(await readFile(reportPath, "utf8")) as {
    generatedAt: string;
    coverage: { completeMarkets: number };
    screening: { baseline: { status: string } };
  };
}

async function loadFreshReport() {
  try {
    const report = await loadReport();
    const generatedAt = new Date(report.generatedAt).getTime();
    return Number.isFinite(generatedAt) && Date.now() - generatedAt < intervalMs * 0.9 ? report : null;
  } catch {
    return null;
  }
}

function runBacktest() {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "scripts/backtest-short-term-history.mts")],
      {
        cwd: root,
        env: {
          ...process.env,
          SHORT_TERM_HISTORY_HOURS: "72",
          SHORT_TERM_MARKET_DURATION: "15m",
          SHORT_TERM_EXECUTION_MODE: "taker",
          SHORT_TERM_STRATEGY_TRIALS: "11",
          SHORT_TERM_HISTORY_OUTPUT: reportPath,
          SHORT_TERM_HISTORY_INDEX_OUTPUT: historyPath,
          SHORT_TERM_ARTIFACT_ROOT: resolve(homedir(), ".polymarket-watch/artifacts/short-term-backtests"),
          SHORT_TERM_HISTORY_QUIET: "1",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`15-minute backtest stopped (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
    });
  });
}

async function scheduleNextCycle() {
  await cycle();
  const report = await loadReport().catch(() => null);
  const generatedAt = report ? new Date(report.generatedAt).getTime() : Number.NaN;
  const ageMs = Number.isFinite(generatedAt) ? Math.max(0, Date.now() - generatedAt) : intervalMs;
  const delayMs = Math.max(60_000, intervalMs - ageMs);
  setTimeout(() => void scheduleNextCycle(), delayMs);
}

await scheduleNextCycle();
console.log(`short-term research worker: ${intervalMs}ms`);

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
