import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { prisma } from "../src/lib/server/prisma";
import { evaluateWalletCopyBacktest } from "../src/lib/wallet-intelligence/backtest";

const generatedAt = new Date();
const signals = await prisma.walletSignal.findMany({ orderBy: { observedAt: "asc" } });
const reports = ([30, 60] as const).map((latencySeconds) => evaluateWalletCopyBacktest({
  signals,
  latencySeconds,
}));
const selected = reports.find((report) => report.edgeConfirmed)
  ?? [...reports].sort((left, right) => right.independentEvents - left.independentEvents || right.excessReturnPct - left.excessReturnPct)[0];
const runId = `wallet-copy:${selected.latencySeconds}:${selected.datasetHash}`;
const existing = await prisma.backtestRun.findUnique({ where: { id: runId } });
if (!existing) {
  await prisma.backtestRun.create({
    data: {
      id: runId,
      asset: "ALL",
      venue: "POLYMARKET_WALLET",
      modelVersion: "wallet-consensus-v1",
      datasetHash: selected.datasetHash,
      methodology: selected.methodology,
      benchmarkLabel: "市場多数方向",
      status: selected.status,
      threshold: 0.95,
      initialCapital: 1,
      marketCount: selected.independentEvents,
      metricsJson: JSON.stringify(selected),
      completedAt: generatedAt,
    },
  });
}
const report = {
  generatedAt: generatedAt.toISOString(),
  selectedLatencySeconds: selected.latencySeconds,
  status: selected.status,
  edgeConfirmed: selected.edgeConfirmed,
  reason: selected.reason,
  reports,
};
const artifactRoot = resolve(homedir(), ".polymarket-watch/artifacts/wallet-backtests");
mkdirSync(artifactRoot, { recursive: true });
writeFileSync(resolve(artifactRoot, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
const publicPath = resolve(process.env.WALLET_BACKTEST_OUTPUT ?? resolve(process.cwd(), "public/wallet-backtest.json"));
writeFileSync(publicPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await prisma.$disconnect();
console.log(JSON.stringify({ type: "wallet-backtest", ...report }));
