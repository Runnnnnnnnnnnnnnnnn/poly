import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { publishLiveConnection } from "./publish-live-connection.mjs";
import { checkPublicHealth } from "./public-health.mjs";
import { quickTunnelConfig, resolveTunnelConfig } from "./tunnel-config.mjs";
import { decideTunnelRecovery } from "./tunnel-health-policy.mjs";

const candidates = [
  process.env.CLOUDFLARED_BIN,
  resolve(homedir(), ".local/bin/cloudflared"),
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
].filter(Boolean);
const binary = candidates.find((candidate) => existsSync(candidate));
const port = process.env.APP_PORT || "3001";
const stateDir = resolve(homedir(), ".polymarket-watch");
const stateFile = resolve(stateDir, "live-url");
const statusFile = resolve(stateDir, "tunnel-status.json");
const preferredConfig = resolveTunnelConfig(process.env, port);
const healthIntervalMs = numericSetting(process.env.TUNNEL_HEALTH_INTERVAL_MS, 60_000, 30_000);
const healthFailureThreshold = Math.floor(numericSetting(process.env.TUNNEL_HEALTH_FAILURE_THRESHOLD, 3, 2));
let activeConfig = preferredConfig;
let child;
let buffer = "";
let latestUrl = preferredConfig.publicUrl;
let publishing = false;
let retryTimer;
let healthTimer;
let closing = false;
let fellBack = false;
let healthFailures = 0;
let requestedConfig = null;
let publishedAt = null;
let lastCheckedAt = null;

if (!binary) {
  console.error("cloudflared is not installed");
  process.exit(1);
}

startTunnel(preferredConfig);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function startTunnel(config) {
  activeConfig = config;
  buffer = "";
  latestUrl = config.publicUrl;
  healthFailures = 0;
  publishedAt = null;
  lastCheckedAt = null;
  writeStatus("starting");
  child = spawn(binary, config.args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);
  child.on("exit", (code, signal) => {
    clearTimers();
    if (closing) return;
    if (requestedConfig) {
      const nextConfig = requestedConfig;
      requestedConfig = null;
      setTimeout(() => startTunnel(nextConfig), 2_000);
      return;
    }
    console.error(`cloudflared ${config.mode} stopped (${signal || (code ?? 0)})`);
    if (config.mode !== "quick" && config.allowQuickFallback && !fellBack) {
      fellBack = true;
      console.error("named tunnel unavailable; falling back to a quick tunnel");
      setTimeout(() => startTunnel(quickTunnelConfig(port)), 2_000);
      return;
    }
    process.exit(code || 1);
  });
  console.log(`cloudflared started in ${config.mode} mode`);
  if (latestUrl) void publishWhenReady();
}

function handleChunk(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  if (activeConfig.mode !== "quick") return;
  buffer = `${buffer}${text}`.slice(-8_000);
  const matches = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  const detected = matches?.at(-1);
  if (!detected || detected === latestUrl) return;
  latestUrl = detected;
  void publishWhenReady();
}

async function publishWhenReady() {
  if (publishing || !latestUrl) return;
  publishing = true;
  try {
    await verifyEndpoints();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, `${latestUrl}\n`, "utf8");
    publishLiveConnection(latestUrl);
    healthFailures = 0;
    publishedAt = new Date().toISOString();
    lastCheckedAt = publishedAt;
    writeStatus("healthy");
    console.log(`live backend connection published (${activeConfig.mode})`);
    scheduleHealthCheck();
  } catch (error) {
    lastCheckedAt = new Date().toISOString();
    if (!handleHealthFailure(error, "publish")) schedulePublishRetry();
  } finally {
    publishing = false;
  }
}

async function monitorPublishedHealth() {
  healthTimer = undefined;
  if (closing || !latestUrl) return;
  if (publishing) {
    scheduleHealthCheck(5_000);
    return;
  }
  publishing = true;
  try {
    await verifyEndpoints();
    const recovered = healthFailures > 0;
    healthFailures = 0;
    lastCheckedAt = new Date().toISOString();
    writeStatus("healthy");
    if (recovered) console.log("live backend connection recovered");
    scheduleHealthCheck();
  } catch (error) {
    lastCheckedAt = new Date().toISOString();
    if (!handleHealthFailure(error, "monitor")) scheduleHealthCheck(15_000);
  } finally {
    publishing = false;
  }
}

async function verifyEndpoints() {
  const [localResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
    checkPublicHealth(latestUrl),
  ]);
  if (!localResponse.ok) throw new Error(`local health check returned ${localResponse.status}`);
}

function handleHealthFailure(error, source) {
  healthFailures += 1;
  writeStatus("waiting");
  console.error(`live connection ${source} failed (${healthFailures}/${healthFailureThreshold}): ${error instanceof Error ? error.message : error}`);
  const action = decideTunnelRecovery(activeConfig, healthFailures, healthFailureThreshold);
  if (action === "fallback-quick") {
    fellBack = true;
    console.error("named tunnel health check failed repeatedly; falling back to a quick tunnel");
    switchTunnel(quickTunnelConfig(port));
    return true;
  }
  if (action === "restart-quick") {
    console.error("quick tunnel health check failed repeatedly; requesting a new URL");
    switchTunnel(quickTunnelConfig(port));
    return true;
  }
  return false;
}

function schedulePublishRetry() {
  if (closing || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void publishWhenReady();
  }, 15_000);
}

function scheduleHealthCheck(delayMs = healthIntervalMs) {
  if (closing || healthTimer) return;
  healthTimer = setTimeout(() => void monitorPublishedHealth(), delayMs);
}

function switchTunnel(config) {
  clearTimers();
  requestedConfig = config;
  writeStatus("restarting");
  child?.kill("SIGTERM");
}

function writeStatus(status) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statusFile, `${JSON.stringify({
    mode: activeConfig.mode,
    status,
    publicUrl: latestUrl || null,
    fixedUrl: activeConfig.mode !== "quick",
    fallback: fellBack,
    publishedAt,
    lastCheckedAt,
    consecutiveFailures: healthFailures,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

function shutdown() {
  closing = true;
  clearTimers();
  child?.kill("SIGTERM");
}

function clearTimers() {
  if (retryTimer) clearTimeout(retryTimer);
  if (healthTimer) clearTimeout(healthTimer);
  retryTimer = undefined;
  healthTimer = undefined;
}

function numericSetting(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(minimum, parsed) : fallback;
}
