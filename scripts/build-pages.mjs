import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const disabledRoot = join(root, ".pages-build-disabled");
const moves = [
  [join(root, "app", "api"), join(disabledRoot, "app-api")],
  [join(root, "middleware.ts"), join(disabledRoot, "middleware.ts")],
];

function moveExisting(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return true;
}

function restore(moved) {
  for (const [from, to] of moved.reverse()) {
    if (existsSync(to)) {
      mkdirSync(dirname(from), { recursive: true });
      rmSync(from, { recursive: true, force: true });
      renameSync(to, from);
    }
  }
  if (existsSync(disabledRoot)) {
    rmSync(disabledRoot, { recursive: true, force: true });
  }
}

const moved = [];
let exitCode = 0;

process.once("exit", () => restore(moved));
process.once("SIGINT", () => {
  restore(moved);
  process.exit(130);
});
process.once("SIGTERM", () => {
  restore(moved);
  process.exit(143);
});

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function getDevPortsToCheck() {
  const configured = process.env.PAGES_BUILD_DEV_PORTS || process.env.PAGES_BUILD_DEV_PORT || "3000,3001,3002,3003,3004,3005";
  return configured
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

if (!process.env.CI && process.env.ALLOW_PAGES_BUILD_WITH_DEV_SERVER !== "1") {
  const openPorts = [];
  for (const port of getDevPortsToCheck()) {
    if (await isPortOpen(port)) openPorts.push(port);
  }
  if (openPorts.length > 0) {
    console.error(
      `Refusing to run build:pages while local servers are listening on ${openPorts
        .map((port) => `127.0.0.1:${port}`)
        .join(", ")}. Stop the dev server first, or set ALLOW_PAGES_BUILD_WITH_DEV_SERVER=1 if this is intentional.`,
    );
    process.exit(1);
  }
}

try {
  rmSync(disabledRoot, { recursive: true, force: true });
  for (const [from, to] of moves) {
    if (moveExisting(from, to)) moved.push([from, to]);
  }

  const repo = process.env.GITHUB_PAGES_REPO || "poly";
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || "file:./dev.db",
    NEXT_PUBLIC_STATIC_EXPORT: "1",
    GITHUB_PAGES: "true",
    GITHUB_PAGES_REPO: repo,
    NEXT_PUBLIC_BASE_PATH: `/${repo}`,
    SKIP_TITLE_AI: "1",
  };

  const prisma = spawnSync("npx", ["prisma", "generate"], { cwd: root, env, stdio: "inherit" });
  if (prisma.status !== 0) {
    exitCode = prisma.status ?? 1;
    throw new Error("prisma generate failed");
  }

  // AI予想を鍵を使って生成し public/ai-evaluations.json に出力（鍵はサーバー側のみ・非致命）。
  // DEEPSEEK_API_KEY が無ければスクリプト側で参考データにフォールバックする。
  spawnSync("npx", ["tsx", "scripts/gen-ai-snapshot.mts"], { cwd: root, env, stdio: "inherit" });
  spawnSync("npx", ["tsx", "scripts/gen-monitoring-snapshot.mts"], { cwd: root, env, stdio: "inherit" });

  rmSync(join(root, ".next"), { recursive: true, force: true });
  rmSync(join(root, "out"), { recursive: true, force: true });

  const next = spawnSync("npx", ["next", "build"], { cwd: root, env, stdio: "inherit" });
  if (next.status !== 0) {
    exitCode = next.status ?? 1;
    throw new Error("next build failed");
  }
} catch (error) {
  if (exitCode === 0) exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  restore(moved);
}

process.exit(exitCode);
