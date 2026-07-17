"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  CircleDot,
  Database,
  Gauge,
  Layers3,
  MinusCircle,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { discoverLiveApiBase, fetchLocalApi, getLocalApiToken, isSnapshotMode } from "@/src/lib/localApiClient";

type RunMetrics = {
  totalReturnPct?: number;
  totalReturn?: number;
  orders?: number;
  filledOrders?: number;
  totalFees?: number;
  maxDrawdownPct?: number;
  winRate?: number | null;
  brierScore?: number | null;
  logLoss?: number | null;
  sharpeLike?: number | null;
};

type Run = {
  id: string;
  accountId: string;
  asset: string;
  mode: "historical" | "live";
  strategy: string;
  status: string;
  initialCash: number;
  finalCash: number | null;
  metrics: RunMetrics | null;
  startedAt: string;
  completedAt: string | null;
};

type PaperRunDetail = Run & {
  orders: Array<{ id: string; marketId: string; outcome: string; filledPrice: number | null; filledQuantity: number; status: string; submittedAt: string; reason: string | null }>;
  positions: Array<{ id: string; marketId: string; outcome: string; quantity: number; avgEntryPrice: number; realizedPnl: number | null; status: string }>;
  equitySnapshots: Array<{ capturedAt: string; cash: number; positionsValue: number; equity: number; unrealizedPnl: number }>;
};

type BacktestMetrics = {
  markets: number;
  observations: number;
  accuracy: number | null;
  brierScore: number | null;
  logLoss: number | null;
  calibration: Array<{ bucket: string; predicted: number; actual: number; count: number }>;
  tradedMarkets: number;
  totalPnl: number;
  returnPct: number;
};

type BacktestRun = {
  id: string;
  asset: string;
  status: string;
  threshold: number;
  initialCapital: number;
  startedAt: string;
  completedAt: string | null;
  metrics: BacktestMetrics | null;
  markets: Array<{ marketId: string; title: string; result: 0 | 1; observations: number; firstProbability: number | null; lastProbability: number | null }>;
  error: string | null;
};

type MonitoringSnapshot = {
  status: "live" | "delayed" | "offline";
  generatedAt: string;
  collection: { startedAt: string | null; latestAt: string | null; totalRecords: number; last24Hours: number };
  polymarket: { snapshots: number; markets: number; latestAt: string | null; backtestRuns: number; backtestPoints: number };
  model: {
    name: string;
    selectedCandidate: string | null;
    selectedCandidateKind: "market" | "logit-pool" | "ridge-logit-pool" | null;
    structuralFeatureCoverage: number | null;
    evaluationStatus: "promising" | "inconclusive" | "underperforming" | "building";
    latestAsset: string | null;
    latestBrierScore: number | null;
    latestAccuracy: number | null;
    latestReturnPct: number | null;
    testedMarkets: number;
    testedEvents: number;
    observations: number;
    brierImprovement: number | null;
    previousBrierScore: number | null;
    confidenceInterval95: [number, number] | null;
    statisticallyPositive: boolean;
    completedAt: string | null;
    datasetStartedAt: string | null;
    datasetEndedAt: string | null;
    trades: number;
    winRate: number | null;
    maxDrawdownPct: number | null;
    aiPredictions: number;
    aiResolved: number;
    aiBrierScore: number | null;
    marketBrierScore: number | null;
    aiImprovement: number | null;
    paperRuns: number;
    runningPaperRuns: number;
    paperSnapshots: number;
    paperOrders: number;
    paperFills: number;
    paperReturnPct: number | null;
  };
  backtestQuality: {
    status: "promising" | "inconclusive" | "underperforming" | "building";
    checks: Array<{ label: string; passed: boolean }>;
  };
  hyperliquid: {
    snapshots: number;
    latestAt: string | null;
    assets: Array<{ asset: string; price: number; change24hPct: number | null; dayVolume: number; openInterestUsd: number; fundingRate: number; capturedAt: string }>;
  };
  pipelines: Array<{ id: string; label: string; cadence: string; status: "healthy" | "waiting" | "error"; lastSuccessAt: string | null; records: number }>;
};

type PublicDashboardResponse = {
  generatedAt: string;
  monitoring: MonitoringSnapshot;
  runs: Run[];
  backtests: BacktestRun[];
};

const assets = ["BTC", "ETH", "SOL", "XRP"] as const;
type Tone = "good" | "watch" | "bad" | "neutral";

type Signal = {
  label: string;
  description: string;
  tone: Tone;
  icon: LucideIcon;
};

export function PaperTradingDashboardClient() {
  const [asset, setAsset] = useState<(typeof assets)[number]>("BTC");
  const [initialCash, setInitialCash] = useState("10000");
  const [entryEdge, setEntryEdge] = useState("0.03");
  const [maxMarkets, setMaxMarkets] = useState("20");
  const [runs, setRuns] = useState<Run[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [monitoring, setMonitoring] = useState<MonitoringSnapshot | null>(null);
  const [selectedPaperRun, setSelectedPaperRun] = useState<PaperRunDetail | null>(null);
  const [selectedBacktest, setSelectedBacktest] = useState<BacktestRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("準備完了");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const refreshingRef = useRef(false);

  const activeRun = useMemo(() => runs.find((run) => run.asset === asset && run.status === "running") ?? null, [asset, runs]);
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      await discoverLiveApiBase();
      const staticMode = isSnapshotMode();
      const operatorAccess = Boolean(getLocalApiToken());
      setSnapshot(staticMode);
      setReadOnly(staticMode || !operatorAccess);
      if (staticMode) {
        const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
        const monitoringResponse = await fetch(`${base}/monitoring-snapshot.json`, { cache: "no-store" });
        if (monitoringResponse.ok) setMonitoring(await monitoringResponse.json());
        setMessage("保存時点の結果を表示しています");
        setUpdatedAt(new Date().toISOString());
        return;
      }

      if (!operatorAccess) {
        const payload = await fetchLocalApi<PublicDashboardResponse>("/api/public-dashboard");
        setRuns(payload.runs ?? []);
        setBacktests(payload.backtests ?? []);
        setMonitoring(payload.monitoring);
        setUpdatedAt(payload.generatedAt);
        setMessage("30秒ごとに自動更新");
        return;
      }

      const [runsPayload, backtestsPayload, monitoringPayload] = await Promise.all([
        fetchLocalApi<{ items: Run[] }>("/api/paper-trading/runs"),
        fetchLocalApi<{ items: BacktestRun[] }>("/api/backtests?limit=20"),
        fetchLocalApi<MonitoringSnapshot>("/api/monitoring"),
      ]);
      setRuns(runsPayload.items ?? []);
      setBacktests(backtestsPayload.items ?? []);
      setMonitoring(monitoringPayload);
      setUpdatedAt(new Date().toISOString());
    } catch (error) {
      let usingFallback = false;
      if (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1") {
        const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
        const fallback = await fetch(`${base}/monitoring-snapshot.json`, { cache: "no-store" }).catch(() => null);
        if (fallback?.ok) {
          setMonitoring(await fallback.json());
          setSnapshot(true);
          setReadOnly(true);
          setUpdatedAt(new Date().toISOString());
          usingFallback = true;
        }
      }
      setMessage(usingFallback
        ? "接続確認中・保存時点の結果"
        : error instanceof Error && /401/.test(error.message)
          ? "管理用の接続キーを確認してください"
          : "接続を確認しています");
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function startRun(runMode: "historical" | "live") {
    setLoading(true);
    setMessage(runMode === "live" ? "継続観察を開始しています…" : "仮想売買を検証しています…");
    try {
      const result = await fetchLocalApi<PaperRunDetail>("/api/paper-trading/runs", {
        method: "POST",
        body: JSON.stringify({
          asset,
          mode: runMode,
          config: {
            initialCash: Number(initialCash),
            entryEdge: Number(entryEdge),
            maxMarkets: Number(maxMarkets),
          },
        }),
      });
      setMessage(runMode === "live" ? "継続観察を開始しました" : "仮想売買の検証が完了しました");
      await refresh();
      if (result?.id) await loadPaperRun(result.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "実行に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function runBaselineBacktest() {
    setLoading(true);
    setMessage("市場価格を基準に過去検証しています…");
    try {
      const result = await fetchLocalApi<BacktestRun>("/api/backtests", {
        method: "POST",
        body: JSON.stringify({
          asset,
          threshold: Math.max(0.5, Math.min(0.99, Number(entryEdge) + 0.52)),
          initialCapital: Number(initialCash) || 1000,
          limit: Number(maxMarkets) || 40,
        }),
      });
      setMessage("市場価格を基準に過去検証しました");
      await refresh();
      if (result?.id) await loadBacktest(result.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "backtestに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function runModelEvaluation() {
    setLoading(true);
    setMessage("最新の条件でモデルを再検証しています…");
    try {
      await fetchLocalApi("/api/model-evaluations", { method: "POST" });
      setMessage("モデルの再検証が完了しました");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "モデルの再検証に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function collectSnapshot() {
    setLoading(true);
    setMessage("最新の市場データを保存しています…");
    try {
      const result = await fetchLocalApi<{ saved?: number }>("/api/backtests/collect", {
        method: "POST",
        body: JSON.stringify({ assets: [asset], limit: Number(maxMarkets) || 40 }),
      });
      setMessage(`${result.saved ?? 0}件の市場データを保存しました`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "収集に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function tickRun() {
    if (!activeRun) return;
    setLoading(true);
    setMessage("1回分の市場更新を実行しています…");
    try {
      await fetchLocalApi(`/api/paper-trading/runs/${activeRun.id}`, { method: "POST" });
      await refresh();
      await loadPaperRun(activeRun.id);
      setMessage("1回分の更新を完了しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "市場更新に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function stopRun() {
    if (!activeRun) return;
    setLoading(true);
    try {
      await fetchLocalApi(`/api/paper-trading/runs/${activeRun.id}`, { method: "PATCH", body: JSON.stringify({ action: "stop" }) });
      await refresh();
      setMessage("継続観察を停止しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "継続観察の停止に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function loadPaperRun(id: string) {
    setDetailLoading(true);
    setSelectedBacktest(null);
    try {
      setSelectedPaperRun(await fetchLocalApi<PaperRunDetail>(`/api/paper-trading/runs/${id}`));
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadBacktest(id: string) {
    setDetailLoading(true);
    setSelectedPaperRun(null);
    try {
      setSelectedBacktest(await fetchLocalApi<BacktestRun>(`/api/backtests/${id}`));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-4 pb-24">
      <section className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold text-primary"><Activity className="h-4 w-4" />MODEL DEVELOPMENT</div>
          <h1 className="mt-1 text-2xl font-bold leading-tight text-slate-950 md:text-3xl">予測モデル開発モニター</h1>
          <p className="mt-2 text-sm text-muted-foreground">Polymarketのデータを蓄積し、未使用期間のバックテストで継続検証</p>
        </div>
        <div className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${!snapshot && monitoring?.status === "live" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${!snapshot && monitoring?.status === "live" ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`} />
          {snapshot ? "公開スナップショット" : monitoring?.status === "live" ? "稼働中" : monitoring?.status === "delayed" ? "更新遅延" : "接続確認中"}
        </div>
      </section>

      <ModelSummaryPanel monitoring={monitoring} />

      <DevelopmentMonitor snapshot={monitoring} readOnly={snapshot} />

      <details className="rounded-lg border border-border bg-white shadow-sm">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <span className="flex items-center gap-2 text-sm font-bold text-slate-950"><Gauge className="h-4 w-4 text-primary" />運用操作</span>
          <span className="max-w-[60%] truncate text-xs text-muted-foreground">{readOnly ? message : "管理者用"}</span>
        </summary>
        <div className="grid gap-4 border-t p-4 sm:p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            <Button onClick={() => void runModelEvaluation()} disabled={loading || readOnly}><Target className="h-4 w-4" />モデルを再検証</Button>
            <Button variant="secondary" onClick={() => void collectSnapshot()} disabled={loading || readOnly}><Database className="h-4 w-4" />市場データを保存</Button>
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="h-4 w-4" />画面を更新</Button>
          </div>
          <details className="border-t pt-4">
            <summary className="cursor-pointer text-sm font-bold text-slate-700">銘柄別の検証</summary>
            <div className="mt-4 grid gap-4">
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1 sm:max-w-80">
                {assets.map((item) => (
                  <button key={item} type="button" onClick={() => setAsset(item)} className={`h-9 rounded-md text-sm font-bold transition ${asset === item ? "bg-white text-primary shadow-sm" : "text-muted-foreground hover:text-slate-950"}`}>{item}</button>
                ))}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button variant="outline" onClick={() => void runBaselineBacktest()} disabled={loading || readOnly}><BarChart3 className="h-4 w-4" />市場基準を確認</Button>
                <Button variant="outline" onClick={() => void startRun("historical")} disabled={loading || readOnly || Boolean(activeRun)}><Play className="h-4 w-4" />仮想売買</Button>
                <Button variant="outline" onClick={() => void startRun("live")} disabled={loading || readOnly || Boolean(activeRun)}><Activity className="h-4 w-4" />継続観察</Button>
              </div>
              {activeRun ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void tickRun()} disabled={loading || readOnly}><Target className="h-4 w-4" />今すぐ更新</Button>
                  <Button variant="outline" size="sm" onClick={() => void stopRun()} disabled={loading || readOnly}><Square className="h-4 w-4" />停止</Button>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="grid gap-1.5 text-xs font-semibold">初期資金<input disabled={readOnly} value={initialCash} onChange={(event) => setInitialCash(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal disabled:opacity-50" /></label>
                <label className="grid gap-1.5 text-xs font-semibold">売買に必要な差<input disabled={readOnly} value={entryEdge} onChange={(event) => setEntryEdge(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal disabled:opacity-50" /></label>
                <label className="grid gap-1.5 text-xs font-semibold">市場数<input disabled={readOnly} value={maxMarkets} onChange={(event) => setMaxMarkets(event.target.value)} inputMode="numeric" className="h-10 rounded-lg border bg-background px-2.5 font-normal disabled:opacity-50" /></label>
              </div>
            </div>
          </details>
        </div>
      </details>

      <MonitoringDetails snapshot={monitoring} />

      <section className="grid gap-4 xl:grid-cols-2">
        <ScoreboardCard asset={asset} backtests={backtests} onSelect={readOnly ? undefined : (id) => void loadBacktest(id)} />
        <PaperRunsCard asset={asset} runs={runs} updatedAt={updatedAt} onSelect={readOnly ? undefined : (id) => void loadPaperRun(id)} />
      </section>

      <DetailPanel paperRun={selectedPaperRun} backtest={selectedBacktest} loading={detailLoading} />
    </div>
  );
}

function DevelopmentMonitor({ snapshot, readOnly }: { snapshot: MonitoringSnapshot | null; readOnly: boolean }) {
  const healthyPipelines = snapshot?.pipelines.filter((pipeline) => pipeline.status === "healthy").length ?? 0;
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-white shadow-sm" aria-label="開発稼働状況">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-bold text-slate-950">データ収集・検証基盤</h2>
        </div>
        <span className="text-xs font-bold text-muted-foreground">{readOnly ? "公開時点" : `${healthyPipelines}/${snapshot?.pipelines.length ?? 4} 稼働`}</span>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
        <MonitorMetric label="蓄積データ" value={formatCompact(snapshot?.collection.totalRecords)} note={`24時間 +${formatCompact(snapshot?.collection.last24Hours)}`} />
        <MonitorMetric label="24時間の追加" value={`+${formatCompact(snapshot?.collection.last24Hours)}`} note={`${formatCompact(snapshot?.polymarket.markets)}市場を追跡`} />
        <MonitorMetric label="最終テスト" value={`${snapshot?.model.testedEvents ?? 0}件`} note="未使用期間で評価" />
        <MonitorMetric label="連続蓄積" value={formatElapsed(snapshot?.collection.startedAt)} note={relativeTime(snapshot?.collection.latestAt)} />
      </div>
      <div className="grid grid-cols-2 border-t sm:grid-cols-4 sm:divide-x sm:divide-border">
        {(snapshot?.pipelines ?? fallbackPipelines).map((pipeline) => (
          <div key={pipeline.id} className="flex items-center justify-between gap-2 border-b px-3 py-2.5 odd:border-r sm:border-b-0 sm:border-r-0 sm:px-4 sm:py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${readOnly ? "bg-slate-300" : pipeline.status === "healthy" ? "bg-emerald-500" : pipeline.status === "error" ? "bg-rose-500" : "bg-amber-400"}`} />
              <span className="truncate text-xs font-bold text-slate-800">{pipeline.label}</span>
            </div>
            <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">{pipeline.cadence}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function MonitorMetric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0 p-4 sm:p-5">
      <p className="text-[11px] font-bold text-muted-foreground sm:text-xs">{label}</p>
      <p className="mt-2 break-words text-2xl font-bold leading-none text-slate-950 sm:text-3xl">{value}</p>
      <p className="mt-2 truncate text-[10px] font-semibold text-muted-foreground sm:text-xs">{note}</p>
    </div>
  );
}

function MonitoringDetails({ snapshot }: { snapshot: MonitoringSnapshot | null }) {
  const model = snapshot?.model;
  const passedChecks = snapshot?.backtestQuality.checks.filter((check) => check.passed).length ?? 0;
  const qualitySignal = getEvaluationSignal(snapshot?.backtestQuality.status);
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <h2 className="text-base font-bold text-slate-950">バックテスト品質</h2>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tonePillClass(qualitySignal.tone)}`}>
            {passedChecks}/{snapshot?.backtestQuality.checks.length ?? 4} 合格
          </span>
        </div>
        <div className="mt-5 grid grid-cols-3 divide-x divide-border">
          <CompactMetric label="モデル誤差" value={formatNumber(model?.latestBrierScore, 3)} />
          <CompactMetric label="市場の誤差" value={formatNumber(model?.previousBrierScore, 3)} />
          <CompactMetric label="最大下落" value={formatPct(model?.maxDrawdownPct)} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
          {(snapshot?.backtestQuality.checks ?? []).map((check) => (
            <span key={check.label} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold ${check.passed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
              {check.passed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
              {check.label}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers3 className="h-5 w-5 text-primary" />
            <h2 className="text-base font-bold text-slate-950">相場環境データ</h2>
          </div>
          <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-700">モデル入力済み</span>
        </div>
        <div className="mt-4 divide-y divide-border">
          {(snapshot?.hyperliquid.assets ?? []).map((item) => (
            <div key={item.asset} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3 py-3">
              <span className="text-sm font-bold text-slate-950">{item.asset}</span>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-950">{formatMarketPrice(item.price)}</p>
                <p className="truncate text-[10px] font-semibold text-muted-foreground">24h出来高 {formatUsdCompact(item.dayVolume)}</p>
              </div>
              <span className={`text-sm font-bold ${(item.change24hPct ?? 0) >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatSignedPct(item.change24hPct)}</span>
            </div>
          ))}
          {!snapshot?.hyperliquid.assets.length ? <p className="py-6 text-center text-sm text-muted-foreground">主要銘柄の収集を開始しています</p> : null}
        </div>
        <p className="border-t pt-3 text-[11px] leading-5 text-muted-foreground">Hyperliquidの価格と実現変動率を独立確率の計算に使用。特徴量取得率 {formatPct(modelFeatureCoverage(snapshot))}</p>
      </div>
    </section>
  );
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-3 first:pl-0 last:pr-0 sm:px-4">
      <p className="text-[10px] font-bold text-muted-foreground sm:text-xs">{label}</p>
      <p className="mt-2 break-words text-xl font-bold text-slate-950 sm:text-2xl">{value}</p>
    </div>
  );
}

const fallbackPipelines = [
  { id: "polymarket", label: "Polymarket収集", cadence: "5分ごと", status: "waiting" as const },
  { id: "hyperliquid", label: "相場データ収集", cadence: "5分ごと", status: "waiting" as const },
  { id: "backtest", label: "モデル再検証", cadence: "6時間ごと", status: "waiting" as const },
  { id: "paper", label: "仮想運用", cadence: "5分ごと", status: "waiting" as const },
];

function ModelSummaryPanel({ monitoring }: { monitoring: MonitoringSnapshot | null }) {
  const model = monitoring?.model;
  const decision = getEvaluationSignal(model?.evaluationStatus, model?.selectedCandidateKind);
  const DecisionIcon = decision.icon;
  const comparisonTone: Tone = (model?.brierImprovement ?? 0) > 0 ? "good" : (model?.brierImprovement ?? 0) < 0 ? "bad" : "neutral";
  const profitSignal = getProfitSignal(model?.latestReturnPct);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-white shadow-sm" aria-label="モデル成績の概要">
      <div className="grid lg:grid-cols-[minmax(260px,0.9fr)_minmax(0,1.8fr)]">
        <div className={`border-b p-5 lg:border-b-0 lg:border-r sm:p-6 ${toneSoftClass(decision.tone)}`}>
          <div className="flex items-center gap-3">
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${toneIconClass(decision.tone)}`}>
              <DecisionIcon className="h-6 w-6" />
            </span>
            <div>
              <p className="text-sm font-bold text-muted-foreground">現在の判定</p>
              <p className="mt-0.5 text-xs text-muted-foreground">本番投入前</p>
            </div>
          </div>
          <h2 className="mt-5 text-4xl font-bold leading-none text-slate-950 sm:text-5xl">{decision.label}</h2>
          <p className="mt-4 max-w-sm text-sm font-semibold leading-6 text-slate-700">{decision.description}</p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border">
          <ResultMetric
            icon={Target}
            label="市場との差"
            value={formatImprovement(model?.brierImprovement)}
            note={`${model?.testedEvents ?? 0}イベント比較`}
            tone={comparisonTone}
          />
          <ResultMetric
            icon={profitSignal.icon}
            label="検証損益"
            value={formatPct(model?.latestReturnPct)}
            note={`${model?.trades ?? 0}回の仮想売買`}
            tone={profitSignal.tone}
          />
          <ResultMetric
            icon={ShieldCheck}
            label="最終テスト"
            value={`${model?.testedEvents ?? 0}件`}
            note={`${model?.testedMarkets ?? 0}市場 / 未使用期間`}
            tone={(model?.testedEvents ?? 0) >= 15 ? "good" : "watch"}
          />
        </div>
      </div>
      <BrierComparison modelScore={model?.latestBrierScore} marketScore={model?.previousBrierScore} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>{model?.name ?? "モデル検証準備中"} / 採用: {formatCandidate(model?.selectedCandidate, model?.selectedCandidateKind)}</span>
        <span>{formatEvaluationPeriod(model?.datasetStartedAt, model?.datasetEndedAt)}</span>
      </div>
    </section>
  );
}

function BrierComparison({ modelScore, marketScore }: { modelScore: number | null | undefined; marketScore: number | null | undefined }) {
  const maximum = Math.max(modelScore ?? 0, marketScore ?? 0, 0.01) * 1.12;
  const rows = [
    { label: "開発モデル", value: modelScore, className: (modelScore ?? 0) <= (marketScore ?? 0) ? "bg-emerald-500" : "bg-rose-500" },
    { label: "Polymarket", value: marketScore, className: "bg-slate-500" },
  ];
  return (
    <div className="grid gap-2 border-t px-5 py-4" aria-label="予測誤差の比較">
      <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground"><span>予測誤差</span><span>小さいほど良い</span></div>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[84px_minmax(0,1fr)_52px] items-center gap-2 text-xs">
          <span className="font-bold text-slate-700">{row.label}</span>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${row.className}`} style={{ width: `${row.value === null || row.value === undefined ? 0 : Math.max(3, row.value / maximum * 100)}%` }} /></div>
          <span className="text-right font-bold tabular-nums text-slate-950">{formatNumber(row.value, 3)}</span>
        </div>
      ))}
    </div>
  );
}

function ResultMetric({
  icon: Icon,
  label,
  value,
  note,
  tone,
  meter,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  note: string;
  tone: Tone;
  meter?: number;
}) {
  return (
    <div className="flex min-h-36 min-w-0 flex-col justify-between p-3 sm:min-h-40 sm:p-5">
      <div>
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-bold leading-4 text-muted-foreground sm:gap-2 sm:text-xs">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8 ${toneIconClass(tone)}`}><Icon className="h-4 w-4" /></span>
          <span className="break-words">{label}</span>
        </div>
        <p className="mt-3 break-words text-xl font-bold leading-tight text-slate-950 sm:mt-4 sm:text-2xl">{value}</p>
        <p className="mt-1 break-words text-[10px] font-semibold leading-4 text-muted-foreground sm:text-xs">{note}</p>
      </div>
      {meter !== undefined ? <VisualMeter tone={tone} value={meter} className="mt-4" /> : null}
    </div>
  );
}

function ScoreboardCard({ asset, backtests, onSelect }: { asset: string; backtests: BacktestRun[]; onSelect?: (id: string) => void }) {
  const filtered = backtests.filter((run) => run.asset === asset);
  const sorted = [...filtered].sort((a, b) => scoreBacktest(a) - scoreBacktest(b)).slice(0, 8);
  return (
    <details className="rounded-lg border border-border bg-white shadow-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-base font-bold text-slate-950">過去検証の履歴</span>
        <span className="text-xs text-muted-foreground">{filtered.length}件</span>
      </summary>
      <div className="grid gap-2 p-3">
        {sorted.map((run, index) => {
          const signal = getModelSignal(run.metrics?.brierScore);
          return (
            <button key={run.id} type="button" disabled={!onSelect} onClick={() => onSelect?.(run.id)} className="grid gap-3 rounded-md border border-border p-3 text-left enabled:hover:border-primary/40 enabled:hover:bg-accent disabled:cursor-default">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-bold text-slate-950">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">{index + 1}</span>
                  <span className="break-words">{run.asset} / 市場価格の基準 {formatPct(run.threshold)}</span>
                </span>
                <QualityPill signal={signal} />
              </div>
              <VisualMeter tone={signal.tone} value={errorMeter(run.metrics?.brierScore)} />
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                <span>確率の誤差 <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
                <span>自信を持った外れ <b className="text-slate-950">{formatNumber(run.metrics?.logLoss, 3)}</b></span>
                <span>損益 <b className={run.metrics?.returnPct && run.metrics.returnPct > 0 ? "text-emerald-700" : "text-slate-950"}>{formatPct(run.metrics?.returnPct)}</b></span>
                <span>市場数 <b className="text-slate-950">{run.metrics?.markets ?? 0}</b></span>
              </div>
            </button>
          );
        })}
        {!sorted.length ? <p className="p-4 text-sm text-muted-foreground">まだ過去検証の履歴がありません。「市場価格で過去検証」を実行してください。</p> : null}
      </div>
    </details>
  );
}

function PaperRunsCard({ asset, runs, updatedAt, onSelect }: { asset: string; runs: Run[]; updatedAt: string | null; onSelect?: (id: string) => void }) {
  const filtered = runs.filter((run) => run.asset === asset);
  return (
    <details className="rounded-lg border border-border bg-white shadow-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-base font-bold text-slate-950">仮想売買の履歴</span>
        <span className="text-xs text-muted-foreground">{updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP") : "-"}</span>
      </summary>
      <div className="grid gap-2 p-3">
        {filtered.slice(0, 8).map((run) => {
          const signal = getProfitSignal(run.metrics?.totalReturnPct);
          return (
          <button key={run.id} type="button" disabled={!onSelect} onClick={() => onSelect?.(run.id)} className={`grid gap-3 rounded-md border p-3 text-left enabled:hover:border-primary/40 enabled:hover:bg-accent disabled:cursor-default ${toneBorderClass(signal.tone)}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-950">{run.asset} / {modeLabel(run.mode)}</span>
              <span className={run.status === "running" ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700" : "rounded-full bg-secondary px-2 py-1 text-xs font-semibold"}>{statusLabel(run.status)}</span>
            </div>
            <VisualMeter tone={signal.tone} value={profitMeter(run.metrics?.totalReturnPct)} />
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>損益 <b className={signal.tone === "good" ? "text-emerald-700" : signal.tone === "bad" ? "text-rose-700" : "text-slate-950"}>{formatPct(run.metrics?.totalReturnPct)}</b></span>
              <span>確率の誤差 <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
              <span>最大の落ち込み <b className="text-slate-950">{formatPct(run.metrics?.maxDrawdownPct)}</b></span>
              <span>売買成立 <b className="text-slate-950">{run.metrics?.filledOrders ?? 0}</b></span>
            </div>
          </button>
          );
        })}
        {!filtered.length ? <p className="p-4 text-sm text-muted-foreground">{asset}の検証履歴はまだありません。</p> : null}
      </div>
    </details>
  );
}

function DetailPanel({ paperRun, backtest, loading }: { paperRun: PaperRunDetail | null; backtest: BacktestRun | null; loading: boolean }) {
  if (loading) return <div className="rounded-lg border border-border bg-white p-5 text-sm text-muted-foreground">詳細を取得しています…</div>;
  if (!paperRun && !backtest) return null;

  return (
    <section className="rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5">
      {paperRun ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h2 className="text-xl font-bold text-slate-950">仮想売買の詳細</h2>
            <p className="text-sm text-muted-foreground">{paperRun.asset} / {modeLabel(paperRun.mode)} / {statusLabel(paperRun.status)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <MiniMetric label="損益" value={formatPct(paperRun.metrics?.totalReturnPct)} />
            <MiniMetric label="確率の誤差" value={formatNumber(paperRun.metrics?.brierScore, 3)} />
            <MiniMetric label="最大の落ち込み" value={formatPct(paperRun.metrics?.maxDrawdownPct)} />
            <MiniMetric label="手数料" value={formatUsd(paperRun.metrics?.totalFees)} />
          </div>
          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">注文と保有状況を見る</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <CompactList title="注文履歴" items={paperRun.orders.slice(-8).reverse().map((order) => `${order.outcome} ${statusLabel(order.status)} / ${formatNumber(order.filledPrice, 3)} x ${formatNumber(order.filledQuantity, 2)}`)} />
              <CompactList title="保有状況" items={paperRun.positions.slice(-8).reverse().map((position) => `${position.outcome} ${statusLabel(position.status)} / ${formatNumber(position.quantity, 2)} / 損益 ${formatUsd(position.realizedPnl)}`)} />
            </div>
          </details>
        </div>
      ) : null}

      {backtest ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h2 className="text-xl font-bold text-slate-950">過去検証の詳細</h2>
            <p className="text-sm text-muted-foreground">{backtest.asset} / 判定基準 {formatPct(backtest.threshold)} / {statusLabel(backtest.status)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <MiniMetric label="確率の誤差" value={formatNumber(backtest.metrics?.brierScore, 3)} />
            <MiniMetric label="自信を持った外れ" value={formatNumber(backtest.metrics?.logLoss, 3)} />
            <MiniMetric label="的中率" value={formatPct(backtest.metrics?.accuracy)} />
            <MiniMetric label="損益" value={formatPct(backtest.metrics?.returnPct)} />
          </div>
          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">確率帯と市場別の結果を見る</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <CompactList title="確率帯の結果" items={(backtest.metrics?.calibration ?? []).map((bucket) => `${bucket.bucket}: 予測 ${formatPct(bucket.predicted)} / 実績 ${formatPct(bucket.actual)} / 件数 ${bucket.count}`)} />
              <CompactList title="市場別の結果" items={backtest.markets.slice(0, 10).map((market) => `${market.result ? "成立" : "不成立"} / ${formatPct(market.lastProbability)} / ${market.title}`)} />
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function QualityPill({ signal }: { signal: Signal }) {
  const Icon = signal.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${tonePillClass(signal.tone)}`}>
      <Icon className="h-3.5 w-3.5" />
      {signal.label}
    </span>
  );
}

function VisualMeter({ tone, value, className = "" }: { tone: Tone; value: number; className?: string }) {
  return (
    <div className={`h-2 overflow-hidden rounded-full bg-slate-100 ${className}`}>
      <div className={`h-full rounded-full ${toneBarClass(tone)}`} style={{ width: `${clamp(value, 0, 100)}%` }} />
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold text-slate-950">{value}</p>
    </div>
  );
}

function CompactList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="grid gap-2">
      <p className="text-xs font-bold text-muted-foreground">{title}</p>
      {items.length ? items.map((item) => <p key={item} className="line-clamp-2 break-words rounded-md bg-white p-2 text-sm leading-6 text-slate-700">{item}</p>) : <p className="text-sm text-muted-foreground">データなし</p>}
    </div>
  );
}

function scoreBacktest(run: BacktestRun) {
  return run.metrics?.brierScore ?? Number.POSITIVE_INFINITY;
}

function getEvaluationSignal(
  status: MonitoringSnapshot["model"]["evaluationStatus"] | undefined,
  selectedCandidateKind?: MonitoringSnapshot["model"]["selectedCandidateKind"],
): Signal {
  if (status === "promising") {
    return { label: "改善を確認", description: "未使用期間でも市場価格より誤差が小さく、コスト控除後もプラスです。", tone: "good", icon: CheckCircle2 };
  }
  if (status === "underperforming") {
    return { label: "改善が必要", description: "市場価格を下回ったため、現在のモデルは本番利用せず改良を続けます。", tone: "bad", icon: TrendingDown };
  }
  if (status === "inconclusive") {
    if (selectedCandidateKind === "market") {
      return { label: "優位性は未確認", description: "独立モデルは採用基準に届かず、市場価格を基準として維持しています。", tone: "watch", icon: AlertCircle };
    }
    return { label: "検証継続", description: "優位性を判断できるだけの差がまだ確認できていません。", tone: "watch", icon: AlertCircle };
  }
  return { label: "検証準備中", description: "過去データを整え、最初の未使用期間テストを実行しています。", tone: "neutral", icon: Gauge };
}

function getModelSignal(value: number | null | undefined): Signal {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      label: "データ待ち",
      description: "過去検証を実行すると判定できます",
      tone: "neutral",
      icon: Gauge,
    };
  }
  if (value <= 0.08) {
    return {
      label: "良好",
      description: "予測誤差は小さめです",
      tone: "good",
      icon: CheckCircle2,
    };
  }
  if (value <= 0.16) {
    return {
      label: "注意",
      description: "もう少しデータを増やして確認します",
      tone: "watch",
      icon: AlertCircle,
    };
  }
  return {
    label: "要確認",
    description: "外れが大きい可能性があります",
    tone: "bad",
    icon: AlertCircle,
  };
}

function getProfitSignal(value: number | null | undefined): Signal {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      label: "データ待ち",
      description: "取引結果がまだありません",
      tone: "neutral",
      icon: Gauge,
    };
  }
  if (value > 0.005) {
    return {
      label: "プラス",
      description: "検証上は利益方向です",
      tone: "good",
      icon: TrendingUp,
    };
  }
  if (value < -0.005) {
    return {
      label: "マイナス",
      description: "損失方向なので条件を見直します",
      tone: "bad",
      icon: TrendingDown,
    };
  }
  return {
    label: "横ばい",
    description: "大きな損益は出ていません",
    tone: "watch",
    icon: MinusCircle,
  };
}

function errorMeter(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return 100 - clamp((value / 0.2) * 100, 0, 100);
}

function profitMeter(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return clamp(50 + value * 500, 5, 100);
}

function toneSoftClass(tone: Tone) {
  const classes: Record<Tone, string> = {
    good: "bg-emerald-50",
    watch: "bg-amber-50",
    bad: "bg-rose-50",
    neutral: "bg-slate-50",
  };
  return classes[tone];
}

function toneIconClass(tone: Tone) {
  const classes: Record<Tone, string> = {
    good: "bg-emerald-100 text-emerald-700",
    watch: "bg-amber-100 text-amber-700",
    bad: "bg-rose-100 text-rose-700",
    neutral: "bg-slate-100 text-primary",
  };
  return classes[tone];
}

function tonePillClass(tone: Tone) {
  const classes: Record<Tone, string> = {
    good: "bg-emerald-100 text-emerald-700",
    watch: "bg-amber-100 text-amber-800",
    bad: "bg-rose-100 text-rose-700",
    neutral: "bg-slate-100 text-slate-600",
  };
  return classes[tone];
}

function toneBorderClass(tone: Tone) {
  const classes: Record<Tone, string> = {
    good: "border-emerald-200 bg-emerald-50/30",
    watch: "border-amber-200 bg-amber-50/30",
    bad: "border-rose-200 bg-rose-50/30",
    neutral: "border-border bg-white",
  };
  return classes[tone];
}

function toneBarClass(tone: Tone) {
  const classes: Record<Tone, string> = {
    good: "bg-emerald-500",
    watch: "bg-amber-500",
    bad: "bg-rose-500",
    neutral: "bg-slate-300",
  };
  return classes[tone];
}

function modeLabel(mode: Run["mode"]) {
  return mode === "live" ? "継続観察" : "過去検証";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    running: "実行中",
    completed: "完了",
    stopped: "停止・未確定",
    failed: "失敗",
    pending: "待機",
    filled: "約定",
    cancelled: "取消",
    open: "保有中",
    closed: "決済済み",
  };
  return labels[status] ?? status;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function formatImprovement(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value > 0) return `${(value * 100).toFixed(1)}%改善`;
  if (value < 0) return `${Math.abs(value * 100).toFixed(1)}%悪化`;
  return "差なし";
}

function formatCandidate(
  candidate: string | null | undefined,
  kind: MonitoringSnapshot["model"]["selectedCandidateKind"] | undefined,
) {
  if (!candidate || !kind) return "選定中";
  if (kind === "market") return "市場基準";
  return kind === "ridge-logit-pool" ? "価格構造リッジ統合" : "価格構造統合";
}

function modelFeatureCoverage(snapshot: MonitoringSnapshot | null) {
  return snapshot?.model.structuralFeatureCoverage ?? null;
}

function formatEvaluationPeriod(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return "検証期間を準備中";
  const formatter = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit" });
  return `検証期間 ${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

function formatCompact(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) < 10_000) return new Intl.NumberFormat("ja-JP").format(value);
  return new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatElapsed(startedAt: string | null | undefined) {
  if (!startedAt) return "-";
  const elapsedHours = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 3_600_000));
  const days = Math.floor(elapsedHours / 24);
  const hours = elapsedHours % 24;
  return days > 0 ? `${days}日 ${hours}時間` : `${hours}時間`;
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "更新待ち";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "最終収集 1分以内";
  if (minutes < 60) return `最終収集 ${minutes}分前`;
  return `最終収集 ${Math.floor(minutes / 60)}時間前`;
}

function formatMarketPrice(value: number) {
  const digits = value >= 1_000 ? 0 : value >= 10 ? 2 : 4;
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value)}`;
}

function formatUsdCompact(value: number) {
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
}

function formatSignedPct(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function formatPct(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(2)}%`;
}

function formatUsd(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `$${value.toFixed(2)}`;
}
