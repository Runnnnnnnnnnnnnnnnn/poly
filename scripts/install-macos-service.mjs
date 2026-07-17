import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeLabel = "com.polymarket-watch.runtime";
const tunnelLabel = "com.polymarket-watch.tunnel";
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const domain = `gui/${process.getuid()}`;
const userNode = resolve(homedir(), ".nvm/versions/node/v24.14.0/bin/node");
const runtimeNode = process.env.POLYMARKET_RUNTIME_NODE || (existsSync(userNode) ? userNode : process.execPath);
const deployedRoot = resolve(homedir(), ".polymarket-watch/runtime");

if (process.argv.includes("--uninstall")) {
  for (const label of [tunnelLabel, runtimeLabel]) {
    try { execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch {}
    rmSync(resolve(agentsDir, `${label}.plist`), { force: true });
    console.log(`removed ${label}`);
  }
  process.exit(0);
}

buildRuntime();
stageRuntime();
const databaseUrl = `file:${resolve(deployedRoot, "prisma/dev.db")}`;
execFileSync(runtimeNode, [resolve(deployedRoot, "node_modules/prisma/build/index.js"), "db", "push", "--schema", resolve(deployedRoot, "prisma/schema.prisma")], {
  cwd: deployedRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "inherit",
});
const command = `set -a; source ${shellQuote(resolve(deployedRoot, ".env"))}; set +a; cd ${shellQuote(homedir())}; PAPER_PRODUCTION=1 APP_PORT=3001 POLYMARKET_PROJECT_ROOT=${shellQuote(deployedRoot)} DATABASE_URL=${shellQuote(databaseUrl)} ${shellQuote(runtimeNode)} ${shellQuote(resolve(deployedRoot, "scripts/run-all.mjs"))}`;
const runtimePlist = makePlist(runtimeLabel, command, "/tmp/polymarket-watch-runtime.log");

mkdirSync(agentsDir, { recursive: true });
installAgent(runtimeLabel, runtimePlist);

const cloudflared = [
  process.env.CLOUDFLARED_BIN,
  resolve(homedir(), ".local/bin/cloudflared"),
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
].filter(Boolean).find((candidate) => existsSync(candidate));

if (cloudflared) {
  const tunnelCommand = `set -a; source ${shellQuote(resolve(deployedRoot, ".env"))}; set +a; cd ${shellQuote(homedir())}; APP_PORT=3001 CLOUDFLARED_BIN=${shellQuote(cloudflared)} ${shellQuote(runtimeNode)} ${shellQuote(resolve(deployedRoot, "scripts/run-tunnel.mjs"))}`;
  installAgent(tunnelLabel, makePlist(tunnelLabel, tunnelCommand, "/tmp/polymarket-watch-tunnel.log"));
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

function installAgent(label, plist) {
  const plistPath = resolve(agentsDir, `${label}.plist`);
  const service = `${domain}/${label}`;
  writeFileSync(plistPath, plist, "utf8");
  try {
    execFileSync("launchctl", ["bootout", service], { stdio: "ignore" });
    execFileSync("/bin/sleep", ["1"]);
  } catch {}
  execFileSync("launchctl", ["bootstrap", domain, plistPath]);
  console.log(`installed ${label}`);
}

function buildRuntime() {
  const buildEnv = {
    ...process.env,
    DATABASE_URL: `file:${resolve(deployedRoot, "prisma/dev.db")}`,
    SKIP_TITLE_AI: "1",
  };
  delete buildEnv.NEXT_PUBLIC_STATIC_EXPORT;
  delete buildEnv.GITHUB_PAGES;
  delete buildEnv.GITHUB_PAGES_REPO;
  console.log("building the runtime app with API routes");
  execFileSync(runtimeNode, [resolve(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: root,
    env: buildEnv,
    stdio: "inherit",
  });
  if (!existsSync(resolve(root, ".next/server/app/api/health/route.js"))) {
    throw new Error("runtime build is missing API routes; deployment stopped");
  }
}

function stageRuntime() {
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
    "--exclude=node_modules/",
    "--exclude=out/",
    "--exclude=.pages-build-disabled/",
    "--exclude=.run-all.lock",
    "--exclude=.paper-run-id",
    "--exclude=prisma/dev.db",
    `${root}/`,
    `${deployedRoot}/`,
  ], { stdio: "inherit" });

  for (const directory of ["node_modules", ".next"]) {
    const source = resolve(root, directory);
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
    const lockPath = resolve(directory, "pnpm-lock.yaml");
    const lockfile = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
    return createHash("sha256")
      .update(JSON.stringify(dependencyConfig))
      .update("\n")
      .update(lockfile)
      .digest("hex");
  } catch {
    return `unreadable:${directory}`;
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
