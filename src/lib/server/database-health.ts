import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { prisma } from "@/src/lib/server/prisma";

export type DatabaseHealthStatus = {
  status: "healthy" | "unavailable" | "corrupt";
  checkedAt: string;
  database: string;
  message: string;
  code: "OK" | "DATABASE_UNAVAILABLE" | "DATABASE_CORRUPTION";
};

const stateRoot = resolve(homedir(), ".polymarket-watch");
const statePath = resolve(stateRoot, "database-health.json");

export async function probeDatabase(): Promise<DatabaseHealthStatus> {
  const checkedAt = new Date().toISOString();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    const status: DatabaseHealthStatus = {
      status: "healthy",
      checkedAt,
      database: databaseLabel(),
      message: "データベースへ接続できます",
      code: "OK",
    };
    persistDatabaseHealth(status);
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const corrupt = isDatabaseCorruptionError(message);
    const status: DatabaseHealthStatus = {
      status: corrupt ? "corrupt" : "unavailable",
      checkedAt,
      database: databaseLabel(),
      message: corrupt ? "データベースの破損を検出したため収集を停止しました" : "データベースへ接続できません",
      code: corrupt ? "DATABASE_CORRUPTION" : "DATABASE_UNAVAILABLE",
    };
    persistDatabaseHealth(status);
    return status;
  }
}

export function readDatabaseHealth(): DatabaseHealthStatus | null {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as DatabaseHealthStatus;
  } catch {
    return null;
  }
}

export function isDatabaseCorruptionError(message: string | null | undefined) {
  return /database disk image is malformed|database corruption|sqlite[_ ]corrupt|SQLITE_CORRUPT|integrity check failed/i.test(message ?? "");
}

function persistDatabaseHealth(status: DatabaseHealthStatus) {
  try {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(statePath, 0o600);
  } catch {
    // Health responses must still work when the status directory is unavailable.
  }
}

function databaseLabel() {
  const value = process.env.DATABASE_URL ?? "";
  if (value.startsWith("postgresql://") || value.startsWith("postgres://")) return "PostgreSQL";
  if (value.startsWith("file:")) return "SQLite";
  return "未設定";
}
