import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let exitCode = 0;

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

const buildRoot = mkdtempSync(join(tmpdir(), "polymarket-watch-pages-"));

try {
  const repo = process.env.GITHUB_PAGES_REPO || "poly";
  const postgresUrlPath = join(homedir(), ".polymarket-watch", "postgres", "database-url");
  const pagesDatabaseUrl = process.env.PAGES_DATABASE_URL
    || process.env.DATABASE_URL
    || (existsSync(postgresUrlPath)
      ? readFileSync(postgresUrlPath, "utf8").trim()
      : "postgresql://postgres:postgres@127.0.0.1:5432/polymarket_watch?schema=public");
  const env = {
    ...process.env,
    DATABASE_URL: pagesDatabaseUrl,
    NEXT_PUBLIC_STATIC_EXPORT: "1",
    GITHUB_PAGES: "true",
    GITHUB_PAGES_REPO: repo,
    NEXT_PUBLIC_BASE_PATH: `/${repo}`,
    SKIP_TITLE_AI: "1",
  };

  const prisma = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "generate"], { cwd: root, env, stdio: "inherit" });
  if (prisma.status !== 0) {
    exitCode = prisma.status ?? 1;
    throw new Error("prisma generate failed");
  }

  // AI予想を鍵を使って生成し public/ai-evaluations.json に出力（鍵はサーバー側のみ・非致命）。
  // DEEPSEEK_API_KEY が無ければスクリプト側で参考データにフォールバックする。
  spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/gen-ai-snapshot.mts"], { cwd: root, env, stdio: "inherit" });
  // CI only has the small repository fixture DB. Keep the runtime snapshot committed by the collector.
  if (!process.env.CI) {
    const monitoring = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/gen-monitoring-snapshot.mts"], { cwd: root, env, stdio: "inherit" });
    if (monitoring.status !== 0) {
      exitCode = monitoring.status ?? 1;
      throw new Error("monitoring snapshot generation failed");
    }
  }

  prepareBuildSource(buildRoot);

  const next = spawnSync(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "build"], { cwd: buildRoot, env, stdio: "inherit" });
  if (next.status !== 0) {
    exitCode = next.status ?? 1;
    throw new Error("next build failed");
  }
  if (process.env.PAGES_SKIP_OUTPUT_SYNC === "1") {
    console.log("Pages build verified in the isolated workspace; output sync skipped");
  } else {
    publishBuildOutput(join(buildRoot, "out"));
  }
} catch (error) {
  if (exitCode === 0) exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}

process.exit(exitCode);

function prepareBuildSource(target) {
  execFileSync("/usr/bin/rsync", [
    "-a",
    "--delete",
    "--exclude=.git/",
    "--exclude=.next/",
    "--exclude=node_modules/",
    "--exclude=out/",
    "--exclude=.pages-build-disabled/",
    "--exclude=.run-all.lock",
    "--exclude=.paper-run-id",
    "--exclude=prisma/dev.db*",
    `${root}/`,
    `${target}/`,
  ], { stdio: "inherit" });
  rmSync(join(target, "app", "api"), { recursive: true, force: true });
  rmSync(join(target, "middleware.ts"), { force: true });
  symlinkSync(join(root, "node_modules"), join(target, "node_modules"), "dir");
}

function publishBuildOutput(source) {
  const target = join(root, "out");
  mkdirSync(target, { recursive: true });
  execFileSync("/usr/bin/rsync", ["-a", "--delete", `${source}/`, `${target}/`], { stdio: "inherit" });
}
