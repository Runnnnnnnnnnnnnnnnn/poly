import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type ColumnarArchiveRecord = {
  status: "healthy" | "error";
  schemaVersion: number;
  generatedAt: string;
  verifiedAt: string | null;
  archivedThrough: string | null;
  partitions: number;
  rows: number;
  sizeBytes: number;
  message: string;
};

export type ColumnarArchiveStatus = Omit<ColumnarArchiveRecord, "status"> & {
  status: "healthy" | "waiting" | "error";
};

export function readColumnarArchiveStatus(now = new Date()): ColumnarArchiveStatus {
  const stateRoot = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
  const statusPath = resolve(process.env.COLUMNAR_ARCHIVE_STATUS_PATH ?? resolve(stateRoot, "columnar-archive-status.json"));
  if (!existsSync(statusPath)) return waitingStatus("最初の完了日を保存中です");
  try {
    const record = parseColumnarArchiveRecord(readFileSync(statusPath, "utf8"));
    if (!record) return errorStatus("Parquet保存の検証記録が壊れています");
    return evaluateColumnarArchiveStatus(record, now, maximumArchiveAgeMs());
  } catch (error) {
    return errorStatus(error instanceof Error ? error.message : "Parquet保存状態を確認できません");
  }
}

export function evaluateColumnarArchiveStatus(
  record: ColumnarArchiveRecord,
  now: Date,
  maximumAgeMs: number,
): ColumnarArchiveStatus {
  if (record.status === "error") return { ...record, status: "error" };
  const verifiedAt = record.verifiedAt ? new Date(record.verifiedAt).getTime() : Number.NaN;
  if (!Number.isFinite(verifiedAt)) return { ...record, status: "error", message: "Parquetの再読込確認日時がありません" };
  if (now.getTime() - verifiedAt > maximumAgeMs) {
    return { ...record, status: "error", message: "Parquetの検証が期限切れです" };
  }
  if (!record.archivedThrough) return { ...record, status: "waiting" };
  const expectedThrough = previousUtcDate(now);
  if (record.archivedThrough < expectedThrough) {
    return { ...record, status: "waiting", message: `${expectedThrough}分の保存を待っています` };
  }
  return { ...record, status: "healthy", message: "日次Parquetを件数・SHA-256・再読込で確認済みです" };
}

function parseColumnarArchiveRecord(value: string): ColumnarArchiveRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<ColumnarArchiveRecord>;
    if ((parsed.status !== "healthy" && parsed.status !== "error")
      || parsed.schemaVersion !== 1
      || typeof parsed.generatedAt !== "string") return null;
    return {
      status: parsed.status,
      schemaVersion: parsed.schemaVersion,
      generatedAt: parsed.generatedAt,
      verifiedAt: typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : null,
      archivedThrough: typeof parsed.archivedThrough === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.archivedThrough)
        ? parsed.archivedThrough
        : null,
      partitions: finiteCount(parsed.partitions),
      rows: finiteCount(parsed.rows),
      sizeBytes: finiteCount(parsed.sizeBytes),
      message: typeof parsed.message === "string" ? parsed.message : "",
    };
  } catch {
    return null;
  }
}

function previousUtcDate(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
}

function maximumArchiveAgeMs() {
  const interval = Number(process.env.COLUMNAR_ARCHIVE_INTERVAL_MS ?? 6 * 60 * 60_000);
  const normalized = Number.isFinite(interval) ? Math.max(60 * 60_000, interval) : 6 * 60 * 60_000;
  return Math.max(12 * 60 * 60_000, normalized * 2.5);
}

function finiteCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function waitingStatus(message: string): ColumnarArchiveStatus {
  return { status: "waiting", schemaVersion: 1, generatedAt: "", verifiedAt: null, archivedThrough: null, partitions: 0, rows: 0, sizeBytes: 0, message };
}

function errorStatus(message: string): ColumnarArchiveStatus {
  return { status: "error", schemaVersion: 1, generatedAt: "", verifiedAt: null, archivedThrough: null, partitions: 0, rows: 0, sizeBytes: 0, message };
}
