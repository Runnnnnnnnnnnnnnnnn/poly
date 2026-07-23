import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function runDatabasePreflight(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl?.startsWith("file:")) return { ready: true, status: "skipped", reason: "non-SQLite database" };
  const database = databaseUrl.slice("file:".length);
  const result = spawnSync("/usr/bin/sqlite3", [database, "PRAGMA quick_check(1);"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const ready = result.status === 0 && result.stdout.trim() === "ok";
  const reason = ready ? "SQLite quick check passed" : (result.stderr || result.stdout || "SQLite quick check failed").trim();
  const status = {
    status: ready ? "healthy" : "corrupt",
    checkedAt: new Date().toISOString(),
    database: "SQLite",
    message: ready ? "データベースの起動前検査に合格しました" : "データベース破損を検出したため収集プロセスを起動しません",
    code: ready ? "OK" : "DATABASE_CORRUPTION",
    detail: reason.slice(0, 1_000),
  };
  try {
    const stateRoot = resolve(homedir(), ".polymarket-watch");
    mkdirSync(stateRoot, { recursive: true });
    const statePath = resolve(stateRoot, "database-health.json");
    writeFileSync(statePath, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(statePath, 0o600);
  } catch {
    // The supervisor still uses the in-memory result.
  }
  return { ready, status: ready ? "healthy" : "corrupt", reason };
}
