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
    setMessage(mode === "live" ? "リアルタイム検証を開始しています…" : "過去検証を実行しています…");
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
      setMessage(mode === "live" ? "リアルタイム検証を開始しました" : "過去検証が完了しました");
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
    setMessage("市場価格の過去成績を検証しています…");
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
      setMessage("市場価格の過去成績を検証しました");
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
    setMessage("最新の市場データを取得しています…");
    try {
      const response = await fetch("/api/backtests/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assets: [asset], limit: Number(maxMarkets) || 40 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "collection failed");
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
    await fetch(`/api/paper-trading/runs/${activeRun.id}`, { method: "POST" });
    await refresh();
    await loadPaperRun(activeRun.id);
    setLoading(false);
    setMessage("1回分の更新を完了しました");
  }

  async function stopRun() {
    if (!activeRun) return;
    setLoading(true);
    await fetch(`/api/paper-trading/runs/${activeRun.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
    await refresh();
    setLoading(false);
    setMessage("リアルタイム検証を停止しました");
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
    <div className="space-y-5 pb-24">
      <section className="rounded-lg border border-border bg-white p-5 shadow-sm md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-primary"><Activity className="h-4 w-4" />モデル検証</div>
            <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-slate-950 md:text-3xl">予測モデルの成績を見る</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              市場価格がどれくらい当たったかを、損益・予測誤差・最大下落で確認します。実注文は出さず、検証用の売買だけを記録します。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
            実注文なし
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Wallet} label="直近の損益" value={formatPct(latestMetrics?.totalReturnPct)} sub={latestRun ? modeLabel(latestRun.mode) : "-"} />
        <MetricCard icon={BarChart3} label="予測誤差" value={formatNumber(latestMetrics?.brierScore, 3)} sub="低いほど正確" />
        <MetricCard icon={TrendingDown} label="最大下落" value={formatPct(latestMetrics?.maxDrawdownPct)} sub="小さいほど安定" />
        <MetricCard icon={LineChart} label="最良スコア" value={formatNumber(bestBacktest?.metrics?.brierScore, 3)} sub={bestBacktest ? `${bestBacktest.asset} / 予測誤差` : "-"} />
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader className="border-b bg-slate-50/70">
            <CardTitle>現在の状態</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={activeRun ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700" : "rounded-full bg-secondary px-3 py-1 text-xs font-bold text-muted-foreground"}>
                {activeRun ? "リアルタイム検証中" : "待機中"}
              </span>
              <span className="text-muted-foreground">{activeRun ? `${activeRun.asset}のリアルタイム検証を自動更新中` : message}</span>
            </div>
            <div className="grid gap-2 text-muted-foreground sm:grid-cols-2">
              <p>更新: {updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP") : "-"}</p>
              <p>{bestBacktest ? `最新の比較対象: ${bestBacktest.asset}` : "まず「市場価格を検証」を押してください"}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b bg-slate-50/70">
            <CardTitle>見る順番</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 pt-4 sm:grid-cols-3">
            <GuideStep number="1" title="予想レンジ" body="市場価格が織り込む価格帯を見る" />
            <GuideStep number="2" title="成績比較" body="予測誤差と損益を比べる" />
            <GuideStep number="3" title="詳細確認" body="外れた市場と理由を確認する" />
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-start justify-between space-y-0 border-b bg-slate-50/70">
            <div><CardTitle>市場価格から見た予想レンジ</CardTitle><p className="mt-1 text-xs text-muted-foreground">{forecast?.marketCount ?? 0}件の市場を集計</p></div>
            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">{forecast?.targetDate ? `対象日 ${forecast.targetDate}` : "-"}</span>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{asset} / 中央値</p>
                <p className="mt-1 text-4xl font-bold tracking-tight text-primary sm:text-5xl">{forecast?.impliedMedian ? `$${price.format(forecast.impliedMedian)}` : "-"}</p>
              </div>
              <div className="grid grid-cols-3 gap-4 text-right text-xs">
                <div><p className="text-muted-foreground">下位10%</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p10)}</p></div>
                <div><p className="text-muted-foreground">下位25%</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p25)}</p></div>
                <div><p className="text-muted-foreground">上位10%</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p90)}</p></div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Range label="下位10%" value={forecast?.quantiles.p10} />
              <Range label="下位25%" value={forecast?.quantiles.p25} />
              <Range label="中央値" value={forecast?.impliedMedian} primary />
              <Range label="上位10%" value={forecast?.quantiles.p90} />
            </div>
            <details className="rounded-lg border border-border bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-bold text-slate-800">指標の読み方</summary>
              <div className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
                <p>予測誤差: 確率の外れ幅。低いほど正確。</p>
                <p>外れ罰則: 自信を持って外した時に大きく悪化。</p>
                <p>最大下落: 検証中の資産の最大落ち込み。</p>
                <p>売買に必要な差: 市場価格とモデル確率の差。</p>
              </div>
            </details>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b bg-slate-50/70"><CardTitle>検証条件</CardTitle></CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">対象銘柄</p>
              <div className="grid grid-cols-4 gap-2">
                {assets.map((item) => (
                  <button key={item} type="button" onClick={() => setAsset(item)} className={`h-10 rounded-lg border text-sm font-bold transition ${asset === item ? "border-primary bg-primary text-primary-foreground shadow-sm" : "bg-background text-muted-foreground hover:bg-accent"}`}>{item}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">検証方法</p>
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary p-1">
                <button type="button" onClick={() => setMode("historical")} className={`h-9 rounded-md text-xs font-bold transition ${mode === "historical" ? "bg-white text-primary shadow-sm" : "text-muted-foreground"}`}>過去検証</button>
                <button type="button" onClick={() => setMode("live")} className={`h-9 rounded-md text-xs font-bold transition ${mode === "live" ? "bg-white text-primary shadow-sm" : "text-muted-foreground"}`}>リアルタイム</button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="grid gap-1.5 text-xs font-semibold">初期資金<input value={initialCash} onChange={(event) => setInitialCash(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label>
              <label className="grid gap-1.5 text-xs font-semibold">売買に必要な差<input value={entryEdge} onChange={(event) => setEntryEdge(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label>
              <label className="grid gap-1.5 text-xs font-semibold">見る市場数<input value={maxMarkets} onChange={(event) => setMaxMarkets(event.target.value)} inputMode="numeric" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => void startRun()} disabled={loading || Boolean(activeRun)}><Play className="h-4 w-4" />検証を実行</Button>
              <Button variant="outline" onClick={() => void runBaselineBacktest()} disabled={loading}><BarChart3 className="h-4 w-4" />市場価格を検証</Button>
              <Button variant="outline" onClick={() => void collectSnapshot()} disabled={loading}><Database className="h-4 w-4" />最新データ取得</Button>
              <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="h-4 w-4" />手動更新</Button>
            </div>
            {activeRun ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => void tickRun()} disabled={loading}><Target className="h-4 w-4" />1回だけ更新</Button>
                <Button variant="outline" size="sm" onClick={() => void stopRun()} disabled={loading}><Square className="h-4 w-4" />停止</Button>
              </div>
            ) : null}
            <div className="grid gap-2 border-t pt-3 text-xs text-muted-foreground">
              <p>{message}</p>
              <p className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{activeRun ? `${activeRun.asset}のリアルタイム検証中` : "リアルタイム検証は停止中"}</p>
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
        <span className="text-base font-bold text-slate-950">成績比較</span>
        <span className="text-xs text-muted-foreground">{backtests.length}件</span>
      </summary>
      <div className="grid gap-2 p-3">
        {sorted.map((run) => (
          <button key={run.id} type="button" onClick={() => onSelect(run.id)} className="grid gap-2 rounded-md border border-border p-3 text-left hover:border-primary/40 hover:bg-accent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-950">{run.asset} / 判定基準 {formatPct(run.threshold)}</span>
              <span className="rounded-full bg-secondary px-2 py-1 text-xs font-semibold">{statusLabel(run.status)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>予測誤差 <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
              <span>外れ罰則 <b className="text-slate-950">{formatNumber(run.metrics?.logLoss, 3)}</b></span>
              <span>損益 <b className="text-slate-950">{formatPct(run.metrics?.returnPct)}</b></span>
              <span>市場数 <b className="text-slate-950">{run.metrics?.markets ?? 0}</b></span>
            </div>
          </button>
        ))}
        {!sorted.length ? <p className="p-4 text-sm text-muted-foreground">まだ過去検証の履歴がありません。「市場価格を検証」を実行してください。</p> : null}
      </div>
    </details>
  );
}

function PaperRunsCard({ runs, updatedAt, onSelect }: { runs: Run[]; updatedAt: string | null; onSelect: (id: string) => void }) {
  return (
    <details className="rounded-lg border border-border bg-white shadow-sm" open>
      <summary className="flex cursor-pointer items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-base font-bold text-slate-950">検証履歴</span>
        <span className="text-xs text-muted-foreground">{updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP") : "-"}</span>
      </summary>
      <div className="grid gap-2 p-3">
        {runs.slice(0, 8).map((run) => (
          <button key={run.id} type="button" onClick={() => onSelect(run.id)} className="grid gap-2 rounded-md border border-border p-3 text-left hover:border-primary/40 hover:bg-accent">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-950">{run.asset} / {modeLabel(run.mode)}</span>
              <span className={run.status === "running" ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700" : "rounded-full bg-secondary px-2 py-1 text-xs font-semibold"}>{statusLabel(run.status)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>損益 <b className="text-slate-950">{formatPct(run.metrics?.totalReturnPct)}</b></span>
              <span>予測誤差 <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
              <span>最大下落 <b className="text-slate-950">{formatPct(run.metrics?.maxDrawdownPct)}</b></span>
              <span>約定数 <b className="text-slate-950">{run.metrics?.filledOrders ?? 0}</b></span>
            </div>
          </button>
        ))}
        {!runs.length ? <p className="p-4 text-sm text-muted-foreground">まだ検証履歴がありません。</p> : null}
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
            <h2 className="text-xl font-bold text-slate-950">検証の詳細</h2>
            <p className="text-sm text-muted-foreground">{paperRun.asset} / {modeLabel(paperRun.mode)} / {statusLabel(paperRun.status)}</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <MiniMetric label="損益" value={formatPct(paperRun.metrics?.totalReturnPct)} />
            <MiniMetric label="予測誤差" value={formatNumber(paperRun.metrics?.brierScore, 3)} />
            <MiniMetric label="最大下落" value={formatPct(paperRun.metrics?.maxDrawdownPct)} />
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
            <MiniMetric label="予測誤差" value={formatNumber(backtest.metrics?.brierScore, 3)} />
            <MiniMetric label="外れ罰則" value={formatNumber(backtest.metrics?.logLoss, 3)} />
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

function MetricCard({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4 sm:p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary"><Icon className="h-5 w-5" /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-bold tracking-tight">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function GuideStep({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-3 rounded-lg bg-slate-50 p-3">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{number}</span>
      <div className="min-w-0">
        <p className="font-bold text-slate-950">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
      </div>
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

function modeLabel(mode: Run["mode"]) {
  return mode === "live" ? "リアルタイム" : "過去検証";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    running: "実行中",
    completed: "完了",
    stopped: "停止",
    failed: "失敗",
    pending: "待機",
    filled: "約定",
    cancelled: "取消",
    open: "保有中",
    closed: "決済済み",
  };
  return labels[status] ?? status;
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
