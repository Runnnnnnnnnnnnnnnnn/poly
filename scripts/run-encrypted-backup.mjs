import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const backupIntervalMs = Math.max(60 * 60 * 1_000, Number(process.env.BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1_000));
const retentionCount = Math.max(3, Math.min(60, Number(process.env.BACKUP_RETENTION_COUNT ?? 14)));
const stateDir = resolve(homedir(), ".polymarket-watch");
const backupDir = resolve(stateDir, "backups");
const keyPath = resolve(stateDir, "backup.key");
const databasePath = databaseFilePath(process.env.DATABASE_URL);
let running = false;

if (!databasePath) {
  console.error("encrypted backup disabled: DATABASE_URL is not a SQLite file URL");
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });
ensureKey();

async function backup() {
  if (running || !existsSync(databasePath)) return;
  running = true;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const temporaryPath = resolve(backupDir, `.polymarket-${timestamp}.db`);
  const encryptedPath = resolve(backupDir, `polymarket-${timestamp}.db.enc`);
  try {
    execFileSync("/usr/bin/sqlite3", [databasePath, `.backup '${temporaryPath.replaceAll("'", "''")}'`], { stdio: "ignore" });
    execFileSync("/usr/bin/openssl", [
      "enc", "-aes-256-cbc", "-salt", "-pbkdf2",
      "-in", temporaryPath,
      "-out", encryptedPath,
      "-pass", `file:${keyPath}`,
    ], { stdio: "ignore" });
    chmodSync(encryptedPath, 0o600);
    pruneBackups();
    console.log(`encrypted database backup created: ${encryptedPath}`);
  } catch (error) {
    console.error(`encrypted database backup failed: ${error instanceof Error ? error.message : error}`);
  } finally {
    rmSync(temporaryPath, { force: true });
    running = false;
  }
}

function ensureKey() {
  if (!existsSync(keyPath)) writeFileSync(keyPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
}

function pruneBackups() {
  const backups = readdirSync(backupDir)
    .filter((name) => name.startsWith("polymarket-") && name.endsWith(".db.enc"))
    .sort()
    .reverse();
  for (const name of backups.slice(retentionCount)) rmSync(resolve(backupDir, name), { force: true });
}

function databaseFilePath(value) {
  if (!value?.startsWith("file:")) return null;
  const path = value.slice("file:".length).replace(/^['"]|['"]$/g, "");
  return resolve(process.env.POLYMARKET_PROJECT_ROOT ?? process.cwd(), path);
}

await backup();
setInterval(() => void backup(), backupIntervalMs);
console.log(`encrypted database backup worker: every ${backupIntervalMs}ms / keep ${retentionCount}`);
