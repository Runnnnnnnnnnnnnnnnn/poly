export function evaluateRuntimeWatchdog(input) {
  const nowMs = finite(input.nowMs, Date.now());
  const maximumDataAgeMs = positive(input.maximumDataAgeMs, 5 * 60_000);
  const failureThreshold = Math.max(2, Math.round(positive(input.failureThreshold, 3)));
  const restartCooldownMs = positive(input.restartCooldownMs, 10 * 60_000);
  const generatedAtMs = Date.parse(input.dashboardGeneratedAt || "");
  const dataAgeMs = Number.isFinite(generatedAtMs) ? Math.max(0, nowMs - generatedAtMs) : null;
  const healthy = input.healthOk === true && dataAgeMs !== null && dataAgeMs <= maximumDataAgeMs;

  if (healthy) {
    return { action: "healthy", reason: "runtime and dashboard are current", consecutiveFailures: 0, dataAgeMs };
  }

  const consecutiveFailures = Math.max(0, Math.round(finite(input.previousFailures, 0))) + 1;
  const reason = input.healthOk !== true
    ? input.errorMessage || "runtime health request failed"
    : dataAgeMs === null
      ? "dashboard timestamp is missing"
      : `dashboard is ${Math.round(dataAgeMs / 1_000)}s old`;
  if (isDatabaseIntegrityFailure(reason)) {
    return { action: "halt", reason, consecutiveFailures, dataAgeMs };
  }
  const lastRestartAtMs = Date.parse(input.lastRestartAt || "");
  const coolingDown = Number.isFinite(lastRestartAtMs) && nowMs - lastRestartAtMs < restartCooldownMs;
  const action = consecutiveFailures >= failureThreshold && !coolingDown ? "restart" : coolingDown ? "cooldown" : "waiting";
  return { action, reason, consecutiveFailures, dataAgeMs };
}

export function isDatabaseIntegrityFailure(message) {
  return /DATABASE_CORRUPTION|database disk image is malformed|sqlite[_ ]corrupt|integrity check failed/i.test(message || "");
}

function positive(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
