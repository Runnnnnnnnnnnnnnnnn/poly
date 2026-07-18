export function nextRealtimeReplayDelayMs({ generatedAtMs, nowMs, intervalMs, minimumDelayMs = 60_000 }) {
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return Math.max(1, minimumDelayMs);
  }
  const ageMs = Math.max(0, nowMs - generatedAtMs);
  return Math.max(minimumDelayMs, intervalMs - ageMs);
}
