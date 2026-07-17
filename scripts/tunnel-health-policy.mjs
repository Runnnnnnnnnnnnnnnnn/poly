export function decideTunnelRecovery(config, consecutiveFailures, failureThreshold = 3) {
  const threshold = Math.max(1, Math.floor(failureThreshold));
  if (consecutiveFailures < threshold) return "retry";
  if (config.mode === "quick") return "restart-quick";
  if (config.allowQuickFallback) return "fallback-quick";
  return "retry";
}
