import { prisma } from "@/src/lib/server/prisma";
import { getHyperliquidExecutionReadiness } from "@/src/lib/combined-trading/hyperliquid-execution";
import { isForwardStrategyExperimentKey } from "@/src/lib/combined-trading/forward-evaluation";
import { isShortTermDirectionStrategyKey } from "@/src/lib/combined-trading/short-term-direction";
import type { CombinedShadowConfig } from "@/src/lib/combined-trading/service";
import { readBackupStatus } from "@/src/lib/monitoring/backup-status";
import { loadReferenceSettlementAudit, type ReferenceSettlementAudit } from "@/src/lib/realtime-market-data/settlement-audit";

export type OperationalAlertCandidate = {
  key: string;
  severity: "warning" | "critical";
  title: string;
  message: string;
};

type HeartbeatLike = {
  id: string;
  status: string;
  message: string | null;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
};

const pipelineLimitsMs: Record<string, { label: string; maximumAgeMs: number }> = {
  polymarket: { label: "Polymarket収集", maximumAgeMs: 15 * 60 * 1_000 },
  hyperliquid: { label: "相場データ収集", maximumAgeMs: 15 * 60 * 1_000 },
  "realtime-market-data": { label: "秒単位の板収集", maximumAgeMs: 30 * 1_000 },
  "forward-experiment": { label: "固定フォワード検証", maximumAgeMs: 15 * 60 * 1_000 },
  "short-term-direction": { label: "15分モデル検証", maximumAgeMs: 5 * 60 * 1_000 },
  "forward-execution-audit-report": { label: "前向き監査の保存", maximumAgeMs: 15 * 60 * 1_000 },
  "realtime-short-term-backtest": { label: "5秒板リプレイ", maximumAgeMs: 2 * 60 * 60 * 1_000 },
  backtest: { label: "モデル再検証", maximumAgeMs: 30 * 60 * 60 * 1_000 },
};

export async function collectOperationalAlertCandidates(now = new Date()) {
  const [heartbeats, runs, settlementResolution] = await Promise.all([
    prisma.pipelineHeartbeat.findMany(),
    prisma.combinedShadowRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    loadReferenceSettlementAudit(),
  ]);
  const strategyRuns = runs.filter((item) => (
    isForwardStrategyExperimentKey(parseJson<Partial<CombinedShadowConfig>>(item.configJson)?.experimentKey)
    || isShortTermDirectionStrategyKey(parseJson<Partial<CombinedShadowConfig>>(item.configJson)?.experimentKey)
  ));
  const activeRuns = strategyRuns.length
    ? strategyRuns
    : runs.filter((item) => parseJson<Partial<CombinedShadowConfig>>(item.configJson)?.forwardOnly === true).slice(0, 1);
  const activeRunIds = activeRuns.map((run) => run.id);
  const [latestSnapshot, settlementBasisRows] = activeRunIds.length
    ? await Promise.all([
        prisma.combinedShadowEquitySnapshot.findFirst({ where: { runId: { in: activeRunIds } }, orderBy: { capturedAt: "desc" } }),
        prisma.combinedShadowPosition.findMany({
          where: { runId: { in: activeRunIds }, status: "CLOSED", exitPriceBasisPct: { not: null } },
          select: { exitPriceBasisPct: true, exitReferenceCapturedAt: true, closedAt: true },
          orderBy: { closedAt: "desc" },
          take: 50,
        }),
      ])
    : [null, []];
  const alerts = evaluatePipelineAlerts(heartbeats, now);
  alerts.push(...evaluateSettlementBasisAlerts(settlementBasisRows));
  alerts.push(...evaluateSettlementResolutionAlerts(settlementResolution));

  const backup = readBackupStatus(now);
  if (backup.status !== "healthy") {
    alerts.push({
      key: "backup-integrity",
      severity: backup.status === "error" ? "critical" : "warning",
      title: backup.status === "error" ? "バックアップ復元確認エラー" : "バックアップ復元確認待ち",
      message: backup.message,
    });
  }

  const reconciliation = heartbeats.find((heartbeat) => heartbeat.id === "testnet-reconcile");
  alerts.push(...evaluateTestnetReconciliationAlerts(
    reconciliation,
    now,
    getHyperliquidExecutionReadiness().accountConfigured,
  ));

  if (activeRuns.some((run) => run.emergencyStopped || run.riskStatus === "EMERGENCY_STOP")) {
    alerts.push({
      key: "combined-emergency-stop",
      severity: "critical",
      title: "緊急停止中",
      message: "組み合わせ戦略の緊急停止が有効です",
    });
  } else if (activeRuns.some((run) => run.riskStatus === "RISK_PAUSED")) {
    alerts.push({
      key: "combined-risk-paused",
      severity: "critical",
      title: "損失上限で停止",
      message: "組み合わせ戦略が損失制限により停止しました",
    });
  }

  const drawdownWarningPct = boundedNumber(process.env.ALERT_DRAWDOWN_WARNING_PCT, 0.03, 0.001, 0.2);
  if ((latestSnapshot?.drawdownPct ?? 0) >= drawdownWarningPct) {
    alerts.push({
      key: "combined-drawdown",
      severity: (latestSnapshot?.drawdownPct ?? 0) >= 0.05 ? "critical" : "warning",
      title: "最大下落を検知",
      message: `現在の最大下落は${formatPct(latestSnapshot?.drawdownPct ?? 0)}です`,
    });
  }

  return alerts;
}

export function evaluateSettlementResolutionAlerts(audit: Pick<
  ReferenceSettlementAudit,
  "completeMarkets" | "mismatchedMarkets" | "missingBoundaryMarkets" | "coverage" | "maximumBoundaryErrorMs" | "allowedBoundaryErrorMs"
>) {
  if (audit.mismatchedMarkets > 0) {
    return [{
      key: "settlement-resolution-mismatch",
      severity: "critical" as const,
      title: "正式決着との不一致を検知",
      message: `Chainlinkの開始・終了価格から再計算した方向とPolymarket正式決着が${audit.mismatchedMarkets}市場で一致しません`,
    }];
  }
  if (audit.completeMarkets < 10) return [];
  if (audit.coverage >= 0.95
    && (audit.maximumBoundaryErrorMs ?? Number.POSITIVE_INFINITY) <= audit.allowedBoundaryErrorMs) return [];
  return [{
    key: "settlement-resolution-coverage",
    severity: "warning" as const,
    title: "決着境界価格の取得不足",
    message: `完全取得${audit.completeMarkets}市場、欠測${audit.missingBoundaryMarkets}市場、取得率${formatPct(audit.coverage)}です`,
  }];
}

function parseJson<T>(value: string) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function evaluateSettlementBasisAlerts(rows: Array<{
  exitPriceBasisPct: number | null;
  exitReferenceCapturedAt: Date | null;
  closedAt: Date | null;
}>) {
  const measured = rows.filter((row) => typeof row.exitPriceBasisPct === "number");
  if (measured.length < 10) return [];
  const medianAbsoluteBasis = median(measured.map((row) => Math.abs(row.exitPriceBasisPct as number)));
  const captureLags = measured.flatMap((row) => row.closedAt && row.exitReferenceCapturedAt
    ? [Math.abs(row.closedAt.getTime() - row.exitReferenceCapturedAt.getTime()) / 1_000]
    : []);
  const medianCaptureLagSeconds = median(captureLags);
  const timingComplete = captureLags.length === measured.length;
  if ((medianAbsoluteBasis ?? 0) <= 0.001 && timingComplete && (medianCaptureLagSeconds ?? Number.POSITIVE_INFINITY) <= 60) return [];
  return [{
    key: "settlement-reference-basis",
    severity: (medianAbsoluteBasis ?? 0) > 0.003 || (medianCaptureLagSeconds ?? 0) > 300 ? "critical" as const : "warning" as const,
    title: "判定参照価格とのずれを検知",
    message: `直近${measured.length}件の中央値は${formatBasisPoints(medianAbsoluteBasis)}、取得時刻のずれは${timingComplete ? formatDuration((medianCaptureLagSeconds ?? 0) * 1_000) : "未計測"}です`,
  }];
}

export function evaluatePipelineAlerts(heartbeats: HeartbeatLike[], now: Date) {
  const alerts: OperationalAlertCandidate[] = [];
  const byId = new Map(heartbeats.map((heartbeat) => [heartbeat.id, heartbeat]));
  for (const [id, config] of Object.entries(pipelineLimitsMs)) {
    const heartbeat = byId.get(id);
    if (!heartbeat) {
      alerts.push({
        key: `pipeline-missing:${id}`,
        severity: "critical",
        title: `${config.label}が未起動`,
        message: "稼働記録がありません",
      });
      continue;
    }
    if (heartbeat.status === "error") {
      alerts.push({
        key: `pipeline-error:${id}`,
        severity: "critical",
        title: `${config.label}でエラー`,
        message: heartbeat.message ?? "処理に失敗しました",
      });
      continue;
    }
    const lastSuccessAt = heartbeat.lastSuccessAt?.getTime() ?? 0;
    const lastAttemptAt = heartbeat.lastAttemptAt?.getTime() ?? 0;
    const latestActivityAt = Math.max(lastSuccessAt, lastAttemptAt);
    if (!latestActivityAt || now.getTime() - latestActivityAt > config.maximumAgeMs) {
      alerts.push({
        key: `pipeline-stale:${id}`,
        severity: "critical",
        title: `${config.label}が停止`,
        message: heartbeat.lastSuccessAt
          ? `${formatDuration(now.getTime() - lastSuccessAt)}更新されていません`
          : "正常終了の記録がありません",
      });
    }
  }
  return alerts;
}

export function evaluateTestnetReconciliationAlerts(
  heartbeat: HeartbeatLike | undefined,
  now: Date,
  required: boolean,
) {
  if (!required) return [];
  if (!heartbeat) {
    return [{
      key: "testnet-reconciliation",
      severity: "critical" as const,
      title: "テストネット照合が未起動",
      message: "口座設定後の照合記録がありません",
    }];
  }
  if (heartbeat.status === "error") {
    return [{
      key: "testnet-reconciliation",
      severity: "critical" as const,
      title: "テストネット照合エラー",
      message: heartbeat.message ?? "HyperliquidとDBの照合に失敗しました",
    }];
  }
  const latestActivityAt = Math.max(
    heartbeat.lastSuccessAt?.getTime() ?? 0,
    heartbeat.lastAttemptAt?.getTime() ?? 0,
  );
  if (!latestActivityAt || now.getTime() - latestActivityAt > 5 * 60 * 1_000) {
    return [{
      key: "testnet-reconciliation",
      severity: "critical" as const,
      title: "テストネット照合が停止",
      message: heartbeat.lastSuccessAt
        ? `${formatDuration(now.getTime() - heartbeat.lastSuccessAt.getTime())}正常照合されていません`
        : "正常照合の記録がありません",
    }];
  }
  return [];
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 60_000) return `${Math.max(0, Math.round(milliseconds / 1_000))}秒`;
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60}分` : `${minutes}分`;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatBasisPoints(value: number | null) {
  return value === null ? "未計測" : `${(value * 10_000).toFixed(1)}bp`;
}
