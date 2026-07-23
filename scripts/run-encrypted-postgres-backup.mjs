import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { nextBackupDelayMs } from "./backup-policy.mjs";

const databaseUrl = (process.env.DATABASE_URL ?? "").split("?schema=", 1)[0];
if (!databaseUrl.startsWith("postgresql://") && !databaseUrl.startsWith("postgres://")) {
  throw new Error("PostgreSQL DATABASE_URL is required");
}

const backupIntervalMs = numericSetting(process.env.BACKUP_INTERVAL_MS, 6 * 60 * 60_000, 60 * 60_000);
const retryIntervalMs = numericSetting(process.env.BACKUP_RETRY_INTERVAL_MS, 5 * 60_000, 60_000, backupIntervalMs);
const retentionCount = Math.round(numericSetting(process.env.BACKUP_RETENTION_COUNT, 28, 3, 90));
const stateDir = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
const backupDir = resolve(stateDir, "backups");
const keyPath = resolve(stateDir, "backup.key");
const statusPath = resolve(stateDir, "backup-status.json");
const postgresBin = resolve(homedir(), "Applications/Postgres.app/Contents/Versions/18/bin");
const pgDump = resolve(postgresBin, "pg_dump");
const pgRestore = resolve(postgresBin, "pg_restore");
const psql = resolve(postgresBin, "psql");
let running = false;

for (const binary of [pgDump, pgRestore, psql]) {
  if (!existsSync(binary)) throw new Error(`PostgreSQL backup tool not found: ${binary}`);
}
mkdirSync(backupDir, { recursive: true });
ensureKey();
cleanupTemporaryArtifacts();

async function backup() {
  if (running) return false;
  running = true;
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const dumpPath = resolve(backupDir, `.polymarket-${timestamp}.pgdump`);
  const encryptedPath = resolve(backupDir, `polymarket-${timestamp}.pgdump.enc`);
  const encryptedTemporaryPath = resolve(backupDir, `.polymarket-${timestamp}.pgdump.enc.tmp`);
  const verificationPath = resolve(backupDir, `.verify-${timestamp}.pgdump`);
  try {
    execFileSync(pgDump, [
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-acl",
      "--file", dumpPath,
      databaseUrl,
    ], { stdio: "ignore" });
    verifyArchive(dumpPath);
    execFileSync("/usr/bin/openssl", [
      "enc", "-aes-256-cbc", "-salt", "-pbkdf2",
      "-in", dumpPath,
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
    verifyArchive(verificationPath);
    const verification = verifyRestore(verificationPath);
    const sha256 = await fileSha256(encryptedTemporaryPath);
    renameSync(encryptedTemporaryPath, encryptedPath);
    chmodSync(encryptedPath, 0o600);
    pruneBackups();
    writeBackupStatus({
      status: "healthy",
      provider: "postgresql",
      fileName: basename(encryptedPath),
      createdAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      sizeBytes: statSync(encryptedPath).size,
      sha256,
      restoredTables: verification.tables,
      restoredRealtimeRows: verification.realtimeRows,
      message: "PostgreSQLバックアップを暗号化し、一時DBへの復元を確認済みです",
    });
    console.log(`encrypted PostgreSQL backup created: ${encryptedPath}`);
    return true;
  } catch (error) {
    writeBackupStatus({
      status: "error",
      provider: "postgresql",
      fileName: basename(encryptedPath),
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      sizeBytes: null,
      message: `PostgreSQLバックアップの復元確認に失敗しました: ${error instanceof Error ? error.message : error}`,
    });
    console.error(error instanceof Error ? error.message : error);
    return false;
  } finally {
    for (const path of [dumpPath, verificationPath, encryptedTemporaryPath]) rmSync(path, { force: true });
    running = false;
  }
}

function verifyArchive(path) {
  const result = execFileSync(pgRestore, ["--list", path], { encoding: "utf8" });
  if (!/TABLE DATA public RealtimeMarketTick/.test(result) || !/TABLE DATA public PredictionMarket/.test(result)) {
    throw new Error("pg_dump archive is missing required tables");
  }
}

function verifyRestore(path) {
  const verificationDatabase = `polymarket_verify_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const adminUrl = databaseUrlFor("postgres");
  const verificationUrl = databaseUrlFor(verificationDatabase);
  try {
    execFileSync(psql, [adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${verificationDatabase}";`], { stdio: "ignore" });
    execFileSync(pgRestore, ["--no-owner", "--no-acl", "--dbname", verificationUrl, path], { stdio: "ignore" });
    const output = execFileSync(psql, [
      verificationUrl,
      "-At",
      "-F", "|",
      "-v", "ON_ERROR_STOP=1",
      "-c", `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';
             SELECT COUNT(*) FROM "RealtimeMarketTick";`,
    ], { encoding: "utf8" }).trim().split("\n");
    const tables = Number(output[0]);
    const realtimeRows = Number(output[1]);
    if (tables < 24 || !Number.isFinite(realtimeRows)) throw new Error("restored PostgreSQL database validation failed");
    return { tables, realtimeRows };
  } finally {
    execFileSync(psql, [
      adminUrl,
      "-v", "ON_ERROR_STOP=1",
      "-c", `DROP DATABASE IF EXISTS "${verificationDatabase}" WITH (FORCE);`,
    ], { stdio: "ignore" });
  }
}

function databaseUrlFor(database) {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${database}`;
  parsed.search = "";
  return parsed.toString();
}

function ensureKey() {
  if (!existsSync(keyPath)) writeFileSync(keyPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
}

function writeBackupStatus(status) {
  const temporary = `${statusPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, statusPath);
  chmodSync(statusPath, 0o600);
}

function cleanupTemporaryArtifacts() {
  for (const name of readdirSync(backupDir)) {
    if (/^\.(?:polymarket|verify)-.+\.pgdump(?:\.enc\.tmp)?$/.test(name)) rmSync(resolve(backupDir, name), { force: true });
  }
}

function pruneBackups() {
  const backups = readdirSync(backupDir)
    .filter((name) => name.startsWith("polymarket-") && name.endsWith(".pgdump.enc"))
    .sort()
    .reverse();
  for (const name of backups.slice(retentionCount)) rmSync(resolve(backupDir, name), { force: true });
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

function readLatestBackupEvidence() {
  try {
    const files = readdirSync(backupDir)
      .filter((name) => name.startsWith("polymarket-") && name.endsWith(".pgdump.enc"))
      .map((name) => ({ name, sizeBytes: statSync(resolve(backupDir, name)).size }))
      .sort((left, right) => right.name.localeCompare(left.name));
    const record = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")) : null;
    return { record, latestFile: files[0] ?? null };
  } catch {
    return { record: null, latestFile: null };
  }
}

function scheduleBackup(delayMs) {
  console.log(`next encrypted PostgreSQL backup scheduled for ${new Date(Date.now() + delayMs).toISOString()}`);
  setTimeout(async () => scheduleBackup(await backup() ? backupIntervalMs : retryIntervalMs), delayMs);
}

function numericSetting(value, fallback, minimum, maximum = Number.POSITIVE_INFINITY) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

if (process.env.BACKUP_ONCE === "1") {
  process.exit(await backup() ? 0 : 1);
}
const latest = readLatestBackupEvidence();
scheduleBackup(process.env.BACKUP_FORCE_ON_START === "1"
  ? 0
  : nextBackupDelayMs({ ...latest, nowMs: Date.now(), intervalMs: backupIntervalMs }));
console.log(`encrypted PostgreSQL backup worker: every ${backupIntervalMs}ms / keep ${retentionCount}`);
