import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { publishLiveConnection } from "./publish-live-connection.mjs";
import { checkPublicHealth } from "./public-health.mjs";
import { quickTunnelConfig, resolveTunnelConfig } from "./tunnel-config.mjs";

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
let activeConfig = preferredConfig;
let child;
let buffer = "";
let latestUrl = preferredConfig.publicUrl;
let publishing = false;
let retryTimer;
let closing = false;
let fellBack = false;
let healthFailures = 0;
let requestedConfig = null;

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
  writeStatus("starting");
  child = spawn(binary, config.args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);
  child.on("exit", (code, signal) => {
    if (retryTimer) clearTimeout(retryTimer);
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
    const [localResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
      checkPublicHealth(latestUrl),
    ]);
    if (!localResponse.ok) throw new Error(`local health check returned ${localResponse.status}`);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, `${latestUrl}\n`, "utf8");
    publishLiveConnection(latestUrl);
    healthFailures = 0;
    writeStatus("healthy", new Date().toISOString());
    console.log(`live backend connection published (${activeConfig.mode})`);
  } catch (error) {
    healthFailures += 1;
    writeStatus("waiting");
    console.error(`live connection publish failed: ${error instanceof Error ? error.message : error}`);
    if (healthFailures >= 4) {
      if (activeConfig.mode !== "quick" && activeConfig.allowQuickFallback) {
        fellBack = true;
        console.error("named tunnel health check failed repeatedly; falling back to a quick tunnel");
        switchTunnel(quickTunnelConfig(port));
        return;
      }
      if (activeConfig.mode === "quick") {
        console.error("quick tunnel health check failed repeatedly; requesting a new URL");
        switchTunnel(quickTunnelConfig(port));
        return;
      }
    }
    retryTimer = setTimeout(() => void publishWhenReady(), 15_000);
  } finally {
    publishing = false;
  }
}

function switchTunnel(config) {
  if (retryTimer) clearTimeout(retryTimer);
  requestedConfig = config;
  writeStatus("restarting");
  child?.kill("SIGTERM");
}

function writeStatus(status, publishedAt = null) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statusFile, `${JSON.stringify({
    mode: activeConfig.mode,
    status,
    publicUrl: latestUrl || null,
    fixedUrl: activeConfig.mode !== "quick",
    fallback: fellBack,
    publishedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

function shutdown() {
  closing = true;
  if (retryTimer) clearTimeout(retryTimer);
  child?.kill("SIGTERM");
}
