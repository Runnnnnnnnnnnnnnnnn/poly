import { runBacktest, collectCryptoSnapshots } from "../src/lib/backtest/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { collectHyperliquidSnapshots } from "../src/lib/monitoring/hyperliquid";
import { prisma } from "../src/lib/server/prisma";

const collectIntervalMs = Math.max(60_000, Number(process.env.COLLECT_INTERVAL_MS ?? 300_000));
const backtestIntervalMs = Math.max(60 * 60 * 1_000, Number(process.env.BACKTEST_INTERVAL_MS ?? 6 * 60 * 60 * 1_000));
const assets = ["BTC", "ETH", "SOL", "XRP"] as const;
let collecting = false;
let backtesting = false;

async function collectCycle() {
  if (collecting) return;
  collecting = true;
  try {
    await markPipelineAttempt("polymarket", "公開市場を取得中");
    const [polymarket, hyperliquid] = await Promise.allSettled([
      collectCryptoSnapshots(),
      collectHyperliquidSnapshots(),
    ]);
    if (polymarket.status === "fulfilled") {
      await markPipelineSuccess("polymarket", polymarket.value.saved, `${polymarket.value.saved}市場を保存`);
      console.log(JSON.stringify({ type: "polymarket-snapshot", ...polymarket.value }));
    } else {
      await markPipelineError("polymarket", polymarket.reason);
      console.error(polymarket.reason);
    }
    if (hyperliquid.status === "fulfilled") {
      console.log(JSON.stringify({ type: "hyperliquid-snapshot", ...hyperliquid.value }));
    } else {
      console.error(hyperliquid.reason);
    }
  } finally {
    collecting = false;
  }
}

async function backtestCycle() {
  if (backtesting) return;
  backtesting = true;
  try {
    const heartbeat = await prisma.pipelineHeartbeat.findUnique({ where: { id: "backtest" } });
    if (heartbeat?.lastSuccessAt && Date.now() - heartbeat.lastSuccessAt.getTime() < backtestIntervalMs * 0.9) return;
    const latestByAsset = await prisma.backtestRun.groupBy({
      by: ["asset"],
      where: { status: "completed" },
      _max: { completedAt: true },
    });
    const latestMap = new Map(latestByAsset.map((item) => [item.asset, item._max.completedAt?.getTime() ?? 0]));
    const asset = [...assets].sort((a, b) => (latestMap.get(a) ?? 0) - (latestMap.get(b) ?? 0))[0];
    await markPipelineAttempt("backtest", `${asset}を検証中`);
    const result = await runBacktest({ asset, limit: 80, threshold: 0.55, initialCapital: 1_000 });
    if (result.status === "failed") throw new Error(result.error ?? `${asset} backtest failed`);
    await markPipelineSuccess("backtest", result.metrics?.observations ?? 0, `${asset} ${result.metrics?.markets ?? 0}市場`);
    console.log(JSON.stringify({ type: "scheduled-backtest", asset, metrics: result.metrics }));
  } catch (error) {
    await markPipelineError("backtest", error);
    console.error(error instanceof Error ? error.message : error);
  } finally {
    backtesting = false;
  }
}

await collectCycle();
void backtestCycle();
setInterval(() => void collectCycle(), collectIntervalMs);
setInterval(() => void backtestCycle(), backtestIntervalMs);
console.log(`monitoring worker: collection ${collectIntervalMs}ms / backtest ${backtestIntervalMs}ms`);
