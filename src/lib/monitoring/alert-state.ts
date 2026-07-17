import type { OperationalAlertCandidate } from "@/src/lib/monitoring/operational-alerts";

export type AlertState = Record<string, {
  active: boolean;
  lastSentAt: string | null;
  title: string;
  message: string;
}>;

export type AlertDelivery = OperationalAlertCandidate & {
  event: "triggered" | "reminder" | "recovered";
};

export function planAlertDeliveries(
  candidates: OperationalAlertCandidate[],
  previous: AlertState,
  now: Date,
  reminderIntervalMs: number,
) {
  const next: AlertState = { ...previous };
  const deliveries: AlertDelivery[] = [];
  const activeKeys = new Set(candidates.map((candidate) => candidate.key));

  for (const candidate of candidates) {
    const existing = previous[candidate.key];
    const lastSentAt = existing?.lastSentAt ? new Date(existing.lastSentAt).getTime() : 0;
    const event = !existing?.active
      ? "triggered"
      : now.getTime() - lastSentAt >= reminderIntervalMs
        ? "reminder"
        : null;
    if (event) deliveries.push({ ...candidate, event });
    next[candidate.key] = {
      active: true,
      lastSentAt: event ? now.toISOString() : existing?.lastSentAt ?? null,
      title: candidate.title,
      message: candidate.message,
    };
  }

  for (const [key, existing] of Object.entries(previous)) {
    if (!existing.active || activeKeys.has(key)) continue;
    deliveries.push({
      key,
      severity: "warning",
      title: `${existing.title}から復旧`,
      message: "現在は正常です",
      event: "recovered",
    });
    next[key] = { ...existing, active: false, lastSentAt: now.toISOString() };
  }

  return { deliveries, next };
}
