import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimeDatabaseRsyncExcludes, untrackedRuntimeSourceRsyncExcludes } from "./runtime-deployment-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeLabel = "com.polymarket-watch.runtime";
const tunnelLabel = "com.polymarket-watch.tunnel";
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const domain = `gui/${process.getuid()}`;
const runtimeNode = [
  process.env.POLYMARKET_RUNTIME_NODE,
  resolve(homedir(), ".nvm/versions/node/v22.22.2/bin/node"),
  resolve(homedir(), ".nvm/versions/node/v20.20.2/bin/node"),
  process.execPath,
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!runtimeNode) throw new Error("Node.js runtime was not found");
const deployedRoot = resolve(homedir(), ".polymarket-watch/runtime");

if (process.argv.includes("--uninstall")) {
  for (const label of [tunnelLabel, runtimeLabel]) {
    try { execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch {}
    rmSync(resolve(agentsDir, `${label}.plist`), { force: true });
    console.log(`removed ${label}`);
  }
  process.exit(0);
}

const modelRevision = fileFingerprint([
  "src/lib/model-evaluation/engine.ts",
  "src/lib/model-evaluation/combined-trading.ts",
  "src/lib/model-evaluation/price-structure.ts",
  "src/lib/model-evaluation/probability-ladder.ts",
  "src/lib/model-evaluation/synchronized-execution.ts",
  "src/lib/model-evaluation/realtime-short-term-replay.ts",
  "src/lib/model-evaluation/service.ts",
  "src/lib/combined-trading/forward-evaluation.ts",
  "scripts/backtest-realtime-short-term.mts",
  "scripts/realtime-short-term-schedule.mjs",
  "scripts/run-realtime-short-term-research.mts",
]);
const runtimeDatabasePath = resolve(deployedRoot, "prisma/dev.db");
const buildSnapshotDirectory = mkdtempSync(resolve(tmpdir(), "polymarket-watch-build-"));
const buildDatabasePath = resolve(buildSnapshotDirectory, "dev.db");
const buildSourceDirectory = mkdtempSync(resolve(tmpdir(), "polymarket-watch-source-"));
try {
  prepareBuildSource(buildSourceDirectory);
  prepareBuildDatabase(runtimeDatabasePath, buildDatabasePath);
  buildRuntime(modelRevision, buildDatabasePath, buildSourceDirectory);
  rmSync(resolve(buildSourceDirectory, "node_modules"), { force: true });
} catch (error) {
  rmSync(buildSourceDirectory, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(buildSnapshotDirectory, { recursive: true, force: true });
}
const databaseUrl = `file:${runtimeDatabasePath}`;
const command = `set -a; source ${shellQuote(resolve(deployedRoot, ".env"))}; set +a; cd ${shellQuote(homedir())}; PAPER_PRODUCTION=1 APP_PORT=3001 POLYMARKET_PROJECT_ROOT=${shellQuote(deployedRoot)} POLYMARKET_MODEL_REVISION=${shellQuote(modelRevision)} DATABASE_URL=${shellQuote(databaseUrl)} exec ${shellQuote(runtimeNode)} ${shellQuote(resolve(deployedRoot, "scripts/run-all.mjs"))}`;
const runtimePlist = makePlist(runtimeLabel, command, "/tmp/polymarket-watch-runtime.log");

mkdirSync(agentsDir, { recursive: true });
const runtimePlistPath = resolve(agentsDir, `${runtimeLabel}.plist`);
const previousRuntimePlist = existsSync(runtimePlistPath) ? readFileSync(runtimePlistPath, "utf8") : null;
const runtimeWasLoaded = agentIsLoaded(`${domain}/${runtimeLabel}`);
try {
  stopAgent(runtimeLabel);
  waitForDatabaseRelease(runtimeDatabasePath);
  stageRuntime(buildSourceDirectory);
  assertSqliteIntegrity(runtimeDatabasePath);
  execFileSync(runtimeNode, [resolve(deployedRoot, "node_modules/prisma/build/index.js"), "db", "push", "--schema", resolve(deployedRoot, "prisma/schema.prisma")], {
    cwd: deployedRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  configureSqliteDatabase(runtimeDatabasePath);
  assertSqliteIntegrity(runtimeDatabasePath);
  installAgent(runtimeLabel, runtimePlist);
} catch (error) {
  restartPreviousAgent(runtimeLabel, previousRuntimePlist, runtimeWasLoaded);
  throw error;
} finally {
  rmSync(buildSourceDirectory, { recursive: true, force: true });
}

const cloudflared = [
  process.env.CLOUDFLARED_BIN,
  resolve(homedir(), ".local/bin/cloudflared"),
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
].filter(Boolean).find((candidate) => existsSync(candidate));

if (cloudflared) {
  const tunnelRevision = fileFingerprint([
    "scripts/run-tunnel.mjs",
    "scripts/publish-live-connection.mjs",
    "scripts/public-health.mjs",
    "scripts/tunnel-config.mjs",
    "scripts/tunnel-health-policy.mjs",
    "scripts/live-snapshot-policy.mjs",
  ]);
  const tunnelCommand = `set -a; source ${shellQuote(resolve(deployedRoot, ".env"))}; set +a; cd ${shellQuote(homedir())}; APP_PORT=3001 POLYMARKET_TUNNEL_REVISION=${shellQuote(tunnelRevision)} CLOUDFLARED_BIN=${shellQuote(cloudflared)} ${shellQuote(runtimeNode)} ${shellQuote(resolve(deployedRoot, "scripts/run-tunnel.mjs"))}`;
  installAgent(tunnelLabel, makePlist(tunnelLabel, tunnelCommand, "/tmp/polymarket-watch-tunnel.log"), { preserveIfUnchanged: true });
} else {
  console.warn("cloudflared was not found; the local runtime is installed without public tunneling");
}

function makePlist(label, serviceCommand, logPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xmlEscape(serviceCommand)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEscape(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function installAgent(label, plist, options = {}) {
  const plistPath = resolve(agentsDir, `${label}.plist`);
  const service = `${domain}/${label}`;
  const unchanged = existsSync(plistPath) && readFileSync(plistPath, "utf8") === plist;
  if (options.preserveIfUnchanged && unchanged && agentIsLoaded(service)) {
    console.log(`kept ${label} running`);
    return;
  }
  writeFileSync(plistPath, plist, "utf8");
  try { execFileSync("launchctl", ["bootout", service], { stdio: "ignore" }); } catch {}
  execFileSync("/bin/sleep", ["1"]);
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: attempt === 5 ? "inherit" : "ignore" });
      console.log(`installed ${label}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) execFileSync("/bin/sleep", [String(attempt * 2)]);
    }
  }
  throw lastError;
}

function agentIsLoaded(service) {
  try {
    execFileSync("launchctl", ["print", service], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function prepareBuildSource(target) {
  const untracked = execFileSync("/usr/bin/git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const untrackedExcludes = untrackedRuntimeSourceRsyncExcludes(untracked);
  execFileSync("/usr/bin/rsync", [
    "-a",
    "--exclude=.git/",
    "--exclude=.next/",
    "--exclude=node_modules",
    "--exclude=out/",
    "--exclude=.pages-build-disabled/",
    "--exclude=.run-all.lock",
    "--exclude=.paper-run-id",
    ...runtimeDatabaseRsyncExcludes,
    ...untrackedExcludes,
    `${root}/`,
    `${target}/`,
  ], { stdio: "inherit" });
  symlinkSync(resolve(root, "node_modules"), resolve(target, "node_modules"), "dir");
  if (untracked.length) console.log(`excluded ${untracked.length} untracked source file(s) from runtime deployment`);
}

function buildRuntime(revision, buildDatabasePath, sourceRoot) {
  const buildEnv = {
    ...process.env,
    DATABASE_URL: `file:${buildDatabasePath}`,
    SKIP_TITLE_AI: "1",
    POLYMARKET_MODEL_REVISION: revision,
  };
  delete buildEnv.NEXT_PUBLIC_STATIC_EXPORT;
  delete buildEnv.GITHUB_PAGES;
  delete buildEnv.GITHUB_PAGES_REPO;
  console.log("building the runtime app with API routes");
  rmSync(resolve(sourceRoot, ".next"), { recursive: true, force: true });
  execFileSync(runtimeNode, [resolve(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: sourceRoot,
    env: buildEnv,
    stdio: "inherit",
  });
  if (!existsSync(resolve(sourceRoot, ".next/server/app/api/health/route.js"))) {
    throw new Error("runtime build is missing API routes; deployment stopped");
  }
}

function stageRuntime(sourceRoot) {
  mkdirSync(deployedRoot, { recursive: true });
  const dependencyMarker = resolve(deployedRoot, "node_modules/.polymarket-runtime-dependencies");
  const sourceDependencyFingerprint = dependencyFingerprint(root);
  const dependenciesChanged = !existsSync(dependencyMarker)
    || readFileSync(dependencyMarker, "utf8") !== sourceDependencyFingerprint;
  execFileSync("/usr/bin/rsync", [
    "-a",
    "--delete",
    "--exclude=.git/",
    "--exclude=.next/",
    "--exclude=node_modules",
    "--exclude=out/",
    "--exclude=.pages-build-disabled/",
    "--exclude=.run-all.lock",
    "--exclude=.paper-run-id",
    ...runtimeDatabaseRsyncExcludes,
    `${sourceRoot}/`,
    `${deployedRoot}/`,
  ], { stdio: "inherit" });

  for (const directory of ["node_modules", ".next"]) {
    const source = resolve(directory === "node_modules" ? root : sourceRoot, directory);
    const target = resolve(deployedRoot, directory);
    if (directory === "node_modules" && !dependenciesChanged && existsSync(resolve(target, "next/package.json"))) continue;
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const excludes = directory === ".next"
      ? ["--exclude=cache/", "--exclude=* [0-9]*"]
      : ["--exclude=* [0-9]*"];
    execFileSync("/usr/bin/rsync", [
      "-a",
      "--delete",
      "--delete-excluded",
      ...excludes,
      `${source}/`,
      `${target}/`,
    ], { stdio: "inherit" });
    if (directory === "node_modules") {
      writeFileSync(resolve(target, ".polymarket-runtime-dependencies"), sourceDependencyFingerprint, "utf8");
    }
  }

  const runtimeDatabase = resolve(deployedRoot, "prisma/dev.db");
  if (!existsSync(runtimeDatabase)) copyFileSync(resolve(root, "prisma/dev.db"), runtimeDatabase);
}

function prepareBuildDatabase(sourcePath, targetPath) {
  if (!existsSync(sourcePath)) {
    copyFileSync(resolve(root, "prisma/dev.db"), targetPath);
    assertSqliteIntegrity(targetPath);
    return;
  }
  if (!existsSync("/usr/bin/sqlite3")) {
    throw new Error("sqlite3 is required to create a consistent runtime build snapshot");
  }
  execFileSync("/usr/bin/sqlite3", [
    sourcePath,
    ".timeout 10000",
    `.backup '${targetPath.replaceAll("'", "''")}'`,
  ], { stdio: "inherit" });
  assertSqliteIntegrity(targetPath);
  console.log("created an integrity-checked build snapshot of the runtime database");
}

function stopAgent(label) {
  const service = `${domain}/${label}`;
  try { execFileSync("launchctl", ["bootout", service], { stdio: "ignore" }); } catch {}
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!agentIsLoaded(service)) return;
    execFileSync("/bin/sleep", ["0.25"]);
  }
  throw new Error(`timed out stopping ${label}`);
}

function waitForDatabaseRelease(path) {
  if (!existsSync("/usr/sbin/lsof")) return;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const holders = execFileSync("/usr/sbin/lsof", ["-t", "--", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!holders) return;
    } catch {
      return;
    }
    execFileSync("/bin/sleep", ["0.25"]);
  }
  throw new Error("runtime database is still open after the service stopped");
}

function restartPreviousAgent(label, previousPlist, wasLoaded) {
  if (!previousPlist || !wasLoaded) return;
  const plistPath = resolve(agentsDir, `${label}.plist`);
  try {
    if (agentIsLoaded(`${domain}/${label}`)) return;
    writeFileSync(plistPath, previousPlist, "utf8");
    execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
    console.warn(`restored ${label} after deployment failure`);
  } catch (restartError) {
    console.error(`failed to restore ${label}: ${restartError instanceof Error ? restartError.message : restartError}`);
  }
}

function dependencyFingerprint(directory) {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    const dependencyConfig = {
      dependencies: packageJson.dependencies ?? {},
      devDependencies: packageJson.devDependencies ?? {},
      optionalDependencies: packageJson.optionalDependencies ?? {},
      peerDependencies: packageJson.peerDependencies ?? {},
      overrides: packageJson.overrides ?? {},
      packageManager: packageJson.packageManager ?? null,
    };
    const lockPath = ["pnpm-lock.yaml", "package-lock.json"]
      .map((name) => resolve(directory, name))
      .find((candidate) => existsSync(candidate));
    const lockfile = lockPath ? readFileSync(lockPath, "utf8") : "";
    return createHash("sha256")
      .update(JSON.stringify(dependencyConfig))
      .update("\n")
      .update(lockfile)
      .digest("hex");
  } catch {
    return `unreadable:${directory}`;
  }
}

function configureSqliteDatabase(path) {
  if (!existsSync("/usr/bin/sqlite3")) return;
  const mode = execFileSync("/usr/bin/sqlite3", [path, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;"], {
    encoding: "utf8",
  }).trim().split(/\s+/)[0];
  if (mode.toLowerCase() !== "wal") throw new Error(`failed to enable SQLite WAL mode: ${mode || "empty response"}`);
  console.log("configured runtime SQLite database in WAL mode");
}

function assertSqliteIntegrity(path) {
  if (!existsSync("/usr/bin/sqlite3")) return;
  const result = execFileSync("/usr/bin/sqlite3", [path, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
  if (result !== "ok") throw new Error(`SQLite integrity check failed: ${result.slice(0, 300)}`);
}

function fileFingerprint(paths) {
  const hash = createHash("sha256");
  for (const path of paths) hash.update(readFileSync(resolve(root, path)));
  return hash.digest("hex").slice(0, 16);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
