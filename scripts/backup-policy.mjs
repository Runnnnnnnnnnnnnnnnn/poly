export function nextBackupDelayMs({ record, latestFile, nowMs, intervalMs }) {
  if (!record || record.status !== "healthy" || !record.verifiedAt || !latestFile) return 0;
  if (record.fileName !== latestFile.name || record.sizeBytes !== latestFile.sizeBytes) return 0;
  const verifiedAtMs = Date.parse(record.verifiedAt);
  if (!Number.isFinite(verifiedAtMs)) return 0;
  return Math.max(0, verifiedAtMs + intervalMs - nowMs);
}

export function isTemporaryBackupArtifact(name) {
  return /^\.(?:polymarket|verify)-.+\.db(?:-(?:journal|shm|wal))?$/.test(name)
    || /^\.polymarket-.+\.db\.enc\.tmp$/.test(name);
}
