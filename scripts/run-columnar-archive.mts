import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { prisma } from "../src/lib/server/prisma";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const stateRoot = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
const intervalMs = boundedNumber(process.env.COLUMNAR_ARCHIVE_INTERVAL_MS, 6 * 60 * 60_000, 60 * 60_000, 24 * 60 * 60_000);
const databaseSource = process.env.DATABASE_URL;
const archiveRoot = resolve(process.env.COLUMNAR_ARCHIVE_ROOT ?? resolve(stateRoot, "parquet"));
const statusPath = resolve(process.env.COLUMNAR_ARCHIVE_STATUS_PATH ?? resolve(stateRoot, "columnar-archive-status.json"));
const python = resolveAnalyticsPython(stateRoot);
let running = false;
let child: ReturnType<typeof spawn> | null = null;
let timer: NodeJS.Timeout | null = null;
let closing = false;

if (!databaseSource) throw new Error("columnar archive requires DATABASE_URL");

async function archiveCycle() {
  if (running) return;
  running = true;
  try {
    await markPipelineAttempt("columnar-archive", "完了日の5秒板をParquetへ保存中");
    if (!existsSync(python)) throw new Error(`分析用Pythonがありません: npm run analytics:install を実行してください`);
    const status = await executeArchive();
    if (status.status !== "healthy") throw new Error(status.message || "Parquet archive verification failed");
    await markPipelineSuccess(
      "columnar-archive",
      status.rows,
      status.archivedThrough
        ? `${status.archivedThrough}まで・${status.partitions}区画を検証済み`
        : "最初のUTC完了日を待機中",
    );
    console.log(JSON.stringify({ type: "columnar-archive", ...status }));
  } catch (error) {
    await markPipelineError("columnar-archive", error);
    console.error(error instanceof Error ? error.message : error);
  } finally {
    child = null;
    running = false;
  }
}

function executeArchive() {
  return new Promise<ArchiveStatus>((resolvePromise, reject) => {
    child = spawn(python, [
      resolve(root, "scripts/archive-realtime-data.py"),
      "--database", databaseSource as string,
      "--output", archiveRoot,
      "--status", statusPath,
    ], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-32_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-32_000); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`columnar archive stopped (${signal ?? code ?? "unknown"}): ${(stderr || stdout).trim()}`));
        return;
      }
      try {
        const line = stdout.trim().split("\n").at(-1) ?? "{}";
        resolvePromise(JSON.parse(line) as ArchiveStatus);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function schedule() {
  await archiveCycle();
  if (process.env.ONCE === "1") return shutdown(0);
  if (!closing) timer = setTimeout(() => void schedule(), intervalMs);
}

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  if (timer) clearTimeout(timer);
  child?.kill("SIGTERM");
  await prisma.$disconnect();
  if (process.env.ONCE === "1") process.exit(code);
}

void schedule();
console.log(`columnar archive worker: every ${intervalMs}ms / ${archiveRoot}`);
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function resolveAnalyticsPython(stateDirectory: string) {
  const marker = resolve(stateDirectory, "analytics-python-path");
  const candidates = [
    process.env.COLUMNAR_ARCHIVE_PYTHON,
    existsSync(marker) ? readFileSync(marker, "utf8").trim() : null,
    resolve(stateDirectory, "analytics-venv/bin/python"),
    resolve(stateDirectory, "mlflow-venv/bin/python"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "/usr/bin/python3";
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

type ArchiveStatus = {
  status: "healthy" | "error";
  archivedThrough: string | null;
  partitions: number;
  rows: number;
  sizeBytes: number;
  message: string;
};
