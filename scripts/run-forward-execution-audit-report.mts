import { persistForwardExecutionAuditReport } from "../src/lib/realtime-market-data/execution-audit-report";
import { getMonitoringSnapshot } from "../src/lib/monitoring/service";
import { markPipelineAttempt, markPipelineError, markPipelineSuccess } from "../src/lib/monitoring/heartbeat";

const intervalMs = Math.max(60_000, Number(process.env.FORWARD_EXECUTION_AUDIT_REPORT_INTERVAL_MS ?? 5 * 60_000));
let exporting = false;

async function exportReport() {
  if (exporting) return;
  exporting = true;
  try {
    await markPipelineAttempt("forward-execution-audit-report", "前向き監査の結果を保存中");
    const snapshot = await getMonitoringSnapshot();
    const model = snapshot.combinedShadow.shortTermDirection;
    const audit = model.executionAudit;
    if (!audit) {
      await markPipelineSuccess("forward-execution-audit-report", 0, "前向き監査の開始待ち");
      return;
    }
    const result = await persistForwardExecutionAuditReport({
      generatedAt: snapshot.generatedAt,
      codeRevision: process.env.POLYMARKET_MODEL_REVISION?.trim() || null,
      cohort: {
        experimentKey: model.experimentKey,
        modelVersion: model.modelVersion,
        specificationHash: model.specificationHash,
        startedAt: model.startedAt,
      },
      audit,
      settlementResolution: model.settlementResolution,
      synchronizedQuality: snapshot.collection.synchronizedPrices.quality,
    });
    await markPipelineSuccess(
      "forward-execution-audit-report",
      result.independentEvents,
      result.written ? `${result.independentEvents}独立枠の監査結果を保存` : `${result.independentEvents}独立枠・変更なし`,
    );
    console.log(JSON.stringify({ type: "forward-execution-audit-report", ...result }));
  } catch (error) {
    await markPipelineError("forward-execution-audit-report", error);
    console.error(error instanceof Error ? error.message : error);
  } finally {
    exporting = false;
  }
}

await exportReport();
if (process.env.ONCE !== "1") setInterval(() => void exportReport(), intervalMs);
console.log(`forward execution audit reporter: every ${intervalMs}ms`);
