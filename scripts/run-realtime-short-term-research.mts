import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { prisma } from "../src/lib/server/prisma";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const intervalMs = Math.max(5 * 60_000, Number(process.env.REALTIME_SHORT_TERM_INTERVAL_MS ?? 30 * 60_000));
const reportPath = resolve(root, "public/realtime-short-term-research.json");
const historyPath = resolve(root, "public/realtime-short-term-research-history.json");
let running = false;

async function cycle() {
  if (running) return;
  const fresh = await loadReport().catch(() => null);
  if (fresh && Date.now() - new Date(fresh.generatedAt).getTime() < intervalMs * 0.9) {
    await recordSuccess(fresh);
    return;
  }
  running = true;
  try {
    await markPipelineAttempt("realtime-short-term-backtest", "5秒板の約定リプレイを検証中");
    await runBacktest();
    await recordSuccess(await loadReport());
  } catch (error) {
    await markPipelineError("realtime-short-term-backtest", error);
    console.error(error instanceof Error ? error.message : error);
  } finally {
    running = false;
  }
}

async function recordSuccess(report: ReplayReport) {
  const selected = report.variants.find((variant) => variant.id === report.selection.selectedExploratoryCandidateId);
  const holdoutWindows = selected?.holdout.independentWindows ?? 0;
  await markPipelineSuccess(
    "realtime-short-term-backtest",
    report.coverage.replayableMarkets,
    `独立${report.coverage.independentWindows}枠 / 検証${holdoutWindows}枠 / ${statusLabel(report.selection.status)}`,
  );
}

function loadReport() {
  return readFile(reportPath, "utf8").then((value) => JSON.parse(value) as ReplayReport);
}

function runBacktest() {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "scripts/backtest-realtime-short-term.mts")],
      {
        cwd: root,
        env: {
          ...process.env,
          REALTIME_SHORT_TERM_OUTPUT: reportPath,
          REALTIME_SHORT_TERM_HISTORY_OUTPUT: historyPath,
          REALTIME_SHORT_TERM_ARTIFACT_ROOT: resolve(homedir(), ".polymarket-watch/artifacts/realtime-short-term-backtests"),
          REALTIME_SHORT_TERM_QUIET: "1",
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
      else reject(new Error(`5-second replay stopped (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
    });
  });
}

function statusLabel(status: ReplayReport["selection"]["status"]) {
  return status === "promising" ? "探索通過" : status === "rejected" ? "基準未達" : "データ不足";
}

type ReplayReport = {
  generatedAt: string;
  coverage: { replayableMarkets: number; independentWindows: number };
  selection: { status: "insufficient" | "promising" | "rejected"; selectedExploratoryCandidateId: string | null };
  variants: Array<{ id: string; holdout: { independentWindows: number } }>;
};

await cycle();
setInterval(() => void cycle(), intervalMs);
console.log(`realtime short-term research worker: ${intervalMs}ms`);

async function shutdown() {
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
