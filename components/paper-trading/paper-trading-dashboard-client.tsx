"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Database,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingDown,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  discoverLiveApiBase,
  fetchLiveDashboardSnapshot,
  fetchLocalApi,
} from "@/src/lib/localApiClient";

type DashboardView = "operations" | "wallets" | "hyperliquid";

type Gate = {
  id: string;
  label: string;
  passed: boolean;
  value?: number | null;
  threshold?: number | null;
};

type PublicDashboard = {
  generatedAt: string | null;
  monitoring?: {
    generatedAt?: string;
    status?: string;
    collection?: {
      latestAt?: string | null;
      totalRecords?: number;
    };
    combinedShadow?: {
      shortTermDirection?: {
        status?: string;
        netReturnPct?: number;
        excessReturnPct?: number;
        maxDrawdownPct?: number;
        executionAudit?: {
          verifiedIndependentEvents?: number;
          predictionAccuracy?: number | null;
          portfolioNetReturnPct?: number;
          excessReturnPct?: number;
          maxDrawdownPct?: number;
          excessConfidenceInterval95?: [number, number] | null;
          deflatedSharpeProbability?: number | null;
          readinessGates?: Array<Gate & { state?: string }>;
          passedReadinessGates?: number;
          totalReadinessGates?: number;
          collectionStartedAt?: string | null;
          strategyTrials?: number;
        };
      };
    };
  };
  dataQuality?: {
    status?: string;
    source?: string;
    code?: string;
    gaps?: Array<{
      startedAt: string;
      endedAt?: string | null;
      scope: string;
      reason: string;
    }>;
  };
};

type WalletProfile = {
  address: string;
  displayName: string | null;
  style: string;
  copyabilityScore: number;
  excluded: boolean;
  exclusionReason: string | null;
  currentPositions?: number;
  currentValue?: number;
  activityCount?: number;
  latestActivityAt?: string | null;
  scoredAt: string | null;
  scores: Array<{
    category: string;
    realizedPnl: number;
    independentEvents: number;
    activeDays: number;
    winRate: number | null;
    riskAdjustedScore: number;
    qualified: boolean;
  }>;
};

type WalletSignal = {
  id: string;
  title?: string | null;
  category: string;
  outcome: string;
  contributorCount: number;
  status: string;
  observedAt: string;
};

type WalletDashboard = {
  generatedAt: string | null;
  summary: {
    trackedWallets: number;
    qualifiedWallets: number;
    readySignals: number;
    status: string;
    lastUpdatedAt: string | null;
  };
  profiles: WalletProfile[];
  signals: WalletSignal[];
};

type BacktestReport = {
  latencySeconds: number;
  status: string;
  edgeConfirmed: boolean;
  reason: string;
  signals: number;
  independentEvents: number;
  winRate: number | null;
  meanReturnPct: number;
  excessReturnPct: number;
  excessConfidenceInterval95: [number, number] | null;
  deflatedSharpeProbability: number | null;
  maxDrawdownPct: number;
  gates: Gate[];
};

type WalletBacktest = {
  generatedAt: string | null;
  status: string;
  edgeConfirmed: boolean;
  reason: string;
  selectedLatencySeconds: number;
  reports: BacktestReport[];
};

type HorizonResult = {
  horizonSeconds: number;
  selectedModel: string;
  selectedThreshold: number;
  edgeConfirmed: boolean;
  dataset: {
    samples: number;
    train: number;
    validation: number;
    holdout: number;
    firstAt: string | null;
    lastAt: string | null;
  };
  holdout: {
    independentWindows: number;
    trades: number;
    longTrades: number;
    shortTrades: number;
    winRate: number | null;
    netReturnPct: number;
    excessReturnPct: number;
    excessConfidenceInterval95: [number, number] | null;
    deflatedSharpeProbability: number | null;
    maxDrawdownPct: number;
  };
  gates: Gate[];
};

type HyperliquidModel = {
  generatedAt: string | null;
  modelVersion?: string;
  status: string;
  edgeConfirmed: boolean;
  verdict: string;
  reason: string;
  data?: {
    l1Rows?: number;
    l2Rows?: number;
    tradeRows?: number;
    walletSignals?: number;
    l2Coverage?: number;
    l2DurationHours?: number;
    mode?: string;
  };
  selectedHorizonSeconds?: number;
  selected?: HorizonResult;
  horizons?: HorizonResult[];
  methodology?: Record<string, unknown>;
};

const EMPTY_WALLETS: WalletDashboard = {
  generatedAt: null,
  summary: {
    trackedWallets: 0,
    qualifiedWallets: 0,
    readySignals: 0,
    status: "waiting",
    lastUpdatedAt: null,
  },
  profiles: [],
  signals: [],
};

const EMPTY_WALLET_BACKTEST: WalletBacktest = {
  generatedAt: null,
  status: "collecting",
  edgeConfirmed: false,
  reason: "検証データを収集中です",
  selectedLatencySeconds: 30,
  reports: [],
};

const EMPTY_HYPERLIQUID: HyperliquidModel = {
  generatedAt: null,
  status: "collecting",
  edgeConfirmed: false,
  verdict: "優位性未確認",
  reason: "モデル検証を準備中です",
};

const views: Array<{ id: DashboardView; label: string; shortLabel: string; icon: LucideIcon }> = [
  { id: "operations", label: "運用状況", shortLabel: "運用", icon: Activity },
  { id: "wallets", label: "優良ウォレット", shortLabel: "ウォレット", icon: Users },
  { id: "hyperliquid", label: "Hyperliquidモデル", shortLabel: "モデル", icon: BarChart3 },
];

export function PaperTradingDashboardClient() {
  const [view, setView] = useState<DashboardView>("operations");
  const [dashboard, setDashboard] = useState<PublicDashboard | null>(null);
  const [wallets, setWallets] = useState<WalletDashboard>(EMPTY_WALLETS);
  const [walletBacktest, setWalletBacktest] = useState<WalletBacktest>(EMPTY_WALLET_BACKTEST);
  const [hyperliquid, setHyperliquid] = useState<HyperliquidModel>(EMPTY_HYPERLIQUID);
  const [source, setSource] = useState<"live" | "snapshot" | "loading">("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    await discoverLiveApiBase();

    const live = await Promise.allSettled([
      fetchLocalApi<PublicDashboard>("/api/public-dashboard"),
      fetchLocalApi<WalletDashboard>("/api/wallets"),
      fetchLocalApi<WalletBacktest>("/api/wallet-backtests/latest"),
      fetchLocalApi<HyperliquidModel>("/api/hyperliquid-model/latest"),
    ]);

    if (live[0].status === "fulfilled") {
      setDashboard(live[0].value);
      if (live[1].status === "fulfilled") setWallets(live[1].value);
      if (live[2].status === "fulfilled") setWalletBacktest(live[2].value);
      if (live[3].status === "fulfilled") setHyperliquid(live[3].value);
      setSource("live");
      setRefreshing(false);
      return;
    }

    const staticBase = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const [published, walletArtifact, hyperArtifact] = await Promise.all([
      fetchLiveDashboardSnapshot<PublicDashboard>().catch(() => fetchStatic<PublicDashboard>(`${staticBase}/monitoring-snapshot.json`).then((monitoring) => ({
        generatedAt: monitoring.generatedAt ?? null,
        monitoring: monitoring as PublicDashboard["monitoring"],
        dataQuality: {
          status: "stopped",
          source: "static-snapshot",
          gaps: [],
        },
      }))),
      fetchStatic<WalletBacktest>(`${staticBase}/wallet-backtest.json`).catch(() => EMPTY_WALLET_BACKTEST),
      fetchStatic<HyperliquidModel>(`${staticBase}/hyperliquid-model.json`).catch(() => EMPTY_HYPERLIQUID),
    ]);
    setDashboard(published);
    setWalletBacktest(walletArtifact);
    setHyperliquid(hyperArtifact);
    setSource("snapshot");
    setError("現在は保存済みの最新結果を表示しています");
    setRefreshing(false);
  }, []);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    if (requested === "wallets" || requested === "hyperliquid" || requested === "operations") {
      setView(requested);
    }
    void load();
  }, [load]);

  const switchView = (next: DashboardView) => {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState({}, "", url);
  };

  return (
    <div className="space-y-5 md:space-y-7">
      <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mb-1 text-sm font-semibold text-emerald-700">モデル検証・模擬取引</p>
          <h1 className="text-2xl font-bold tracking-normal text-slate-950 md:text-3xl">予測モデル監視</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 md:text-base">
            Polymarketの取引行動とHyperliquidの板情報から、手数料後に利益が残るかを継続検証しています。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DataStatus source={source} generatedAt={dashboard?.generatedAt ?? hyperliquid.generatedAt} />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0 bg-white"
            onClick={() => void load()}
            disabled={refreshing}
            title="最新データに更新"
            aria-label="最新データに更新"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </Button>
        </div>
      </header>

      <nav
        className="grid grid-cols-3 rounded-md border border-slate-200 bg-white p-1"
        aria-label="モデル監視画面"
      >
        {views.map((item) => {
          const Icon = item.icon;
          const active = view === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => switchView(item.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center justify-center gap-2 rounded px-2 text-xs font-bold transition-colors sm:text-sm",
                active ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">{item.label}</span>
              <span className="sm:hidden">{item.shortLabel}</span>
            </button>
          );
        })}
      </nav>

      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {view === "operations" ? (
        <OperationsView dashboard={dashboard} walletBacktest={walletBacktest} hyperliquid={hyperliquid} />
      ) : null}
      {view === "wallets" ? (
        <WalletsView wallets={wallets} backtest={walletBacktest} source={source} />
      ) : null}
      {view === "hyperliquid" ? <HyperliquidView model={hyperliquid} /> : null}
    </div>
  );
}

function OperationsView({
  dashboard,
  walletBacktest,
  hyperliquid,
}: {
  dashboard: PublicDashboard | null;
  walletBacktest: WalletBacktest;
  hyperliquid: HyperliquidModel;
}) {
  const audit = dashboard?.monitoring?.combinedShadow?.shortTermDirection?.executionAudit;
  const strategy = dashboard?.monitoring?.combinedShadow?.shortTermDirection;
  const pnl = audit?.portfolioNetReturnPct ?? strategy?.netReturnPct ?? null;
  const excess = audit?.excessReturnPct ?? strategy?.excessReturnPct ?? null;
  const drawdown = audit?.maxDrawdownPct ?? strategy?.maxDrawdownPct ?? null;
  const independentEvents = audit?.verifiedIndependentEvents ?? 0;
  const verifiedEdge = Boolean(
    pnl !== null
    && excess !== null
    && pnl > 0
    && excess > 0
    && (audit?.excessConfidenceInterval95?.[0] ?? -1) > 0
    && (audit?.deflatedSharpeProbability ?? 0) >= 0.95,
  );
  const period = formatPeriod(audit?.collectionStartedAt ?? null, dashboard?.monitoring?.generatedAt ?? dashboard?.generatedAt);
  const gaps = dashboard?.dataQuality?.gaps ?? [];

  return (
    <div className="space-y-5">
      <section className={cn(
        "border-l-4 bg-white px-5 py-5 shadow-sm md:px-6",
        verifiedEdge ? "border-emerald-500" : "border-amber-500",
      )}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-bold text-slate-500">現在の判定</p>
            <div className="mt-1 flex items-center gap-3">
              {verifiedEdge ? (
                <ShieldCheck className="h-8 w-8 text-emerald-600" />
              ) : (
                <AlertTriangle className="h-8 w-8 text-amber-600" />
              )}
              <p className="text-3xl font-bold tracking-normal text-slate-950">
                {verifiedEdge ? "優位性あり" : "優位性未確認"}
              </p>
            </div>
          </div>
          <p className="max-w-xl text-sm leading-6 text-slate-600">
            {verifiedEdge
              ? "市場平均との差と統計基準を満たしました。模擬取引で再現性を監視しています。"
              : independentEvents > 0
                ? `独立した${formatNumber(independentEvents)}期間を監査しましたが、手数料後の利益は確認できていません。`
                : "前向きデータを収集中です。合格条件を満たすまで実取引には移行しません。"}
          </p>
        </div>
      </section>

      <section className="grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          label="累積損益"
          value={formatPercent(pnl)}
          note="手数料・スプレッド控除後"
          tone={toneForNumber(pnl)}
          icon={CircleDollarSign}
        />
        <Metric
          label="市場平均との差"
          value={formatPercent(excess)}
          note="現金待機との比較"
          tone={toneForNumber(excess)}
          icon={Target}
        />
        <Metric
          label="最大損失"
          value={formatPercent(drawdown === null ? null : -Math.abs(drawdown))}
          note="最大ドローダウン"
          tone="negative"
          icon={TrendingDown}
        />
        <Metric
          label="検証期間"
          value={period}
          note={`${formatNumber(independentEvents)} 独立期間`}
          tone="neutral"
          icon={Clock3}
        />
        <Metric
          label="データ状態"
          value={gaps.length > 0 ? "欠損あり" : dashboard ? "収集中" : "確認中"}
          note={gaps.length > 0 ? "欠損期間は検証から除外" : "継続監視"}
          tone={gaps.length > 0 ? "warning" : "neutral"}
          icon={Database}
        />
      </section>

      <section className="bg-white px-5 py-5 shadow-sm ring-1 ring-slate-200 md:px-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-950">モデル開発の進捗</h2>
            <p className="mt-1 text-sm text-slate-500">データ収集から合格判定までを自動で繰り返します</p>
          </div>
          <span className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-900">実取引 OFF</span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <ProgressStep
            number="1"
            title="データ収集"
            status={gaps.length > 0 ? "要確認" : "稼働中"}
            value={dashboard?.monitoring?.collection?.totalRecords ?? 0}
            valueLabel="価格データ"
            tone={gaps.length > 0 ? "warning" : "active"}
          />
          <ProgressStep
            number="2"
            title="バックテスト"
            status="検証中"
            value={independentEvents}
            valueLabel="独立期間"
            tone="active"
          />
          <ProgressStep
            number="3"
            title="合格判定"
            status={verifiedEdge ? "合格" : "不合格"}
            value={audit?.passedReadinessGates ?? 0}
            valueLabel={`${audit?.totalReadinessGates ?? 0} 基準中`}
            tone={verifiedEdge ? "passed" : "failed"}
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <ModelSummary
          title="Polymarketウォレット"
          icon={Users}
          verdict={walletBacktest.edgeConfirmed ? "優位性あり" : "収集中"}
          reason={walletBacktest.reason}
          progress={Math.min(100, ((walletBacktest.reports[0]?.independentEvents ?? 0) / 50) * 100)}
          stat={`${walletBacktest.reports[0]?.independentEvents ?? 0} / 50 イベント`}
        />
        <ModelSummary
          title="Hyperliquid板モデル"
          icon={BarChart3}
          verdict={hyperliquid.edgeConfirmed ? "優位性あり" : "優位性未確認"}
          reason={hyperliquid.reason}
          progress={Math.min(100, ((hyperliquid.data?.l2DurationHours ?? 0) / 72) * 100)}
          stat={`${formatNumber(hyperliquid.data?.l2DurationHours ?? 0, 1)} / 72 時間`}
        />
      </section>

      {gaps.length > 0 ? (
        <details className="group rounded-md border border-amber-200 bg-amber-50">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-sm font-bold text-amber-950">
            データ欠損の詳細
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-amber-200 px-4 py-4 text-sm text-amber-900">
            {gaps.map((gap) => (
              <div key={`${gap.scope}-${gap.startedAt}`} className="grid gap-1">
                <span className="font-bold">{gap.scope}</span>
                <span>{formatDateTime(gap.startedAt)} から {gap.endedAt ? formatDateTime(gap.endedAt) : "停止中"}</span>
                <span>{gap.reason}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function WalletsView({
  wallets,
  backtest,
  source,
}: {
  wallets: WalletDashboard;
  backtest: WalletBacktest;
  source: "live" | "snapshot" | "loading";
}) {
  const report = backtest.reports.find((item) => item.latencySeconds === backtest.selectedLatencySeconds)
    ?? backtest.reports[0];
  const visibleProfiles = wallets.profiles
    .filter((profile) => !profile.excluded)
    .sort((left, right) => right.copyabilityScore - left.copyabilityScore)
    .slice(0, 6);

  return (
    <div className="space-y-5">
      <section className="grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="追跡中" value={formatNumber(wallets.summary.trackedWallets)} note="上位アドレス" icon={Users} tone="neutral" />
        <Metric label="追随候補" value={formatNumber(wallets.summary.qualifiedWallets)} note="裁定・両建て型を除外" icon={ShieldCheck} tone="positive" />
        <Metric label="合意シグナル" value={formatNumber(wallets.summary.readySignals)} note="複数口座が同方向" icon={Target} tone="neutral" />
        <Metric
          label="検証済み"
          value={`${report?.independentEvents ?? 0} / 50`}
          note={`${backtest.selectedLatencySeconds}秒後に模擬約定`}
          icon={Clock3}
          tone="warning"
        />
      </section>

      <section className="border-l-4 border-amber-500 bg-white px-5 py-5 shadow-sm md:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-bold text-slate-500">ウォレット戦略の判定</p>
            <p className="mt-1 text-2xl font-bold text-slate-950">
              {backtest.edgeConfirmed ? "優位性あり" : report ? "検証中" : "データ収集中"}
            </p>
          </div>
          <p className="max-w-lg text-sm leading-6 text-slate-600">{backtest.reason}</p>
        </div>
        <ProgressBar value={Math.min(100, ((report?.independentEvents ?? 0) / 50) * 100)} className="mt-4" />
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold text-slate-950">追随候補</h2>
          <p className="mt-1 text-sm text-slate-500">過去利益だけでなく、継続性と実際に追随できるかで並べています</p>
        </div>
        {source !== "live" ? (
          <EmptyState
            icon={Database}
            title="アドレス一覧はライブ接続時に表示"
            body="公開画面では、個人データを含まない保存済みのバックテスト結果を表示しています。"
          />
        ) : visibleProfiles.length === 0 ? (
          <EmptyState
            icon={Clock3}
            title="追随候補を採点中"
            body="最初の採点後に発生した取引だけを使うため、未来情報は参照していません。"
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {visibleProfiles.map((profile) => {
              const best = [...profile.scores].sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore)[0];
              return (
                <article key={profile.address} className="min-w-0 overflow-hidden bg-white p-5 shadow-sm ring-1 ring-slate-200">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-bold text-slate-950">
                        {walletName(profile)}
                      </h3>
                      <p className="mt-1 text-xs text-slate-500">{shortAddress(profile.address)}</p>
                    </div>
                    <span className="rounded bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800">
                      {categoryLabel(best?.category)}
                    </span>
                  </div>
                  <div className="mt-5 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold text-slate-500">追随しやすさ</p>
                      <p className="mt-1 text-3xl font-bold text-slate-950">{Math.round(profile.copyabilityScore)}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-5 text-right">
                      <SmallStat label="過去勝率" value={formatPercent(best?.winRate ?? null)} />
                      <SmallStat label="独立市場" value={formatNumber(best?.independentEvents ?? 0)} />
                    </div>
                  </div>
                  <ProgressBar value={profile.copyabilityScore} className="mt-4" tone="emerald" />
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold text-slate-950">現在の合意</h2>
          <p className="mt-1 text-sm text-slate-500">追随候補が同じ市場・同じ方向へ増やしたポジション</p>
        </div>
        {wallets.signals.length === 0 ? (
          <EmptyState icon={Target} title="合意シグナルはまだありません" body="条件を満たさない単独取引は表示しません。" />
        ) : (
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            {wallets.signals.slice(0, 10).map((signal) => (
              <div key={signal.id} className="grid gap-2 border-b border-slate-100 px-4 py-4 last:border-0 sm:grid-cols-[1fr_auto] sm:items-center">
                <div>
                  <p className="font-bold text-slate-950">{signal.title || "市場タイトルを取得中"}</p>
                  <p className="mt-1 text-sm text-slate-500">
                    {categoryLabel(signal.category)}・{formatNumber(signal.contributorCount)}口座が合意
                  </p>
                </div>
                <span className={cn(
                  "w-fit rounded px-3 py-1 text-sm font-bold",
                  signal.outcome === "YES" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800",
                )}>
                  {signal.outcome}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {report ? <GateDetails title="ウォレット戦略の合格条件" gates={report.gates} /> : null}
    </div>
  );
}

function HyperliquidView({ model }: { model: HyperliquidModel }) {
  const selected = model.selected;
  const holdout = selected?.holdout;
  const l2Hours = model.data?.l2DurationHours ?? 0;
  const l2Progress = Math.min(100, (l2Hours / 72) * 100);

  return (
    <div className="space-y-5">
      <section className={cn(
        "border-l-4 bg-white px-5 py-5 shadow-sm md:px-6",
        model.edgeConfirmed ? "border-emerald-500" : "border-amber-500",
      )}>
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <p className="text-sm font-bold text-slate-500">Hyperliquidモデルの判定</p>
            <div className="mt-1 flex items-center gap-3">
              {model.edgeConfirmed ? (
                <ShieldCheck className="h-8 w-8 text-emerald-600" />
              ) : (
                <AlertTriangle className="h-8 w-8 text-amber-600" />
              )}
              <p className="text-3xl font-bold text-slate-950">{model.verdict}</p>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{model.reason}</p>
          </div>
          <div className="min-w-52">
            <div className="flex items-center justify-between text-sm font-bold text-slate-700">
              <span>L2板の収集</span>
              <span>{formatNumber(l2Hours, 1)} / 72時間</span>
            </div>
            <ProgressBar value={l2Progress} className="mt-2" />
          </div>
        </div>
      </section>

      <section className="grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="平均損益 / 取引"
          value={formatPercent(holdout?.netReturnPct ?? null, 3)}
          note="手数料・スプレッド控除後"
          icon={CircleDollarSign}
          tone={toneForNumber(holdout?.netReturnPct ?? null)}
        />
        <Metric
          label="的中率"
          value={formatPercent(holdout?.winRate ?? null, 1)}
          note="利益とは一致しません"
          icon={Target}
          tone="neutral"
        />
        <Metric
          label="未使用データ検証"
          value={formatNumber(holdout?.independentWindows ?? 0)}
          note="独立時間枠"
          icon={ShieldCheck}
          tone="neutral"
        />
        <Metric
          label="最大損失"
          value={formatPercent(holdout ? -Math.abs(holdout.maxDrawdownPct) : null, 1)}
          note="連続売買を複利計算"
          icon={TrendingDown}
          tone="negative"
        />
      </section>

      {holdout && (holdout.winRate ?? 0) > 0.5 && holdout.netReturnPct < 0 ? (
        <div className="flex items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-4 text-rose-950">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-bold">当たっていても利益は残っていません</p>
            <p className="mt-1 text-sm leading-6">
              的中率は{formatPercent(holdout.winRate, 1)}ですが、売買コスト控除後は1取引平均
              {formatPercent(holdout.netReturnPct, 3)}です。現行モデルは不採用です。
            </p>
          </div>
        </div>
      ) : null}

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold text-slate-950">時間軸ごとの結果</h2>
          <p className="mt-1 text-sm text-slate-500">学習に使っていない最後の期間だけを比較</p>
        </div>
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="hidden grid-cols-[0.7fr_1.5fr_1fr_1fr_1fr] gap-3 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-500 md:grid">
            <span>予測時間</span>
            <span>モデル</span>
            <span>取引数</span>
            <span>的中率</span>
            <span>平均損益</span>
          </div>
          {(model.horizons ?? []).map((horizon) => (
            <div
              key={horizon.horizonSeconds}
              className={cn(
                "grid gap-3 border-t border-slate-100 px-4 py-4 first:border-t-0 md:grid-cols-[0.7fr_1.5fr_1fr_1fr_1fr] md:items-center",
                horizon.horizonSeconds === model.selectedHorizonSeconds && "bg-emerald-50/60",
              )}
            >
              <div className="flex items-center justify-between md:block">
                <span className="text-xs font-bold text-slate-500 md:hidden">予測時間</span>
                <span className="font-bold text-slate-950">{formatHorizon(horizon.horizonSeconds)}</span>
              </div>
              <div className="flex items-center justify-between md:block">
                <span className="text-xs font-bold text-slate-500 md:hidden">モデル</span>
                <span className="text-sm text-slate-700">{modelLabel(horizon.selectedModel)}</span>
              </div>
              <ResultCell label="取引数" value={formatNumber(horizon.holdout.trades)} />
              <ResultCell label="的中率" value={formatPercent(horizon.holdout.winRate, 1)} />
              <ResultCell
                label="平均損益"
                value={formatPercent(horizon.holdout.netReturnPct, 3)}
                tone={toneForNumber(horizon.holdout.netReturnPct)}
              />
            </div>
          ))}
          {(model.horizons ?? []).length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">初回バックテストを準備中です</div>
          ) : null}
        </div>
      </section>

      {selected ? <GateDetails title="採用するための合格条件" gates={selected.gates} /> : null}

      <details className="group rounded-md border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 text-sm font-bold text-slate-950">
          データと試験条件
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t border-slate-200 px-4 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <SmallStat label="L1価格" value={formatNumber(model.data?.l1Rows ?? 0)} />
          <SmallStat label="L2板" value={formatNumber(model.data?.l2Rows ?? 0)} />
          <SmallStat label="約定データ" value={formatNumber(model.data?.tradeRows ?? 0)} />
          <SmallStat label="ウォレット合意" value={formatNumber(model.data?.walletSignals ?? 0)} />
          <SmallStat label="学習" value={formatNumber(selected?.dataset.train ?? 0)} />
          <SmallStat label="モデル選定" value={formatNumber(selected?.dataset.validation ?? 0)} />
          <SmallStat label="最終検証" value={formatNumber(selected?.dataset.holdout ?? 0)} />
          <SmallStat label="モデル版" value={model.modelVersion ?? "準備中"} />
        </div>
      </details>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  icon: LucideIcon;
  tone: "positive" | "negative" | "warning" | "neutral";
}) {
  return (
    <article className="min-h-36 bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-bold text-slate-500">{label}</p>
        <Icon className={cn(
          "h-5 w-5",
          tone === "positive" && "text-emerald-600",
          tone === "negative" && "text-rose-600",
          tone === "warning" && "text-amber-600",
          tone === "neutral" && "text-slate-400",
        )} />
      </div>
      <p className={cn(
        "mt-4 break-words text-2xl font-bold tracking-normal sm:text-3xl",
        tone === "positive" && "text-emerald-700",
        tone === "negative" && "text-rose-700",
        tone === "warning" && "text-amber-700",
        tone === "neutral" && "text-slate-950",
      )}>
        {value}
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{note}</p>
    </article>
  );
}

function ProgressStep({
  number,
  title,
  status,
  value,
  valueLabel,
  tone,
}: {
  number: string;
  title: string;
  status: string;
  value: number;
  valueLabel: string;
  tone: "active" | "passed" | "failed" | "warning";
}) {
  return (
    <article className="border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold",
            tone === "passed" && "bg-emerald-600 text-white",
            tone === "failed" && "bg-rose-100 text-rose-700",
            tone === "active" && "bg-slate-950 text-white",
            tone === "warning" && "bg-amber-100 text-amber-800",
          )}>{number}</span>
          <h3 className="font-bold text-slate-950">{title}</h3>
        </div>
        <span className={cn(
          "text-xs font-bold",
          tone === "passed" && "text-emerald-700",
          tone === "failed" && "text-rose-700",
          tone === "active" && "text-slate-600",
          tone === "warning" && "text-amber-700",
        )}>{status}</span>
      </div>
      <p className="mt-5 text-2xl font-bold text-slate-950">{formatNumber(value)}</p>
      <p className="mt-1 text-xs text-slate-500">{valueLabel}</p>
    </article>
  );
}

function ModelSummary({
  title,
  icon: Icon,
  verdict,
  reason,
  progress,
  stat,
}: {
  title: string;
  icon: LucideIcon;
  verdict: string;
  reason: string;
  progress: number;
  stat: string;
}) {
  return (
    <article className="bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded bg-slate-100 text-slate-700">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-bold text-slate-950">{title}</h3>
          <p className="text-sm font-bold text-amber-700">{verdict}</p>
        </div>
      </div>
      <p className="mt-4 min-h-12 text-sm leading-6 text-slate-600">{reason}</p>
      <div className="mt-4 flex items-center justify-between text-xs font-bold text-slate-500">
        <span>必要データ</span>
        <span>{stat}</span>
      </div>
      <ProgressBar value={progress} className="mt-2" />
    </article>
  );
}

function GateDetails({ title, gates }: { title: string; gates: Gate[] }) {
  const passed = gates.filter((gate) => gate.passed).length;
  return (
    <details className="group rounded-md border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4">
        <span>
          <span className="block text-sm font-bold text-slate-950">{title}</span>
          <span className="mt-1 block text-xs text-slate-500">{passed} / {gates.length} 基準を通過</span>
        </span>
        <ChevronDown className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-px border-t border-slate-200 bg-slate-100 sm:grid-cols-2">
        {gates.map((gate) => (
          <div key={gate.id} className="flex items-center gap-3 bg-white px-4 py-3 text-sm">
            <span className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
              gate.passed ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
            )}>
              {gate.passed ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
            </span>
            <span className={cn("font-medium", gate.passed ? "text-slate-700" : "text-slate-950")}>{gate.label}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <Icon className="h-8 w-8 text-slate-400" />
      <p className="mt-3 font-bold text-slate-950">{title}</p>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{body}</p>
    </div>
  );
}

function ProgressBar({
  value,
  className,
  tone = "slate",
}: {
  value: number;
  className?: string;
  tone?: "slate" | "emerald";
}) {
  return (
    <div className={cn("h-2 overflow-hidden rounded-full bg-slate-200", className)}>
      <div
        className={cn("h-full rounded-full transition-[width]", tone === "emerald" ? "bg-emerald-600" : "bg-slate-950")}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function DataStatus({ source, generatedAt }: { source: "live" | "snapshot" | "loading"; generatedAt?: string | null }) {
  return (
    <div className="text-right">
      <div className="flex items-center justify-end gap-2 text-sm font-bold text-slate-700">
        <span className={cn(
          "h-2.5 w-2.5 rounded-full",
          source === "live" ? "bg-emerald-500" : source === "snapshot" ? "bg-amber-500" : "bg-slate-300",
        )} />
        {source === "live" ? "リアルタイム" : source === "snapshot" ? "保存データ" : "接続中"}
      </div>
      <p className="mt-1 text-xs text-slate-500">{generatedAt ? formatDateTime(generatedAt) : "更新時刻を確認中"}</p>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-bold text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm font-bold text-slate-950">{value}</p>
    </div>
  );
}

function ResultCell({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "warning" | "neutral";
}) {
  return (
    <div className="flex items-center justify-between md:block">
      <span className="text-xs font-bold text-slate-500 md:hidden">{label}</span>
      <span className={cn(
        "text-sm font-bold",
        tone === "positive" && "text-emerald-700",
        tone === "negative" && "text-rose-700",
        tone === "warning" && "text-amber-700",
        tone === "neutral" && "text-slate-950",
      )}>{value}</span>
    </div>
  );
}

async function fetchStatic<T>(path: string) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`${path}${separator}v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`static artifact ${response.status}`);
  return response.json() as Promise<T>;
}

function toneForNumber(value: number | null | undefined): "positive" | "negative" | "neutral" {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function formatPercent(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未確定";
  return new Intl.NumberFormat("ja-JP", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: "exceptZero",
  }).format(value);
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("ja-JP", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時刻不明";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatPeriod(start: string | null, end: string | null | undefined) {
  if (!start || !end) return "収集中";
  const milliseconds = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const hours = milliseconds / 3_600_000;
  if (hours < 48) return `${Math.max(1, Math.round(hours))}時間`;
  return `${Math.max(1, Math.round(hours / 24))}日間`;
}

function formatHorizon(seconds: number) {
  if (seconds < 60) return `${seconds}秒`;
  return `${seconds / 60}分`;
}

function shortAddress(address: string) {
  return address.length > 14 ? `${address.slice(0, 7)}…${address.slice(-5)}` : address;
}

function walletName(profile: WalletProfile) {
  const value = profile.displayName?.trim();
  if (!value) return shortAddress(profile.address);
  return value.length > 32 ? `${value.slice(0, 31)}…` : value;
}

function categoryLabel(category?: string) {
  const labels: Record<string, string> = {
    CRYPTO: "暗号資産",
    POLITICS: "政治",
    SPORTS: "スポーツ",
    OVERALL: "総合",
  };
  return labels[category ?? ""] ?? category ?? "総合";
}

function modelLabel(model: string) {
  if (model.startsWith("hist-gradient")) return "勾配ブースティング";
  if (model.startsWith("logistic")) return "ロジスティック回帰";
  return model;
}
