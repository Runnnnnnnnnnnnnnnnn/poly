import { collectCryptoSnapshots } from "../src/lib/backtest/service";
import { getHyperliquidExecutionReadiness, reconcileHyperliquidTestnetOrders } from "../src/lib/combined-trading/hyperliquid-execution";
import { runModelEvaluation } from "../src/lib/model-evaluation/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { collectHyperliquidSnapshots } from "../src/lib/monitoring/hyperliquid";
import { prisma } from "../src/lib/server/prisma";

const collectIntervalMs = Math.max(60_000, Number(process.env.COLLECT_INTERVAL_MS ?? 300_000));
const backtestIntervalMs = Math.max(60 * 60 * 1_000, Number(process.env.BACKTEST_INTERVAL_MS ?? 6 * 60 * 60 * 1_000));
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
    const execution = getHyperliquidExecutionReadiness();
    if (execution.accountConfigured && execution.installed) {
      await markPipelineAttempt("testnet-reconcile", "テストネット口座を照合中");
      try {
        const reconciliation = await reconcileHyperliquidTestnetOrders();
        await markPipelineSuccess(
          "testnet-reconcile",
          reconciliation.checkedOrders,
          `注文${reconciliation.checkedOrders}件 / 保有${reconciliation.positions.length}件を照合`,
        );
      } catch (error) {
        await markPipelineError("testnet-reconcile", error);
      }
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
    await markPipelineAttempt("backtest", "時系列ホールドアウトを検証中");
    const result = await runModelEvaluation();
    if (result.status === "failed") throw new Error(result.error ?? "model evaluation failed");
    await markPipelineSuccess("backtest", result.metrics?.dataset.testMarkets ?? 0, `${result.modelVersion} / テスト${result.metrics?.dataset.testMarkets ?? 0}市場`);
    console.log(JSON.stringify({ type: "scheduled-model-evaluation", modelVersion: result.modelVersion, metrics: result.metrics }));
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
