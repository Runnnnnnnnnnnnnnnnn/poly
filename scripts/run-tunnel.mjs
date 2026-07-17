import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { publishLiveConnection } from "./publish-live-connection.mjs";

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

if (!binary) {
  console.error("cloudflared is not installed");
  process.exit(1);
}

const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
let buffer = "";
let latestUrl = "";
let publishing = false;
let retryTimer;

child.stdout.on("data", handleChunk);
child.stderr.on("data", handleChunk);
child.on("exit", (code, signal) => {
  if (retryTimer) clearTimeout(retryTimer);
  console.error(`cloudflared stopped (${signal || (code ?? 0)})`);
  process.exit(code || 1);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function handleChunk(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
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
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`health check returned ${response.status}`);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, `${latestUrl}\n`, "utf8");
    publishLiveConnection(latestUrl);
    console.log("live backend connection published");
  } catch (error) {
    console.error(`live connection publish failed: ${error instanceof Error ? error.message : error}`);
    retryTimer = setTimeout(() => void publishWhenReady(), 15_000);
  } finally {
    publishing = false;
  }
}

function shutdown() {
  if (retryTimer) clearTimeout(retryTimer);
  child.kill("SIGTERM");
}
