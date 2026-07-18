export const supervisorForceKillDelayMs = 2_000;
export const supervisorExitDelayMs = 2_500;

export function processSignalTarget(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return platform === "win32" ? pid : -pid;
}
