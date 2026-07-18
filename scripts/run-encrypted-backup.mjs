import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

const backupIntervalMs = Math.max(60 * 60 * 1_000, Number(process.env.BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1_000));
const retentionCount = Math.max(3, Math.min(60, Number(process.env.BACKUP_RETENTION_COUNT ?? 14)));
const stateDir = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
const backupDir = resolve(stateDir, "backups");
const keyPath = resolve(stateDir, "backup.key");
const statusPath = resolve(stateDir, "backup-status.json");
const databasePath = databaseFilePath(process.env.DATABASE_URL);
let running = false;

if (!databasePath) {
  console.error("encrypted backup disabled: DATABASE_URL is not a SQLite file URL");
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });
ensureKey();

async function backup() {
  if (running) return false;
  if (!existsSync(databasePath)) {
    writeBackupStatus({
      status: "error",
      fileName: null,
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      sizeBytes: null,
      message: "SQLite database file was not found",
    });
    return false;
  }
  running = true;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const temporaryPath = resolve(backupDir, `.polymarket-${timestamp}.db`);
  const encryptedPath = resolve(backupDir, `polymarket-${timestamp}.db.enc`);
  const verificationPath = resolve(backupDir, `.verify-${timestamp}.db`);
  try {
    execFileSync("/usr/bin/sqlite3", [databasePath, `.backup '${temporaryPath.replaceAll("'", "''")}'`], { stdio: "ignore" });
    verifySqliteDatabase(temporaryPath);
    execFileSync("/usr/bin/openssl", [
      "enc", "-aes-256-cbc", "-salt", "-pbkdf2",
      "-in", temporaryPath,
      "-out", encryptedPath,
      "-pass", `file:${keyPath}`,
    ], { stdio: "ignore" });
    chmodSync(encryptedPath, 0o600);
    execFileSync("/usr/bin/openssl", [
      "enc", "-d", "-aes-256-cbc", "-pbkdf2",
      "-in", encryptedPath,
      "-out", verificationPath,
      "-pass", `file:${keyPath}`,
    ], { stdio: "ignore" });
    verifySqliteDatabase(verificationPath);
    pruneBackups();
    writeBackupStatus({
      status: "healthy",
      fileName: basename(encryptedPath),
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      sizeBytes: statSync(encryptedPath).size,
      message: "encrypted backup restored and SQLite integrity verified",
    });
    console.log(`encrypted database backup created: ${encryptedPath}`);
    return true;
  } catch (error) {
    rmSync(encryptedPath, { force: true });
    writeBackupStatus({
      status: "error",
      fileName: basename(encryptedPath),
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      sizeBytes: null,
      message: "暗号化バックアップの作成・復号・SQLite整合性確認に失敗しました",
    });
    console.error(`encrypted database backup failed: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    rmSync(temporaryPath, { force: true });
    rmSync(verificationPath, { force: true });
    running = false;
  }
}

function verifySqliteDatabase(path) {
  const result = execFileSync("/usr/bin/sqlite3", [path, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim();
  if (result !== "ok") throw new Error(`SQLite integrity check failed: ${result.slice(0, 300)}`);
}

function writeBackupStatus(status) {
  const temporaryStatusPath = `${statusPath}.tmp`;
  writeFileSync(temporaryStatusPath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryStatusPath, statusPath);
  chmodSync(statusPath, 0o600);
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

const initialBackupSucceeded = await backup();
if (process.env.BACKUP_ONCE === "1") {
  process.exit(initialBackupSucceeded ? 0 : 1);
}
setInterval(() => void backup(), backupIntervalMs);
console.log(`encrypted database backup worker: every ${backupIntervalMs}ms / keep ${retentionCount}`);
