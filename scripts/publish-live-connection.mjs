import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const git = process.env.GIT_BIN || "/usr/bin/git";
const remote = process.env.POLYMARKET_GIT_REMOTE || "https://github.com/Runnnnnnnnnnnnnnnnn/poly.git";
const branch = process.env.POLYMARKET_LIVE_BRANCH || "live";

export function publishLiveConnection(value) {
  const apiBase = normalizeApiBase(value);
  const workspace = mkdtempSync(join(tmpdir(), "polymarket-live-"));

  try {
    const branchExists = spawnSync(git, ["ls-remote", "--exit-code", "--heads", remote, branch], {
      stdio: "ignore",
    }).status === 0;

    if (branchExists) {
      run(["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", branch, remote, workspace]);
    } else {
      run(["init", "--quiet", workspace]);
      run(["-C", workspace, "checkout", "-b", branch]);
      run(["-C", workspace, "remote", "add", "origin", remote]);
    }

    run(["-C", workspace, "config", "user.name", "Polymarket Watch Runtime"]);
    run(["-C", workspace, "config", "user.email", "actions@users.noreply.github.com"]);
    writeFileSync(
      join(workspace, "connection.json"),
      `${JSON.stringify({ version: 1, apiBase, publishedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    run(["-C", workspace, "add", "connection.json"]);

    const changed = execFileSync(git, ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" }).trim();
    if (!changed) return false;

    run(["-C", workspace, "commit", "--quiet", "-m", "Update live backend connection"]);
    run(["-C", workspace, "push", "--quiet", "origin", branch]);
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
  console.log(publishLiveConnection(apiBase) ? "live connection published" : "live connection unchanged");
}
