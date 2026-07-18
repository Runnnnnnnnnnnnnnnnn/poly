import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = process.env.GIT_BIN || "/usr/bin/git";
const remote = process.env.POLYMARKET_GIT_REMOTE || "https://github.com/Runnnnnnnnnnnnnnnnn/poly.git";
const branch = process.env.POLYMARKET_LIVE_BRANCH || "live";
const mainBranch = process.env.POLYMARKET_MAIN_BRANCH || "main";

export function publishLiveConnection(value, dashboardSnapshot) {
  if (!dashboardSnapshot) throw new Error("dashboard snapshot is required");
  const apiBase = normalizeApiBase(value);
  const workspace = mkdtempSync(join(tmpdir(), "polymarket-live-"));

  try {
    run(["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", mainBranch, remote, workspace]);
    run(["-C", workspace, "checkout", "-B", branch]);

    run(["-C", workspace, "config", "user.name", "Polymarket Watch Runtime"]);
    run(["-C", workspace, "config", "user.email", "actions@users.noreply.github.com"]);
    writeFileSync(
      join(workspace, "connection.json"),
      `${JSON.stringify({ version: 2, apiBase, publishedAt: new Date().toISOString(), snapshot: "dashboard.json" }, null, 2)}\n`,
      "utf8",
    );
    if (dashboardSnapshot) {
      writeFileSync(join(workspace, "dashboard.json"), `${JSON.stringify(dashboardSnapshot, null, 2)}\n`, "utf8");
    }
    run(["-C", workspace, "add", "connection.json", ...(dashboardSnapshot ? ["dashboard.json"] : [])]);

    const changed = execFileSync(git, ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" }).trim();
    if (!changed) return false;

    run(["-C", workspace, "commit", "--quiet", "-m", "Update live backend connection"]);
    run(["-C", workspace, "push", "--quiet", "--force", "origin", branch]);
    return true;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function normalizeApiBase(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("live API must use HTTPS");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function run(args) {
  execFileSync(git, args, { stdio: "inherit" });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const apiBase = process.argv[2]?.trim();
  if (!apiBase) {
    console.error("Usage: node scripts/publish-live-connection.mjs https://your-tunnel.example.com");
    process.exit(1);
  }
  const port = Number(process.env.APP_PORT || 3001);
  const response = await fetch(`http://127.0.0.1:${port}/api/public-dashboard`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`local dashboard snapshot returned ${response.status}`);
  const dashboardSnapshot = await response.json();
  console.log(publishLiveConnection(apiBase, dashboardSnapshot) ? "live connection published" : "live connection unchanged");
}
