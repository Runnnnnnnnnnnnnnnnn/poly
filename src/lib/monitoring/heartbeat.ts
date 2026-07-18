import { prisma } from "@/src/lib/server/prisma";

export async function markPipelineAttempt(id: string, message?: string) {
  const now = new Date();
  return persistHeartbeat(() => prisma.pipelineHeartbeat.upsert({
    where: { id },
    create: { id, status: "running", records: 0, message, lastAttemptAt: now },
    update: { status: "running", message, lastAttemptAt: now },
  }));
}

export async function markPipelineSuccess(id: string, records: number, message?: string) {
  const now = new Date();
  return persistHeartbeat(() => prisma.pipelineHeartbeat.upsert({
    where: { id },
    create: { id, status: "healthy", records, message, lastAttemptAt: now, lastSuccessAt: now },
    update: { status: "healthy", records: { increment: records }, message, lastAttemptAt: now, lastSuccessAt: now },
  }));
}

export async function markPipelineError(id: string, error: unknown) {
  const now = new Date();
  const message = error instanceof Error ? error.message : String(error);
  return persistHeartbeat(() => prisma.pipelineHeartbeat.upsert({
    where: { id },
    create: { id, status: "error", records: 0, message, lastAttemptAt: now },
    update: { status: "error", message, lastAttemptAt: now },
  }));
}

export function isTransientHeartbeatWriteError(error: unknown) {
  const code = typeof error === "object" && error && "code" in error
    ? String(error.code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return ["P1008", "P2024", "P2034"].includes(code)
    || /database (?:is )?locked|socket timeout|timed out/i.test(message);
}

async function persistHeartbeat<T>(operation: () => Promise<T>) {
  const retryDelaysMs = [0, 100, 300];
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs) await sleep(delayMs);
    try {
      await operation();
      return true;
    } catch (error) {
      lastError = error;
      if (!isTransientHeartbeatWriteError(error)) break;
    }
  }
  console.error(`heartbeat write skipped: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
