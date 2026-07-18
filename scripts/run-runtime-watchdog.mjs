import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { evaluateRuntimeWatchdog } from "./runtime-watchdog-policy.mjs";

const port = process.env.APP_PORT || "3001";
const stateDir = resolve(homedir(), ".polymarket-watch");
const statePath = resolve(stateDir, "runtime-watchdog.json");
const runtimeLabel = process.env.POLYMARKET_RUNTIME_LABEL || "com.polymarket-watch.runtime";
const now = new Date();
const previous = readState();
let healthOk = false;
let dashboardGeneratedAt = null;
let errorMessage = null;

try {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!health.ok) throw new Error(`health returned ${health.status}`);
  healthOk = true;
  const dashboard = await fetch(`http://127.0.0.1:${port}/api/public-dashboard`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!dashboard.ok) throw new Error(`dashboard returned ${dashboard.status}`);
  const payload = await dashboard.json();
  dashboardGeneratedAt = typeof payload?.generatedAt === "string" ? payload.generatedAt : null;
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
}

const decision = evaluateRuntimeWatchdog({
  nowMs: now.getTime(),
  healthOk,
  dashboardGeneratedAt,
  errorMessage,
  previousFailures: previous.consecutiveFailures,
  lastRestartAt: previous.lastRestartAt,
  maximumDataAgeMs: process.env.RUNTIME_WATCHDOG_MAX_DATA_AGE_MS,
  failureThreshold: process.env.RUNTIME_WATCHDOG_FAILURE_THRESHOLD,
  restartCooldownMs: process.env.RUNTIME_WATCHDOG_RESTART_COOLDOWN_MS,
});
let lastRestartAt = previous.lastRestartAt ?? null;
let restartCount = Number(previous.restartCount ?? 0);
let consecutiveFailures = decision.consecutiveFailures;

if (decision.action === "restart") {
  execFileSync("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${runtimeLabel}`], { stdio: "inherit" });
  lastRestartAt = now.toISOString();
  restartCount += 1;
  consecutiveFailures = 0;
}

mkdirSync(stateDir, { recursive: true });
writeFileSync(statePath, `${JSON.stringify({
  status: decision.action,
  reason: decision.reason,
  checkedAt: now.toISOString(),
  dashboardGeneratedAt,
  dataAgeMs: decision.dataAgeMs,
  consecutiveFailures,
  failureThreshold: Math.max(2, Math.round(Number(process.env.RUNTIME_WATCHDOG_FAILURE_THRESHOLD || 3))),
  lastRestartAt,
  restartCount,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(statePath, 0o600);
console.log(JSON.stringify({ type: "runtime-watchdog", action: decision.action, reason: decision.reason, consecutiveFailures, restartCount }));

function readState() {
  if (!existsSync(statePath)) return {};
  try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return {}; }
}
