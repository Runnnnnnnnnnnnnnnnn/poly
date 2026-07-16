import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "com.polymarket-watch.runtime";
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const plistPath = resolve(agentsDir, `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const userNode = resolve(homedir(), ".nvm/versions/node/v24.14.0/bin/node");
const runtimeNode = process.env.POLYMARKET_RUNTIME_NODE || (existsSync(userNode) ? userNode : process.execPath);
const deployedRoot = resolve(homedir(), ".polymarket-watch/runtime");

if (process.argv.includes("--uninstall")) {
  try { execFileSync("launchctl", ["bootout", service], { stdio: "ignore" }); } catch {}
  rmSync(plistPath, { force: true });
  console.log(`removed ${label}`);
  process.exit(0);
}

stageRuntime();
const databaseUrl = `file:${resolve(deployedRoot, "prisma/dev.db")}`;
execFileSync(runtimeNode, [resolve(deployedRoot, "node_modules/prisma/build/index.js"), "db", "push", "--schema", resolve(deployedRoot, "prisma/schema.prisma")], {
  cwd: deployedRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "inherit",
});
const command = `set -a; source ${shellQuote(resolve(deployedRoot, ".env"))}; set +a; cd ${shellQuote(homedir())}; PAPER_PRODUCTION=1 APP_PORT=3001 POLYMARKET_PROJECT_ROOT=${shellQuote(deployedRoot)} DATABASE_URL=${shellQuote(databaseUrl)} ${shellQuote(runtimeNode)} ${shellQuote(resolve(deployedRoot, "scripts/run-all.mjs"))}`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xmlEscape(command)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEscape(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/polymarket-watch-runtime.log</string>
  <key>StandardErrorPath</key><string>/tmp/polymarket-watch-runtime.log</string>
</dict>
</plist>
`;

mkdirSync(agentsDir, { recursive: true });
writeFileSync(plistPath, plist, "utf8");
try {
  execFileSync("launchctl", ["bootout", service], { stdio: "ignore" });
  execFileSync("/bin/sleep", ["1"]);
} catch {}
execFileSync("launchctl", ["bootstrap", domain, plistPath]);
console.log(`installed ${label}`);

function stageRuntime() {
  mkdirSync(deployedRoot, { recursive: true });
  const runtimePackage = resolve(deployedRoot, "package.json");
  const dependenciesChanged = !existsSync(runtimePackage) || readFileSync(runtimePackage, "utf8") !== readFileSync(resolve(root, "package.json"), "utf8");
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
    execFileSync("/bin/cp", ["-cR", source, target], { stdio: "inherit" });
  }

  const runtimeDatabase = resolve(deployedRoot, "prisma/dev.db");
  if (!existsSync(runtimeDatabase)) copyFileSync(resolve(root, "prisma/dev.db"), runtimeDatabase);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
