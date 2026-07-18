import { collectCryptoSnapshots, refreshPredictionMarketOutcomes } from "../src/lib/backtest/service";
import { getHyperliquidExecutionReadiness, reconcileHyperliquidTestnetOrders } from "../src/lib/combined-trading/hyperliquid-execution";
import { runModelEvaluation } from "../src/lib/model-evaluation/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";
import { collectHyperliquidSnapshots, fetchHyperliquidMarketStates } from "../src/lib/monitoring/hyperliquid";
import { prisma } from "../src/lib/server/prisma";

const collectIntervalMs = Math.max(60_000, Number(process.env.COLLECT_INTERVAL_MS ?? 60_000));
const outcomeRefreshIntervalMs = Math.max(60_000, Number(process.env.OUTCOME_REFRESH_INTERVAL_MS ?? 60_000));
const backtestIntervalMs = Math.max(60 * 60 * 1_000, Number(process.env.BACKTEST_INTERVAL_MS ?? 6 * 60 * 60 * 1_000));
let collecting = false;
let backtesting = false;
let lastOutcomeRefreshAt = 0;

async function collectCycle() {
  if (collecting) return;
  collecting = true;
  try {
    await markPipelineAttempt("polymarket", "公開市場を取得中");
    const sharedHyperliquidStates = await fetchHyperliquidMarketStates().catch(() => null);
    const [polymarket, hyperliquid] = await Promise.allSettled([
      collectCryptoSnapshots({ hyperliquidStates: sharedHyperliquidStates ?? undefined }),
      collectHyperliquidSnapshots(sharedHyperliquidStates ?? undefined),
    ]);
    if (polymarket.status === "fulfilled") {
      if (polymarket.value.saved > 0 && polymarket.value.synchronizationCoverage >= 0.5) {
        await markPipelineSuccess(
          "polymarket",
          polymarket.value.saved,
          `${polymarket.value.saved}市場 / 同期${polymarket.value.synchronized}件 (${Math.round(polymarket.value.synchronizationCoverage * 100)}%)`,
        );
      } else {
        await markPipelineError(
          "polymarket",
          new Error(`価格同期率が不足: ${polymarket.value.synchronized}/${polymarket.value.saved}市場`),
        );
      }
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
    if (Date.now() - lastOutcomeRefreshAt >= outcomeRefreshIntervalMs) {
      lastOutcomeRefreshAt = Date.now();
      try {
        const outcomes = await refreshPredictionMarketOutcomes({ limit: 80 });
        console.log(JSON.stringify({ type: "polymarket-outcomes", ...outcomes }));
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }
    const execution = getHyperliquidExecutionReadiness();
    if (execution.accountConfigured && execution.installed) {
      await markPipelineAttempt("testnet-reconcile", "テストネット口座を照合中");
      try {
        const reconciliation = await reconcileHyperliquidTestnetOrders();
        if (!reconciliation.safety.healthy) {
          throw new Error(`口座安全性: ${reconciliation.safety.issues.join(", ")}`);
        }
        if (reconciliation.orderMismatches.length) {
          throw new Error(`注文不一致: ${reconciliation.orderMismatches.map((item) => `${item.asset ?? "不明"} ${item.kind === "orphan" ? "取引所のみ" : "DBのみ"}`).join(", ")}`);
        }
        if (reconciliation.positionMismatches.length) {
          throw new Error(`ポジション不一致: ${reconciliation.positionMismatches.map((item) => `${item.asset} DB ${item.expectedSize} / 取引所 ${item.actualSize}`).join(", ")}`);
        }
        await markPipelineSuccess(
          "testnet-reconcile",
          reconciliation.checkedOrders,
          `注文${reconciliation.checkedOrders}件 / 未約定${reconciliation.openOrders.length}件 / 保有${reconciliation.positions.length}件を照合`,
        );
      } catch (error) {
        if (execution.ready && execution.autoMirrorEnabled) {
          await engageTestnetDeadman(error instanceof Error ? error.message : "testnet reconciliation failed");
        }
        await markPipelineError("testnet-reconcile", error);
      }
    }
  } finally {
    collecting = false;
  }
}

async function engageTestnetDeadman(reason: string) {
  await prisma.combinedShadowRun.updateMany({
    where: { status: "running" },
    data: { emergencyStopped: true, riskStatus: "EMERGENCY_STOP" },
  });
  console.error(`testnet deadman engaged: ${reason}`);
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
console.log(`monitoring worker: collection ${collectIntervalMs}ms / outcomes ${outcomeRefreshIntervalMs}ms / backtest ${backtestIntervalMs}ms`);
