"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Database,
  LineChart,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Target,
  TrendingDown,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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

type Forecast = {
  asset: string;
  targetDate: string | null;
  marketCount: number;
  impliedMedian: number | null;
  quantiles: { p10: number | null; p25: number | null; p75: number | null; p90: number | null };
};

const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const assets = ["BTC", "ETH", "SOL", "XRP"] as const;

export function PaperTradingDashboardClient() {
  const [asset, setAsset] = useState<(typeof assets)[number]>("BTC");
  const [mode, setMode] = useState<"historical" | "live">("historical");
  const [initialCash, setInitialCash] = useState("10000");
  const [entryEdge, setEntryEdge] = useState("0.03");
  const [maxMarkets, setMaxMarkets] = useState("20");
  const [runs, setRuns] = useState<Run[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [selectedPaperRun, setSelectedPaperRun] = useState<PaperRunDetail | null>(null);
  const [selectedBacktest, setSelectedBacktest] = useState<BacktestRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("準備完了");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const activeRun = useMemo(() => runs.find((run) => run.status === "running") ?? null, [runs]);
  const latestRun = runs[0];
  const latestMetrics = latestRun?.metrics;
  const bestBacktest = useMemo(() => bestScoredBacktest(backtests), [backtests]);

  const refresh = useCallback(async () => {
    try {
      const [runsResponse, forecastResponse, backtestsResponse] = await Promise.all([
        fetch("/api/paper-trading/runs", { cache: "no-store" }),
        fetch(`/api/backtests/forecast?asset=${asset}`, { cache: "no-store" }),
        fetch("/api/backtests?limit=20", { cache: "no-store" }),
      ]);
      if (runsResponse.ok) {
        const payload = await runsResponse.json();
        setRuns(payload.items ?? []);
      }
      if (forecastResponse.ok) setForecast(await forecastResponse.json());
      if (backtestsResponse.ok) {
        const payload = await backtestsResponse.json();
        setBacktests(payload.items ?? []);
      }
      setUpdatedAt(new Date().toISOString());
    } catch {
      setMessage("APIに接続できません。ローカルサーバーとworkerを起動してください。");
    }
  }, [asset]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function startRun() {
    setLoading(true);
    setMessage(mode === "live" ? "live paper runを開始しています…" : "paper backtestを実行しています…");
    try {
      const response = await fetch("/api/paper-trading/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset,
          mode,
          config: {
            initialCash: Number(initialCash),
            entryEdge: Number(entryEdge),
            maxMarkets: Number(maxMarkets),
          },
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "run failed");
      setMessage(mode === "live" ? "live paper runを開始しました" : "paper backtestが完了しました");
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
    setMessage("市場価格ベースラインを検証しています…");
    try {
      const response = await fetch("/api/backtests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          asset,
          threshold: Math.max(0.5, Math.min(0.99, Number(entryEdge) + 0.52)),
          initialCapital: Number(initialCash) || 1000,
          limit: Number(maxMarkets) || 40,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "backtest failed");
      setMessage("市場価格ベースラインの検証が完了しました");
      await refresh();
      if (result?.id) await loadBacktest(result.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "backtestに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function collectSnapshot() {
    setLoading(true);
    setMessage("最新スナップショットを収集しています…");
    try {
      const response = await fetch("/api/backtests/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assets: [asset], limit: Number(maxMarkets) || 40 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "collection failed");
      setMessage(`スナップショット保存: ${result.saved ?? 0}件`);
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
    await fetch(`/api/paper-trading/runs/${activeRun.id}`, { method: "POST" });
    await refresh();
    await loadPaperRun(activeRun.id);
    setLoading(false);
    setMessage("paper tickを完了しました");
  }

  async function stopRun() {
    if (!activeRun) return;
    setLoading(true);
    await fetch(`/api/paper-trading/runs/${activeRun.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
    await refresh();
    setLoading(false);
    setMessage("paper runを停止しました");
  }

  async function loadPaperRun(id: string) {
    setDetailLoading(true);
    setSelectedBacktest(null);
    try {
      const response = await fetch(`/api/paper-trading/runs/${id}`, { cache: "no-store" });
      if (response.ok) setSelectedPaperRun(await response.json());
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadBacktest(id: string) {
    setDetailLoading(true);
    setSelectedPaperRun(null);
    try {
      const response = await fetch(`/api/backtests/${id}`, { cache: "no-store" });
      if (response.ok) setSelectedBacktest(await response.json());
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-white p-5 shadow-sm md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-primary"><Activity className="h-4 w-4" />Model Backtest</div>
            <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-slate-950 md:text-3xl">評価モデルをバックテスト</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Polymarketの価格履歴を使い、確率精度、損益、ドローダウンを同じ画面で検証します。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
            実注文なし
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Wallet} label="最新損益" value={formatPct(latestMetrics?.totalReturnPct)} sub={latestRun?.asset ?? "-"} />
        <MetricCard icon={BarChart3} label="Brier" value={formatNumber(latestMetrics?.brierScore, 3)} sub="低いほど良い" />
        <MetricCard icon={TrendingDown} label="最大DD" value={formatPct(latestMetrics?.maxDrawdownPct)} sub="資産曲線" />
        <MetricCard icon={LineChart} label="最良Backtest" value={formatNumber(bestBacktest?.metrics?.brierScore, 3)} sub={bestBacktest ? `${bestBacktest.asset} / Brier` : "-"} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-start justify-between space-y-0 border-b bg-slate-50/70">
            <div><CardTitle>市場インプライド予想</CardTitle><p className="mt-1 text-xs text-muted-foreground">{forecast?.marketCount ?? 0} markets</p></div>
            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">{forecast?.targetDate ?? "-"}</span>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{asset} / implied median</p>
                <p className="mt-1 text-4xl font-bold tracking-tight text-primary sm:text-5xl">{forecast?.impliedMedian ? `$${price.format(forecast.impliedMedian)}` : "-"}</p>
              </div>
              <div className="grid grid-cols-3 gap-4 text-right text-xs">
                <div><p className="text-muted-foreground">p10</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p10)}</p></div>
                <div><p className="text-muted-foreground">p25</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p25)}</p></div>
                <div><p className="text-muted-foreground">p90</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p90)}</p></div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Range label="p10" value={forecast?.quantiles.p10} />
              <Range label="p25" value={forecast?.quantiles.p25} />
              <Range label="中央値" value={forecast?.impliedMedian} primary />
              <Range label="p90" value={forecast?.quantiles.p90} />
            </div>
            <details className="rounded-lg border border-border bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-bold text-slate-800">評価指標の見方</summary>
              <div className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
                <p>Brier score: 確率予測の二乗誤差。低いほど安定。</p>
                <p>Log loss: 外れた高確信予想に厳しい指標。</p>
                <p>最大DD: 資産曲線の落ち込み。低いほど運用しやすい。</p>
                <p>Edge: 市場価格と補正後フェア確率の差。</p>
              </div>
            </details>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b bg-slate-50/70"><CardTitle>検証設定</CardTitle></CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Asset</p>
              <div className="grid grid-cols-4 gap-2">
                {assets.map((item) => (
                  <button key={item} type="button" onClick={() => setAsset(item)} className={`h-10 rounded-lg border text-sm font-bold transition ${asset === item ? "border-primary bg-primary text-primary-foreground shadow-sm" : "bg-background text-muted-foreground hover:bg-accent"}`}>{item}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Paper mode</p>
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary p-1">
                <button type="button" onClick={() => setMode("historical")} className={`h-9 rounded-md text-xs font-bold transition ${mode === "historical" ? "bg-white text-primary shadow-sm" : "text-muted-foreground"}`}>Backtest</button>
                <button type="button" onClick={() => setMode("live")} className={`h-9 rounded-md text-xs font-bold transition ${mode === "live" ? "bg-white text-primary shadow-sm" : "text-muted-foreground"}`}>Live</button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1.5 text-xs font-semibold">残高<input value={initialCash} onChange={(event) => setInitialCash(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label>
              <label className="grid gap-1.5 text-xs font-semibold">Edge<input value={entryEdge} onChange={(event) => setEntryEdge(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label>
              <label className="grid gap-1.5 text-xs font-semibold">市場数<input value={maxMarkets} onChange={(event) => setMaxMarkets(event.target.value)} inputMode="numeric" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => void startRun()} disabled={loading || Boolean(activeRun)}><Play className="h-4 w-4" />Paper実行</Button>
              <Button variant="outline" onClick={() => void runBaselineBacktest()} disabled={loading}><BarChart3 className="h-4 w-4" />成績検証</Button>
              <Button variant="outline" onClick={() => void collectSnapshot()} disabled={loading}><Database className="h-4 w-4" />収集</Button>
              <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="h-4 w-4" />更新</Button>
            </div>
            {activeRun ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => void tickRun()} disabled={loading}><Target className="h-4 w-4" />手動tick</Button>
                <Button variant="outline" size="sm" onClick={() => void stopRun()} disabled={loading}><Square className="h-4 w-4" />停止</Button>
              </div>
            ) : null}
            <div className="grid gap-2 border-t pt-3 text-xs text-muted-foreground">
              <p>{message}</p>
              <p className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{activeRun ? `${activeRun.asset}のLive runが稼働中` : "Worker待機中"}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <ScoreboardCard backtests={backtests} onSelect={(id) => void loadBacktest(id)} />
        <PaperRunsCard runs={runs} updatedAt={updatedAt} onSelect={(id) => void loadPaperRun(id)} />
      </section>

      <DetailPanel paperRun={selectedPaperRun} backtest={selectedBacktest} loading={detailLoading} />
    </div>
  );
}

function ScoreboardCard({ backtests, onSelect }: { backtests: BacktestRun[]; onSelect: (id: string) => void }) {
  const sorted = [...backtests].sort((a, b) => scoreBacktest(a) - scoreBacktest(b)).slice(0, 8);
  return (
    <details className="rounded-lg border border-border bg-white shadow-sm" open>
      <summary className="flex cursor-pointer items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-base font-bold text-slate-950">モデル成績比較</span>
        <span className="text-xs text-muted-foreground">{backtests.length} runs</span>
      </summary>
      <div className="grid gap-2 p-3">
        {sorted.map((run) => (
          <button key={run.id} type="button" onClick={() => onSelect(run.id)} className="grid gap-2 rounded-md border border-border p-3 text-left hover:border-primary/40 hover:bg-accent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-950">{run.asset} / threshold {run.threshold.toFixed(2)}</span>
              <span className="rounded-full bg-secondary px-2 py-1 text-xs font-semibold">{run.status}</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
              <span>Brier <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
              <span>Log <b className="text-slate-950">{formatNumber(run.metrics?.logLoss, 3)}</b></span>
              <span>損益 <b className="text-slate-950">{formatPct(run.metrics?.returnPct)}</b></span>
              <span>市場 <b className="text-slate-950">{run.metrics?.markets ?? 0}</b></span>
            </div>
          </button>
        ))}
        {!sorted.length ? <p className="p-4 text-sm text-muted-foreground">まだbacktest履歴がありません。「成績検証」を実行してください。</p> : null}
      </div>
    </details>
  );
}

function PaperRunsCard({ runs, updatedAt, onSelect }: { runs: Run[]; updatedAt: string | null; onSelect: (id: string) => void }) {
  return (
    <details className="rounded-lg border border-border bg-white shadow-sm" open>
      <summary className="flex cursor-pointer items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-base font-bold text-slate-950">Paper Run履歴</span>
        <span className="text-xs text-muted-foreground">{updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP") : "-"}</span>
      </summary>
      <div className="grid gap-2 p-3">
        {runs.slice(0, 8).map((run) => (
          <button key={run.id} type="button" onClick={() => onSelect(run.id)} className="grid gap-2 rounded-md border border-border p-3 text-left hover:border-primary/40 hover:bg-accent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-950">{run.asset} / {run.mode === "live" ? "Live" : "Backtest"}</span>
              <span className={run.status === "running" ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700" : "rounded-full bg-secondary px-2 py-1 text-xs font-semibold"}>{run.status}</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
              <span>損益 <b className="text-slate-950">{formatPct(run.metrics?.totalReturnPct)}</b></span>
              <span>Brier <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
              <span>DD <b className="text-slate-950">{formatPct(run.metrics?.maxDrawdownPct)}</b></span>
              <span>約定 <b className="text-slate-950">{run.metrics?.filledOrders ?? 0}</b></span>
            </div>
          </button>
        ))}
        {!runs.length ? <p className="p-4 text-sm text-muted-foreground">まだpaper run履歴がありません。</p> : null}
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
            <h2 className="text-xl font-bold text-slate-950">Paper Run詳細</h2>
            <p className="text-sm text-muted-foreground">{paperRun.asset} / {paperRun.mode} / {paperRun.status}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <MiniMetric label="損益" value={formatPct(paperRun.metrics?.totalReturnPct)} />
            <MiniMetric label="Brier" value={formatNumber(paperRun.metrics?.brierScore, 3)} />
            <MiniMetric label="最大DD" value={formatPct(paperRun.metrics?.maxDrawdownPct)} />
            <MiniMetric label="手数料" value={formatUsd(paperRun.metrics?.totalFees)} />
          </div>
          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">注文・ポジションを見る</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <CompactList title="注文" items={paperRun.orders.slice(-8).reverse().map((order) => `${order.outcome} ${order.status} / ${formatNumber(order.filledPrice, 3)} x ${formatNumber(order.filledQuantity, 2)}`)} />
              <CompactList title="ポジション" items={paperRun.positions.slice(-8).reverse().map((position) => `${position.outcome} ${position.status} / ${formatNumber(position.quantity, 2)} / PnL ${formatUsd(position.realizedPnl)}`)} />
            </div>
          </details>
        </div>
      ) : null}

      {backtest ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h2 className="text-xl font-bold text-slate-950">Backtest詳細</h2>
            <p className="text-sm text-muted-foreground">{backtest.asset} / threshold {backtest.threshold.toFixed(2)} / {backtest.status}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <MiniMetric label="Brier" value={formatNumber(backtest.metrics?.brierScore, 3)} />
            <MiniMetric label="Log loss" value={formatNumber(backtest.metrics?.logLoss, 3)} />
            <MiniMetric label="Accuracy" value={formatPct(backtest.metrics?.accuracy)} />
            <MiniMetric label="損益" value={formatPct(backtest.metrics?.returnPct)} />
          </div>
          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">Calibrationと市場別結果を見る</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <CompactList title="Calibration" items={(backtest.metrics?.calibration ?? []).map((bucket) => `${bucket.bucket}: 予測 ${formatPct(bucket.predicted)} / 実績 ${formatPct(bucket.actual)} / n=${bucket.count}`)} />
              <CompactList title="市場別" items={backtest.markets.slice(0, 10).map((market) => `${market.result ? "YES" : "NO"} / ${formatPct(market.lastProbability)} / ${market.title}`)} />
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function MetricCard({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4 sm:p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary"><Icon className="h-5 w-5" /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-bold tracking-tight">{value}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>
        </div>
      </CardContent>
    </Card>
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
      {items.length ? items.map((item) => <p key={item} className="line-clamp-2 rounded-md bg-white p-2 text-sm leading-6 text-slate-700">{item}</p>) : <p className="text-sm text-muted-foreground">データなし</p>}
    </div>
  );
}

function Range({ label, value, primary = false }: { label: string; value: number | null | undefined; primary?: boolean }) {
  return <div className={primary ? "rounded-lg bg-primary p-3 text-primary-foreground" : "rounded-lg bg-secondary p-3"}><p className="text-xs font-semibold opacity-75">{label}</p><p className="mt-1 text-lg font-bold">{formatPrice(value)}</p></div>;
}

function bestScoredBacktest(backtests: BacktestRun[]) {
  return [...backtests].filter((run) => run.metrics?.brierScore !== null && run.metrics?.brierScore !== undefined).sort((a, b) => scoreBacktest(a) - scoreBacktest(b))[0] ?? null;
}

function scoreBacktest(run: BacktestRun) {
  const brier = run.metrics?.brierScore ?? 999;
  const logLoss = run.metrics?.logLoss ?? 999;
  const returnPenalty = Math.max(0, -(run.metrics?.returnPct ?? 0));
  return brier * 2 + logLoss + returnPenalty;
}

function formatPrice(value: number | null | undefined) {
  return value ? `$${price.format(value)}` : "-";
}

function formatNumber(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function formatPct(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${(value * 100).toFixed(2)}%`;
}

function formatUsd(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `$${value.toFixed(2)}`;
}
