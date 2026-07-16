import { prisma } from "@/src/lib/server/prisma";

export async function markPipelineAttempt(id: string, message?: string) {
  const now = new Date();
  await prisma.pipelineHeartbeat.upsert({
    where: { id },
    create: { id, status: "running", records: 0, message, lastAttemptAt: now },
    update: { status: "running", message, lastAttemptAt: now },
  });
}

export async function markPipelineSuccess(id: string, records: number, message?: string) {
  const now = new Date();
  await prisma.pipelineHeartbeat.upsert({
    where: { id },
    create: { id, status: "healthy", records, message, lastAttemptAt: now, lastSuccessAt: now },
    update: { status: "healthy", records: { increment: records }, message, lastAttemptAt: now, lastSuccessAt: now },
  });
}

export async function markPipelineError(id: string, error: unknown) {
  const now = new Date();
  const message = error instanceof Error ? error.message : String(error);
  await prisma.pipelineHeartbeat.upsert({
    where: { id },
    create: { id, status: "error", records: 0, message, lastAttemptAt: now },
    update: { status: "error", message, lastAttemptAt: now },
  });
}
