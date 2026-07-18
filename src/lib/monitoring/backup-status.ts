import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type BackupVerificationRecord = {
  status: "healthy" | "error";
  fileName: string | null;
  createdAt: string;
  verifiedAt: string | null;
  sizeBytes: number | null;
  message: string;
};

export type BackupFileEvidence = {
  name: string;
  modifiedAt: Date;
  sizeBytes: number;
};

export type BackupStatus = {
  status: "healthy" | "waiting" | "error";
  encrypted: true;
  copies: number;
  latestAt: string | null;
  verifiedAt: string | null;
  message: string;
};

export function readBackupStatus(now = new Date()): BackupStatus {
  const stateDirectory = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
  const backupDirectory = resolve(stateDirectory, "backups");
  const statusPath = resolve(stateDirectory, "backup-status.json");
  try {
    const files = readdirSync(backupDirectory)
      .filter((name) => name.startsWith("polymarket-") && name.endsWith(".db.enc"))
      .map((name) => {
        const metadata = statSync(resolve(backupDirectory, name));
        return { name, modifiedAt: metadata.mtime, sizeBytes: metadata.size };
      })
      .sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
    const statusExists = existsSync(statusPath);
    const record = statusExists ? parseBackupVerificationRecord(readFileSync(statusPath, "utf8")) : null;
    if (statusExists && !record) {
      return {
        status: "error",
        encrypted: true,
        copies: files.length,
        latestAt: files[0]?.modifiedAt.toISOString() ?? null,
        verifiedAt: null,
        message: "バックアップ復元確認の記録が壊れています",
      };
    }
    return evaluateBackupStatus({
      files,
      record,
      now,
      maximumAgeMs: backupMaximumAgeMs(),
    });
  } catch (error) {
    return {
      status: "error",
      encrypted: true,
      copies: 0,
      latestAt: null,
      verifiedAt: null,
      message: error instanceof Error ? error.message : "バックアップ状態を確認できません",
    };
  }
}

export function evaluateBackupStatus(input: {
  files: BackupFileEvidence[];
  record: BackupVerificationRecord | null;
  now: Date;
  maximumAgeMs: number;
}): BackupStatus {
  const files = [...input.files].sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
  const latest = files[0] ?? null;
  const base = {
    encrypted: true as const,
    copies: files.length,
    latestAt: latest?.modifiedAt.toISOString() ?? null,
    verifiedAt: input.record?.verifiedAt ?? null,
  };
  if (!latest) return { ...base, status: "waiting", message: "最初のバックアップを作成中です" };
  if (!input.record) return { ...base, status: "waiting", message: "復元確認の記録を待っています" };
  if (input.record.status === "error") {
    return { ...base, status: "error", message: input.record.message || "バックアップの復元確認に失敗しました" };
  }
  if (input.record.fileName !== latest.name) {
    return { ...base, status: "waiting", message: "最新世代の復元確認を待っています" };
  }
  const verifiedAtMs = input.record.verifiedAt ? new Date(input.record.verifiedAt).getTime() : Number.NaN;
  if (!Number.isFinite(verifiedAtMs)) {
    return { ...base, status: "error", message: "復元確認日時が記録されていません" };
  }
  if (input.now.getTime() - verifiedAtMs > input.maximumAgeMs) {
    return { ...base, status: "error", message: "復元確認済みバックアップが期限切れです" };
  }
  if (input.record.sizeBytes !== latest.sizeBytes) {
    return { ...base, status: "error", message: "確認後にバックアップのサイズが変化しました" };
  }
  return { ...base, status: "healthy", message: "暗号化・復号・SQLite整合性を確認済みです" };
}

function parseBackupVerificationRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as Partial<BackupVerificationRecord>;
    if ((parsed.status !== "healthy" && parsed.status !== "error") || typeof parsed.createdAt !== "string") return null;
    return {
      status: parsed.status,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : null,
      createdAt: parsed.createdAt,
      verifiedAt: typeof parsed.verifiedAt === "string" ? parsed.verifiedAt : null,
      sizeBytes: typeof parsed.sizeBytes === "number" && Number.isFinite(parsed.sizeBytes) ? parsed.sizeBytes : null,
      message: typeof parsed.message === "string" ? parsed.message : "",
    } satisfies BackupVerificationRecord;
  } catch {
    return null;
  }
}

function backupMaximumAgeMs() {
  const interval = Number(process.env.BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1_000);
  const normalized = Number.isFinite(interval) ? Math.max(60 * 60 * 1_000, interval) : 24 * 60 * 60 * 1_000;
  return Math.max(2 * 60 * 60 * 1_000, normalized * 1.5);
}
