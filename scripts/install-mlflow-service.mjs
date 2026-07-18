import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const label = "com.polymarket-watch.mlflow";
const domain = `gui/${process.getuid()}`;
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const plistPath = resolve(agentsDir, `${label}.plist`);
const dataRoot = resolve(homedir(), ".polymarket-watch");
const runtimeRoot = resolve(dataRoot, "runtime");
const sourceRoot = resolve(import.meta.dirname, "..");
const root = existsSync(resolve(runtimeRoot, "scripts/run-mlflow-service.mjs")) ? runtimeRoot : sourceRoot;
const runner = resolve(root, "scripts/run-mlflow-service.mjs");
const python = process.env.MLFLOW_PYTHON_BIN || resolve(dataRoot, "mlflow-venv/bin/python");
const mlflow = process.env.MLFLOW_BIN || resolve(dataRoot, "mlflow-venv/bin/mlflow");
const node = process.env.POLYMARKET_RUNTIME_NODE || process.execPath;
const port = process.env.MLFLOW_PORT || "8080";
const importIntervalMs = process.env.MLFLOW_IMPORT_INTERVAL_MS || String(30 * 60_000);

if (process.argv.includes("--uninstall")) {
  try { execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch {}
  rmSync(plistPath, { force: true });
  console.log(`removed ${label}`);
  process.exit(0);
}

for (const path of [runner, python, mlflow, node]) {
  if (!existsSync(path)) throw new Error(`MLflow service dependency is missing: ${path}`);
}

const command = `POLYMARKET_PROJECT_ROOT=${shellQuote(root)} MLFLOW_PYTHON_BIN=${shellQuote(python)} MLFLOW_BIN=${shellQuote(mlflow)} MLFLOW_PORT=${shellQuote(port)} MLFLOW_IMPORT_INTERVAL_MS=${shellQuote(importIntervalMs)} ${shellQuote(node)} ${shellQuote(runner)}`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xmlEscape(command)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEscape(dataRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/polymarket-watch-mlflow.log</string>
  <key>StandardErrorPath</key><string>/tmp/polymarket-watch-mlflow.log</string>
</dict>
</plist>
`;

mkdirSync(agentsDir, { recursive: true });
const unchanged = existsSync(plistPath) && readFileSync(plistPath, "utf8") === plist;
if (!unchanged) writeFileSync(plistPath, plist, "utf8");
try { execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch {}
execFileSync("/bin/sleep", ["1"]);
execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
console.log(`installed ${label} on http://127.0.0.1:${port}`);

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
