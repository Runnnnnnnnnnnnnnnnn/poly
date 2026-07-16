import { readFile, writeFile } from "node:fs/promises";

import { createPaperRun, getPaperRun, tickPaperRun } from "../src/lib/paper-trading/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(30_000, Number(process.env.PAPER_INTERVAL_MS ?? 300_000));
const asset = (process.env.ASSET ?? "BTC") as "BTC" | "ETH" | "SOL" | "XRP" | "OTHER";

const runFile = process.env.PAPER_RUN_FILE ?? ".paper-run-id";
let runId = process.env.PAPER_RUN_ID ?? await readFile(runFile, "utf8").then((value) => value.trim()).catch(() => "");
if (runId) {
  const existing = await getPaperRun(runId);
  if (!existing || existing.status !== "running") runId = "";
}
if (!runId) {
  const run = await createPaperRun({
    accountId: process.env.PAPER_ACCOUNT_ID,
    accountName: process.env.PAPER_ACCOUNT_NAME ?? `${asset} paper account`,
    asset,
    mode: "live",
    config: {
      initialCash: Number(process.env.INITIAL_CASH ?? 10_000),
      entryEdge: Number(process.env.ENTRY_EDGE ?? 0.03),
      maxPositionPct: Number(process.env.MAX_POSITION_PCT ?? 0.1),
      maxMarkets: Number(process.env.MARKET_LIMIT ?? 20),
    },
  });
  if (!run) throw new Error("could not create paper run");
  runId = run.id;
  await writeFile(runFile, runId, "utf8");
}

async function tick() {
  if (!runId) return;
  try {
    await markPipelineAttempt("paper", `${asset}を評価中`);
    const run = await tickPaperRun(runId);
    await markPipelineSuccess("paper", 1, `${asset}の仮想運用を更新`);
    console.log(JSON.stringify({ type: "paper-tick", runId, status: run?.status, cash: run?.finalCash, orders: run?.orders.length }));
  } catch (error) {
    await markPipelineError("paper", error);
    console.error(error instanceof Error ? error.message : error);
  }
}

console.log(`paper trading run ${runId} running every ${intervalMs}ms`);
await tick();
if (process.env.ONCE !== "1") setInterval(tick, intervalMs);
