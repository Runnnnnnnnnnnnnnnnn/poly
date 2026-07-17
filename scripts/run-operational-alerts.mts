import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";

import { planAlertDeliveries, type AlertDelivery, type AlertState } from "../src/lib/monitoring/alert-state";
import { collectOperationalAlertCandidates } from "../src/lib/monitoring/operational-alerts";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = boundedNumber(process.env.ALERT_CHECK_INTERVAL_MS, 60_000, 60_000, 60 * 60 * 1_000);
const reminderIntervalMs = boundedNumber(process.env.ALERT_REMINDER_INTERVAL_MS, 6 * 60 * 60 * 1_000, 15 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000);
const stateDir = resolve(homedir(), ".polymarket-watch");
const statePath = process.env.ALERT_STATE_PATH || resolve(stateDir, "alert-state.json");
const logPath = process.env.ALERT_LOG_PATH || resolve(stateDir, "alerts.ndjson");
const once = process.argv.includes("--once");
let checking = false;

mkdirSync(stateDir, { recursive: true });

async function checkAlerts() {
  if (checking) return;
  checking = true;
  await markPipelineAttempt("operational-alerts", "異常を確認中");
  try {
    const now = new Date();
    const candidates = await collectOperationalAlertCandidates(now);
    const { deliveries, next } = planAlertDeliveries(candidates, readState(), now, reminderIntervalMs);
    for (const delivery of deliveries) await deliver(delivery, now);
    writeState(next);
    await markPipelineSuccess(
      "operational-alerts",
      deliveries.length,
      candidates.length ? `異常${candidates.length}件を監視中` : "異常なし",
    );
    console.log(JSON.stringify({ type: "operational-alerts", active: candidates.length, delivered: deliveries.length, checkedAt: now.toISOString() }));
  } catch (error) {
    await markPipelineError("operational-alerts", error);
    console.error(error instanceof Error ? error.message : error);
  } finally {
    checking = false;
  }
}

async function deliver(alert: AlertDelivery, now: Date) {
  const prefix = alert.event === "recovered" ? "復旧" : alert.severity === "critical" ? "重要" : "注意";
  const entry = { ...alert, deliveredAt: now.toISOString() };
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(logPath, 0o600);
  console.log(JSON.stringify({ type: "operational-alert", ...entry }));
  if (process.env.ALERT_DRY_RUN === "1") return;
  notifyMac(`Polymarket Watch - ${prefix}`, `${alert.title}: ${alert.message}`);
  await notifyWebhook(alert).catch((error) => console.error(`alert webhook failed: ${error instanceof Error ? error.message : error}`));
}

function notifyMac(title: string, message: string) {
  if (process.platform !== "darwin" || process.env.ALERT_MAC_NOTIFICATIONS === "0") return;
  execFile("/usr/bin/osascript", [
    "-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e", "end run",
    title,
    message,
  ], (error) => {
    if (error) console.error(`macOS notification failed: ${error.message}`);
  });
}

async function notifyWebhook(alert: AlertDelivery) {
  const configured = process.env.POLYMARKET_ALERT_WEBHOOK_URL?.trim();
  if (!configured) return;
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new Error("alert webhook must use HTTPS");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `[Polymarket Watch] ${alert.title}\n${alert.message}`,
      source: "polymarket-watch",
      event: alert.event,
      severity: alert.severity,
      key: alert.key,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`webhook returned ${response.status}`);
}

function readState(): AlertState {
  if (!existsSync(statePath)) return {};
  try { return JSON.parse(readFileSync(statePath, "utf8")) as AlertState; } catch { return {}; }
}

function writeState(state: AlertState) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(statePath, 0o600);
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

await checkAlerts();
if (!once) {
  setInterval(() => void checkAlerts(), intervalMs);
  console.log(`operational alert worker: every ${intervalMs}ms / reminder ${reminderIntervalMs}ms`);
}
