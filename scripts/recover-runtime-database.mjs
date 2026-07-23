import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const sqlite = "/usr/bin/sqlite3";
const apply = process.argv.includes("--apply");
const source = resolve(argumentValue("--source") ?? resolve(homedir(), ".polymarket-watch/runtime/prisma/dev.db"));
const output = resolve(argumentValue("--output") ?? resolve(dirname(source), "dev.recovered.db"));
const stateRoot = resolve(homedir(), ".polymarket-watch");
const recoveryRoot = resolve(stateRoot, "recovery");
const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const forensicDirectory = resolve(recoveryRoot, `forensic-${timestamp}`);
const auditPath = resolve(recoveryRoot, `recovery-${timestamp}.json`);
const serviceDomain = `gui/${process.getuid()}`;
const runtimeServices = [
  "com.polymarket-watch.watchdog",
  "com.polymarket-watch.tunnel",
  "com.polymarket-watch.runtime",
];

if (!existsSync(sqlite)) throw new Error("sqlite3 is required");
if (!existsSync(source)) throw new Error(`database not found: ${source}`);
if (apply) stopRuntimeServices();

mkdirSync(forensicDirectory, { recursive: true, mode: 0o700 });
const preserved = preserveDatabaseFiles();
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "polymarket-recovery-"));
const recovered = resolve(temporaryDirectory, "recovered.db");
const sqlPath = resolve(temporaryDirectory, "recover.sql");

try {
  recoverDatabase(source, recovered, sqlPath);
  const validation = validateDatabase(recovered);
  const audit = {
    schemaVersion: 1,
    mode: apply ? "apply" : "dry-run",
    status: "verified",
    generatedAt: new Date().toISOString(),
    source,
    sourceBytes: statSync(source).size,
    sourceSha256: sha256(source),
    forensicDirectory,
    preserved,
    validation,
    applied: false,
    output: apply ? source : output,
  };

  if (apply) {
    const suffix = timestamp.replaceAll("-", "");
    const corruptPath = `${source}.corrupt-${suffix}`;
    renameSync(source, corruptPath);
    for (const suffixName of ["-wal", "-shm", "-journal"]) {
      const companion = `${source}${suffixName}`;
      if (existsSync(companion)) renameSync(companion, `${companion}.corrupt-${suffix}`);
    }
    renameSync(recovered, source);
    audit.applied = true;
    audit.replacedSource = corruptPath;
    audit.outputSha256 = sha256(source);
  } else {
    rmSync(output, { force: true });
    renameSync(recovered, output);
    audit.outputSha256 = sha256(output);
  }

  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(resolve(stateRoot, "database-health.json"), `${JSON.stringify({
    status: "healthy",
    checkedAt: new Date().toISOString(),
    database: apply ? source : output,
    recoveryAudit: auditPath,
    message: apply ? "破損DBを復旧済み" : "復旧候補DBの整合性を確認済み",
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ auditPath, ...audit }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(auditPath, `${JSON.stringify({
    schemaVersion: 1,
    mode: apply ? "apply" : "dry-run",
    status: "failed",
    generatedAt: new Date().toISOString(),
    source,
    forensicDirectory,
    preserved,
    message,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  throw error;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function argumentValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function stopRuntimeServices() {
  for (const label of runtimeServices) {
    spawnSync("/bin/launchctl", ["bootout", `${serviceDomain}/${label}`], { stdio: "ignore" });
  }
}

function preserveDatabaseFiles() {
  const files = [source, `${source}-wal`, `${source}-shm`, `${source}-journal`].filter(existsSync);
  return files.map((file) => {
    const target = resolve(forensicDirectory, file.split("/").at(-1));
    copyFileSync(file, target);
    return {
      source: file,
      file: target,
      bytes: statSync(target).size,
      sha256: sha256(target),
    };
  });
}

function recoverDatabase(input, target, sqlFile) {
  rmSync(target, { force: true });
  const sqlDescriptor = openSync(sqlFile, "w", 0o600);
  try {
    const extraction = spawnSync(sqlite, [input, ".recover --ignore-freelist"], {
      stdio: ["ignore", sqlDescriptor, "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (extraction.status !== 0) throw new Error(`sqlite recovery extraction failed: ${extraction.stderr?.trim()}`);
  } finally {
    closeSync(sqlDescriptor);
  }

  const sqlInput = openSync(sqlFile, "r");
  try {
    const importResult = spawnSync(sqlite, [target], {
      stdio: [sqlInput, "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (importResult.status !== 0) throw new Error(`sqlite recovery import failed: ${importResult.stderr?.trim()}`);
  } finally {
    closeSync(sqlInput);
  }
}

function validateDatabase(database) {
  const integrity = query(database, "PRAGMA integrity_check;").trim();
  if (integrity !== "ok") throw new Error(`recovered database integrity failed: ${integrity.slice(0, 500)}`);
  const foreignKeys = query(database, "PRAGMA foreign_key_check;").trim();
  if (foreignKeys) throw new Error(`recovered database foreign keys failed: ${foreignKeys.slice(0, 500)}`);
  const tables = query(database, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
    .trim()
    .split("\n")
    .filter(Boolean);
  const rowCounts = Object.fromEntries(tables.map((table) => [
    table,
    Number(query(database, `SELECT COUNT(*) FROM "${table.replaceAll('"', '""')}";`).trim()),
  ]));
  const timeRanges = {};
  for (const table of ["PredictionMarket", "MarketSnapshot", "HyperliquidSnapshot", "RealtimeMarketTick", "RealtimeAssetTick", "CombinedShadowPosition"]) {
    if (!tables.includes(table)) continue;
    const columns = query(database, `PRAGMA table_info("${table}");`).split("\n").map((line) => line.split("|")[1]);
    const timeColumn = columns.includes("capturedAt") ? "capturedAt"
      : columns.includes("lastSeenAt") ? "lastSeenAt"
        : columns.includes("closedAt") ? "closedAt"
          : null;
    if (!timeColumn) continue;
    const [minimum, maximum] = query(database, `SELECT MIN("${timeColumn}"), MAX("${timeColumn}") FROM "${table}";`).trim().split("|");
    timeRanges[table] = { column: timeColumn, minimum: minimum || null, maximum: maximum || null };
  }
  return {
    integrity,
    foreignKeys: "ok",
    bytes: statSync(database).size,
    sha256: sha256(database),
    tables: tables.length,
    rowCounts,
    timeRanges,
  };
}

function query(database, statement) {
  const result = spawnSync(sqlite, ["-noheader", "-separator", "|", database, statement], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`sqlite query failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function sha256(file) {
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  return hash.digest("hex");
}
