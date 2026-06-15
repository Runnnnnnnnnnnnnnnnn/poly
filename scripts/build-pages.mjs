import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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
      renameSync(to, from);
    }
  }
  if (existsSync(disabledRoot)) {
    rmSync(disabledRoot, { recursive: true, force: true });
  }
}

const moved = [];
let exitCode = 0;

try {
  rmSync(disabledRoot, { recursive: true, force: true });
  for (const [from, to] of moves) {
    if (moveExisting(from, to)) moved.push([from, to]);
  }

  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || "file:./dev.db",
    NEXT_PUBLIC_STATIC_EXPORT: "1",
    GITHUB_PAGES: "true",
    GITHUB_PAGES_REPO: process.env.GITHUB_PAGES_REPO || "poly",
  };

  const prisma = spawnSync("npx", ["prisma", "generate"], { cwd: root, env, stdio: "inherit" });
  if (prisma.status !== 0) {
    exitCode = prisma.status ?? 1;
    throw new Error("prisma generate failed");
  }

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
