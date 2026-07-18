import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { processSignalTarget, supervisorExitDelayMs, supervisorForceKillDelayMs } from "./process-supervisor-policy.mjs";

const root = process.env.POLYMARKET_PROJECT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeCwd = process.env.POLYMARKET_RUNTIME_CWD || root;
const lockPath = resolve(homedir(), ".polymarket-watch.run.lock");
try {
  writeFileSync(lockPath, String(process.pid), { flag: "wx" });
} catch {
  const existingPid = Number(readFileSync(lockPath, "utf8"));
  try {
    process.kill(existingPid, 0);
    console.error(`supervisor already running (pid ${existingPid})`);
    process.exit(0);
  } catch {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  }
}

const production = process.env.PAPER_PRODUCTION === "1";
const appPort = process.env.APP_PORT || process.env.PORT || "3001";
const env = {
  ...process.env,
  POLYMARKET_PROJECT_ROOT: root,
  PAPER_RUN_FILE: process.env.PAPER_RUN_FILE || join(root, ".paper-run-id"),
};
const enableLegacyExperiments = process.env.ENABLE_LEGACY_EXPERIMENTS === "1";
const processes = [
  {
    name: "web",
    command: process.execPath,
    args: [join(root, "node_modules/next/dist/bin/next"), production ? "start" : "dev", root, "--hostname", "127.0.0.1", "--port", appPort],
  },
  ...(enableLegacyExperiments ? [
    {
      name: "worker",
      command: process.execPath,
      args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-paper-trading.mts")],
    },
    {
      name: "combined-shadow",
      command: process.execPath,
      args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-combined-shadow.mts")],
    },
  ] : []),
  {
    name: "forward-experiment",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-forward-experiment.mts")],
  },
  {
    name: "short-term-direction",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-short-term-direction.mts")],
  },
  {
    name: "forward-execution-audit-report",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-forward-execution-audit-report.mts")],
  },
  {
    name: "short-term-research",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-short-term-research.mts")],
  },
  {
    name: "realtime-short-term-research",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-realtime-short-term-research.mts")],
  },
  {
    name: "realtime-market-data",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-realtime-market-data.mts")],
  },
  {
    name: "columnar-archive",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-columnar-archive.mts")],
  },
  {
    name: "monitor",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-monitoring.mts")],
  },
  {
    name: "encrypted-backup",
    command: process.execPath,
    args: [join(root, "scripts/run-encrypted-backup.mjs")],
  },
  {
    name: "operational-alerts",
    command: process.execPath,
    args: [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "scripts/run-operational-alerts.mts")],
  },
];
const children = new Map();

let closing = false;
function startProcess(config) {
  if (closing) return;
  const child = spawn(config.command, config.args, {
    cwd: runtimeCwd,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.set(config.name, child);
  child.on("exit", (code, signal) => {
    children.delete(config.name);
    if (closing) return;
    signalProcessTree(child.pid, "SIGTERM");
    setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), supervisorForceKillDelayMs);
    console.error(`${config.name} stopped (${signal || (code ?? 0)}). restarting in 2s...`);
    setTimeout(() => startProcess(config), supervisorExitDelayMs);
  });
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  rmSync(lockPath, { force: true });
  const processIds = Array.from(children.values()).map((child) => child.pid).filter(Boolean);
  for (const pid of processIds) signalProcessTree(pid, "SIGTERM");
  setTimeout(() => {
    for (const pid of processIds) signalProcessTree(pid, "SIGKILL");
  }, supervisorForceKillDelayMs);
  setTimeout(() => process.exit(code), supervisorExitDelayMs);
}

function signalProcessTree(pid, signal) {
  const target = processSignalTarget(pid);
  if (target === null) return;
  try { process.kill(target, signal); } catch { /* already stopped */ }
}

for (const processConfig of processes) startProcess(processConfig);
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("exit", () => rmSync(lockPath, { force: true }));

console.log(
  production
    ? `paper app + worker supervisor started on 127.0.0.1:${appPort} in production mode`
    : `paper app + worker supervisor started on 127.0.0.1:${appPort} in development mode`,
);
