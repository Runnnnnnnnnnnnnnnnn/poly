import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const label = "com.polymarket-watch.postgres";
const domain = `gui/${process.getuid()}`;
const home = homedir();
const application = resolve(home, "Applications/Postgres.app");
const binaries = resolve(application, "Contents/Versions/18/bin");
const postgres = resolve(binaries, "postgres");
const pgCtl = resolve(binaries, "pg_ctl");
const pgData = resolve(home, ".polymarket-watch/postgres/data");
const logPath = resolve(home, ".polymarket-watch/postgres/postgres.log");
const agentsDirectory = resolve(home, "Library/LaunchAgents");
const plistPath = resolve(agentsDirectory, `${label}.plist`);

if (!existsSync(postgres) || !existsSync(resolve(pgData, "PG_VERSION"))) {
  throw new Error("Postgres.app or the Polymarket Watch cluster is not initialized");
}

if (process.argv.includes("--uninstall")) {
  spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  console.log(`unloaded ${label}`);
  process.exit(0);
}

mkdirSync(agentsDirectory, { recursive: true });
mkdirSync(resolve(home, ".polymarket-watch/postgres"), { recursive: true });
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${postgres}</string>
    <string>-D</string><string>${pgData}</string>
    <string>-p</string><string>55432</string>
    <string>-h</string><string>127.0.0.1</string>
  </array>
  <key>WorkingDirectory</key><string>${home}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;

if (!existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist) {
  writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
  chmodSync(plistPath, 0o600);
}

spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
if (serverRunning()) {
  spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "stop"], { stdio: "inherit" });
}
execFileSync("/bin/launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
execFileSync("/bin/launchctl", ["kickstart", `${domain}/${label}`], { stdio: "inherit" });
console.log(`installed ${label}`);

function serverRunning() {
  const result = spawnSync(pgCtl, ["-D", pgData, "status"], { stdio: "ignore" });
  return result.status === 0;
}
