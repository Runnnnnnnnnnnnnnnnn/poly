import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const root = process.env.POLYMARKET_PROJECT_ROOT || resolve(import.meta.dirname, "..");
const dataRoot = resolve(homedir(), ".polymarket-watch");
const python = process.env.MLFLOW_PYTHON_BIN || resolve(dataRoot, "mlflow-venv/bin/python");
const mlflow = process.env.MLFLOW_BIN || resolve(dataRoot, "mlflow-venv/bin/mlflow");
const databasePath = process.env.MLFLOW_DATABASE_PATH || resolve(dataRoot, "mlflow.db");
const artifactRoot = process.env.MLFLOW_ARTIFACT_ROOT || resolve(dataRoot, "mlartifacts");
const statusPath = process.env.MLFLOW_STATUS_PATH || resolve(dataRoot, "mlflow-status.json");
const port = Math.round(boundedNumber(process.env.MLFLOW_PORT, 8080, 1_024, 65_535));
const importIntervalMs = boundedNumber(
  process.env.MLFLOW_IMPORT_INTERVAL_MS,
  30 * 60_000,
  5 * 60_000,
  24 * 60 * 60_000,
);
const trackingUri = process.env.MLFLOW_TRACKING_URI || `sqlite:///${databasePath}`;
const startedAt = new Date().toISOString();
let server = null;
let importing = false;
let closing = false;
let lastImportAt = null;
let lastImport = null;
let lastHealthyAt = null;
let healthError = null;

for (const binary of [python, mlflow]) {
  if (!existsSync(binary)) throw new Error(`MLflow runtime is missing: ${binary}`);
}
mkdirSync(artifactRoot, { recursive: true });

await importReports();
server = spawn(mlflow, [
  "server",
  "--host", "127.0.0.1",
  "--port", String(port),
  "--backend-store-uri", trackingUri,
  "--default-artifact-root", artifactRoot,
  "--workers", "1",
], {
  cwd: dataRoot,
  env: { ...process.env, MLFLOW_TRACKING_URI: trackingUri },
  stdio: "inherit",
});
writeStatus("starting");

server.on("error", (error) => {
  healthError = error instanceof Error ? error.message : String(error);
  writeStatus("error");
});
server.on("exit", (code, signal) => {
  if (closing) return;
  healthError = `MLflow server stopped (${signal ?? code ?? "unknown"})`;
  writeStatus("error");
  process.exit(code || 1);
});

const importTimer = setInterval(() => void importReports(), importIntervalMs);
const healthTimer = setInterval(() => void checkHealth(), 30_000);
try {
  await waitForHealth();
} catch (error) {
  server.kill("SIGTERM");
  throw error;
}
console.log(`MLflow tracking: http://127.0.0.1:${port} / import every ${importIntervalMs}ms`);

async function importReports() {
  if (importing) return;
  importing = true;
  try {
    const result = spawnSync(python, [resolve(root, "scripts/import-model-evaluations-mlflow.py")], {
      cwd: root,
      env: {
        ...process.env,
        MLFLOW_TRACKING_URI: trackingUri,
        MLFLOW_ARTIFACT_ROOT: artifactRoot,
      },
      encoding: "utf8",
      timeout: 15 * 60_000,
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `import exited ${result.status}`).trim());
    }
    const output = result.stdout.trim().split("\n").at(-1) || "{}";
    lastImport = JSON.parse(output);
    lastImportAt = new Date().toISOString();
    console.log(JSON.stringify({ type: "mlflow-import", ...lastImport }));
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
    console.error(`MLflow import failed: ${healthError}`);
  } finally {
    importing = false;
    writeStatus(healthError ? "attention" : lastHealthyAt ? "healthy" : "starting");
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await checkHealth()) return;
    await sleep(1_000);
  }
  throw new Error(healthError || "MLflow health check timed out");
}

async function checkHealth() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    lastHealthyAt = new Date().toISOString();
    healthError = null;
    writeStatus("healthy");
    return true;
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error);
    writeStatus("starting");
    return false;
  }
}

function writeStatus(status) {
  const value = {
    status,
    startedAt,
    updatedAt: new Date().toISOString(),
    lastHealthyAt,
    lastImportAt,
    lastImport,
    error: healthError,
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    importIntervalMs,
    serverPid: server?.pid ?? null,
  };
  const temporary = `${statusPath}.${process.pid}.tmp`;
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statusPath);
}

function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(importTimer);
  clearInterval(healthTimer);
  healthError = null;
  writeStatus("stopping");
  server?.kill("SIGTERM");
  setTimeout(() => {
    server = null;
    writeStatus("stopped");
    process.exit(0);
  }, 500);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
