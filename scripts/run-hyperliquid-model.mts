import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { prisma } from "../src/lib/server/prisma";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const stateRoot = resolve(process.env.POLYMARKET_STATE_DIR ?? resolve(homedir(), ".polymarket-watch"));
const pythonMarker = resolve(stateRoot, "analytics-python-path");
const python = process.env.ANALYTICS_PYTHON
  || (existsSync(pythonMarker) ? readFileSync(pythonMarker, "utf8").trim() : resolve(stateRoot, "analytics-venv/bin/python"));
const output = resolve(process.env.HYPERLIQUID_MODEL_OUTPUT ?? resolve(root, "public/hyperliquid-model.json"));
const artifactLatest = resolve(stateRoot, "artifacts/hyperliquid-model/latest.json");
const intervalMs = boundedNumber(process.env.HYPERLIQUID_MODEL_INTERVAL_MS, 30 * 60_000, 5 * 60_000, 24 * 60 * 60_000);
const once = process.env.HYPERLIQUID_MODEL_ONCE === "1" || process.argv.includes("--once");
let timer: NodeJS.Timeout | null = null;
let closing = false;

async function cycle() {
  await markPipelineAttempt("hyperliquid-model", "L1・L2・約定を時系列分割で検証中");
  try {
    const result = spawnSync(python, [
      resolve(root, "scripts/backtest-hyperliquid-model.py"),
      "--database-url", process.env.DATABASE_URL as string,
      "--output", output,
    ], { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Hyperliquid model failed").trim());
    const report = JSON.parse(readFileSync(output, "utf8"));
    const selected = report.selected;
    const runId = createHash("sha256")
      .update(`${report.modelVersion}:${report.generatedAt}:${selected?.dataset?.sha256 ?? "empty"}`)
      .digest("hex");
    await prisma.modelEvaluationRun.upsert({
      where: { id: runId },
      create: {
        id: runId,
        modelVersion: report.modelVersion,
        status: report.status,
        datasetHash: selected?.dataset?.sha256 ?? null,
        configJson: JSON.stringify(report.methodology),
        metricsJson: JSON.stringify(report),
        completedAt: new Date(report.generatedAt),
      },
      update: {
        status: report.status,
        metricsJson: JSON.stringify(report),
        completedAt: new Date(report.generatedAt),
      },
    });
    for (const gate of selected?.gates ?? []) {
      await prisma.modelGateResult.upsert({
        where: { runId_gateId: { runId, gateId: gate.id } },
        create: {
          id: `${runId}:${gate.id}`,
          runId,
          gateId: gate.id,
          label: gate.label,
          passed: gate.passed,
          value: gate.value,
          threshold: gate.threshold,
        },
        update: {
          label: gate.label,
          passed: gate.passed,
          value: gate.value,
          threshold: gate.threshold,
          evaluatedAt: new Date(),
        },
      });
    }
    await markPipelineSuccess(
      "hyperliquid-model",
      report.data.l1Rows + report.data.l2Rows,
      `${report.verdict}・独立窓${selected?.holdout?.independentWindows ?? 0}件・L2 ${report.data.l2DurationHours.toFixed(1)}時間`,
    );
    console.log(JSON.stringify({ type: "hyperliquid-model", status: report.status, verdict: report.verdict }));
  } catch (error) {
    await markPipelineError("hyperliquid-model", error);
    console.error(error instanceof Error ? error.message : error);
  }
  if (once) {
    closing = true;
    await prisma.$disconnect();
    return;
  }
  if (!closing) timer = setTimeout(() => void cycle(), intervalMs);
}

async function shutdown() {
  closing = true;
  if (timer) clearTimeout(timer);
  await prisma.$disconnect();
}

void cycle();
console.log(once ? "Hyperliquid model: one cycle" : `Hyperliquid model worker: every ${intervalMs}ms / ${artifactLatest}`);
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
