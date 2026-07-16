import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const label = "com.polymarket-watch.runtime";
const agentsDir = resolve(homedir(), "Library/LaunchAgents");
const plistPath = resolve(agentsDir, `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;

if (process.argv.includes("--uninstall")) {
  try { execFileSync("launchctl", ["bootout", service], { stdio: "ignore" }); } catch {}
  rmSync(plistPath, { force: true });
  console.log(`removed ${label}`);
  process.exit(0);
}

const command = `cd ${shellQuote(root)} && PAPER_PRODUCTION=1 APP_PORT=3001 ${shellQuote(process.execPath)} scripts/run-all.mjs`;
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xmlEscape(command)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
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
try { execFileSync("launchctl", ["bootout", service], { stdio: "ignore" }); } catch {}
execFileSync("launchctl", ["bootstrap", domain, plistPath]);
execFileSync("launchctl", ["kickstart", "-k", service]);
console.log(`installed ${label}`);

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
