import { prisma } from "@/src/lib/server/prisma";

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
  paper: { label: "Polymarket仮想運用", maximumAgeMs: 15 * 60 * 1_000 },
  "combined-shadow": { label: "組み合わせ市場確認", maximumAgeMs: 15 * 60 * 1_000 },
  backtest: { label: "モデル再検証", maximumAgeMs: 30 * 60 * 60 * 1_000 },
};

export async function collectOperationalAlertCandidates(now = new Date()) {
  const [heartbeats, run, latestSnapshot] = await Promise.all([
    prisma.pipelineHeartbeat.findMany(),
    prisma.combinedShadowRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.combinedShadowEquitySnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
  ]);
  const alerts = evaluatePipelineAlerts(heartbeats, now);

  const reconciliation = heartbeats.find((heartbeat) => heartbeat.id === "testnet-reconcile");
  if (reconciliation?.status === "error") {
    alerts.push({
      key: "testnet-reconciliation",
      severity: "critical",
      title: "テストネット照合エラー",
      message: reconciliation.message ?? "HyperliquidとDBの照合に失敗しました",
    });
  }

  if (run?.emergencyStopped || run?.riskStatus === "EMERGENCY_STOP") {
    alerts.push({
      key: "combined-emergency-stop",
      severity: "critical",
      title: "緊急停止中",
      message: "組み合わせ戦略の緊急停止が有効です",
    });
  } else if (run?.riskStatus === "RISK_PAUSED") {
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
    if (!lastSuccessAt || now.getTime() - lastSuccessAt > config.maximumAgeMs) {
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

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDuration(milliseconds: number) {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60}分` : `${minutes}分`;
}
