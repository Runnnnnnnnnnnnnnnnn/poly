import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { isTemporaryBackupArtifact, nextBackupDelayMs } from "./backup-policy.mjs";

const backupIntervalMs = numericSetting(process.env.BACKUP_INTERVAL_MS, 24 * 60 * 60 * 1_000, 60 * 60 * 1_000);
const retryIntervalMs = numericSetting(process.env.BACKUP_RETRY_INTERVAL_MS, 5 * 60 * 1_000, 60 * 1_000, backupIntervalMs);
const retentionCount = Math.round(numericSetting(process.env.BACKUP_RETENTION_COUNT, 14, 3, 60));
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
cleanupTemporaryArtifacts();
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
  const encryptedTemporaryPath = resolve(backupDir, `.polymarket-${timestamp}.db.enc.tmp`);
  const verificationPath = resolve(backupDir, `.verify-${timestamp}.db`);
  try {
    execFileSync("/usr/bin/sqlite3", [databasePath, `.backup '${temporaryPath.replaceAll("'", "''")}'`], { stdio: "ignore" });
    verifySqliteDatabase(temporaryPath);
    execFileSync("/usr/bin/openssl", [
      "enc", "-aes-256-cbc", "-salt", "-pbkdf2",
      "-in", temporaryPath,
      "-out", encryptedTemporaryPath,
      "-pass", `file:${keyPath}`,
    ], { stdio: "ignore" });
    chmodSync(encryptedTemporaryPath, 0o600);
    execFileSync("/usr/bin/openssl", [
      "enc", "-d", "-aes-256-cbc", "-pbkdf2",
      "-in", encryptedTemporaryPath,
      "-out", verificationPath,
      "-pass", `file:${keyPath}`,
    ], { stdio: "ignore" });
    verifySqliteDatabase(verificationPath);
    const sha256 = await fileSha256(encryptedTemporaryPath);
    renameSync(encryptedTemporaryPath, encryptedPath);
    chmodSync(encryptedPath, 0o600);
    pruneBackups();
    writeBackupStatus({
      status: "healthy",
      fileName: basename(encryptedPath),
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      sizeBytes: statSync(encryptedPath).size,
      sha256,
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
    removeSqliteArtifactSet(temporaryPath);
    removeSqliteArtifactSet(verificationPath);
    rmSync(encryptedTemporaryPath, { force: true });
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

function cleanupTemporaryArtifacts() {
  for (const name of readdirSync(backupDir)) {
    if (isTemporaryBackupArtifact(name)) rmSync(resolve(backupDir, name), { force: true });
  }
}

function removeSqliteArtifactSet(path) {
  for (const suffix of ["", "-shm", "-wal", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

function fileSha256(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveDigest(hash.digest("hex")));
  });
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

function numericSetting(value, fallback, minimum, maximum = Number.POSITIVE_INFINITY) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function readLatestBackupEvidence() {
  try {
    const files = readdirSync(backupDir)
      .filter((name) => name.startsWith("polymarket-") && name.endsWith(".db.enc"))
      .map((name) => ({ name, sizeBytes: statSync(resolve(backupDir, name)).size }))
      .sort((left, right) => right.name.localeCompare(left.name));
    const record = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : null;
    return { record, latestFile: files[0] ?? null };
  } catch {
    return { record: null, latestFile: null };
  }
}

function scheduleBackup(delayMs) {
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();
  console.log(`next encrypted database backup scheduled for ${scheduledFor}`);
  setTimeout(async () => {
    const succeeded = await backup();
    scheduleBackup(succeeded ? backupIntervalMs : retryIntervalMs);
  }, delayMs);
}

if (process.env.BACKUP_ONCE === "1") {
  process.exit(await backup() ? 0 : 1);
}

const latestEvidence = readLatestBackupEvidence();
const initialDelayMs = process.env.BACKUP_FORCE_ON_START === "1"
  ? 0
  : nextBackupDelayMs({
      ...latestEvidence,
      nowMs: Date.now(),
      intervalMs: backupIntervalMs,
    });
scheduleBackup(initialDelayMs);
console.log(`encrypted database backup worker: every ${backupIntervalMs}ms / retry ${retryIntervalMs}ms / keep ${retentionCount}`);
