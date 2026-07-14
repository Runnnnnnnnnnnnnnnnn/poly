"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Database, Play, RefreshCw, ShieldCheck, Square, Target, TrendingDown, Wallet, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Run = {
  id: string;
  accountId: string;
  asset: string;
  mode: "historical" | "live";
  strategy: string;
  status: string;
  initialCash: number;
  finalCash: number | null;
  metrics: {
    totalReturnPct?: number;
    orders?: number;
    filledOrders?: number;
    totalFees?: number;
    maxDrawdownPct?: number;
    winRate?: number | null;
    brierScore?: number | null;
    logLoss?: number | null;
    sharpeLike?: number | null;
  } | null;
  startedAt: string;
  completedAt: string | null;
};

type Forecast = {
  asset: string;
  targetDate: string | null;
  marketCount: number;
  impliedMedian: number | null;
  quantiles: { p10: number | null; p25: number | null; p75: number | null; p90: number | null };
};

const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const assets = ["BTC", "ETH", "SOL", "XRP"];

export function PaperTradingDashboardClient() {
  const [asset, setAsset] = useState("BTC");
  const [mode, setMode] = useState<"historical" | "live">("historical");
  const [initialCash, setInitialCash] = useState("10000");
  const [entryEdge, setEntryEdge] = useState("0.03");
  const [maxMarkets, setMaxMarkets] = useState("20");
  const [runs, setRuns] = useState<Run[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("準備完了");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const activeRun = useMemo(() => runs.find((run) => run.status === "running") ?? null, [runs]);

  const refresh = useCallback(async () => {
    try {
      const [runsResponse, forecastResponse] = await Promise.all([
        fetch("/api/paper-trading/runs", { cache: "no-store" }),
        fetch(`/api/backtests/forecast?asset=${asset}`, { cache: "no-store" }),
      ]);
      if (runsResponse.ok) {
        const payload = await runsResponse.json();
        setRuns(payload.items ?? []);
      }
      if (forecastResponse.ok) setForecast(await forecastResponse.json());
      setUpdatedAt(new Date().toISOString());
    } catch {
      setMessage("APIに接続できません。npm run dev:paper で統合起動してください。");
    }
  }, [asset]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function startRun() {
    setLoading(true);
    setMessage(mode === "live" ? "裏側のpaper workerを開始しています…" : "過去データをバックテストしています…");
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
      setMessage(mode === "live" ? "paper workerを開始しました" : "バックテストが完了しました");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "実行に失敗しました");
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

  const latestRun = runs[0];
  const latestMetrics = latestRun?.metrics;

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-border bg-white p-5 shadow-sm md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-primary"><Activity className="h-4 w-4" />Model Backtest</div>
            <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-slate-950 md:text-3xl">評価モデルをバックテスト</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              Polymarketの価格履歴を使い、売買前提ではなくモデルの確率精度・損益・リスクを検証します。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
            実注文なし
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Wallet} label="最新損益" value={latestMetrics?.totalReturnPct !== undefined ? `${(latestMetrics.totalReturnPct * 100).toFixed(2)}%` : "—"} sub={latestRun?.asset ?? "—"} />
        <MetricCard icon={BarChart3} label="Brier" value={latestMetrics?.brierScore != null ? latestMetrics.brierScore.toFixed(3) : "—"} sub="低いほど良い" />
        <MetricCard icon={TrendingDown} label="最大DD" value={latestMetrics?.maxDrawdownPct !== undefined ? `${(latestMetrics.maxDrawdownPct * 100).toFixed(2)}%` : "—"} sub="資産曲線" />
        <MetricCard icon={Zap} label="約定" value={String(latestMetrics?.filledOrders ?? 0)} sub={`注文 ${latestMetrics?.orders ?? 0}`} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-start justify-between space-y-0 border-b bg-slate-50/70">
            <div><CardTitle>市場インプライド予想</CardTitle><p className="mt-1 text-xs text-muted-foreground">{forecast?.marketCount ?? 0} markets</p></div>
            <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold shadow-sm">{forecast?.targetDate ?? "—"}</span>
          </CardHeader>
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{asset} / implied median</p><p className="mt-1 text-4xl font-bold tracking-tight text-primary sm:text-5xl">{forecast?.impliedMedian ? `$${price.format(forecast.impliedMedian)}` : "—"}</p></div>
              <div className="grid grid-cols-3 gap-4 text-right text-xs"><div><p className="text-muted-foreground">p10</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p10)}</p></div><div><p className="text-muted-foreground">p25</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p25)}</p></div><div><p className="text-muted-foreground">p90</p><p className="mt-1 font-bold">{formatPrice(forecast?.quantiles.p90)}</p></div></div>
            </div>
            <div className="space-y-2">
              <div className="relative h-3 rounded-full bg-slate-200"><div className="absolute inset-y-0 left-[10%] right-[10%] rounded-full bg-gradient-to-r from-cyan-400 via-primary to-fuchsia-400" /><span className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white bg-primary shadow" /></div>
              <div className="flex justify-between text-[11px] font-semibold text-muted-foreground"><span>p10</span><span>p25</span><span className="text-primary">中央値</span><span>p90</span></div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Range label="p10" value={forecast?.quantiles.p10} /><Range label="p25" value={forecast?.quantiles.p25} /><Range label="中央値" value={forecast?.impliedMedian} primary /><Range label="p90" value={forecast?.quantiles.p90} /></div>
            <details className="rounded-lg border border-border bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-bold text-slate-800">モデル評価で見る指標</summary>
              <div className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
                <p>Brier score: 確率予測の二乗誤差。低いほど安定。</p>
                <p>最大DD: 資産曲線の落ち込み。低いほど運用しやすい。</p>
                <p>Edge: 市場価格と補正後フェア確率の差。</p>
                <p>Log loss: 外れた高確信予想に厳しい指標。</p>
              </div>
            </details>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b bg-slate-50/70"><CardTitle>検証設定</CardTitle></CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Asset</p><div className="grid grid-cols-4 gap-2">{assets.map((item) => <button key={item} type="button" onClick={() => setAsset(item)} className={`h-10 rounded-lg border text-sm font-bold transition ${asset === item ? "border-primary bg-primary text-primary-foreground shadow-sm" : "bg-background text-muted-foreground hover:bg-accent"}`}>{item}</button>)}</div></div>
            <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Mode</p><div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary p-1"><button type="button" onClick={() => setMode("historical")} className={`h-9 rounded-md text-xs font-bold transition ${mode === "historical" ? "bg-white text-primary shadow-sm" : "text-muted-foreground"}`}>Backtest</button><button type="button" onClick={() => setMode("live")} className={`h-9 rounded-md text-xs font-bold transition ${mode === "live" ? "bg-white text-primary shadow-sm" : "text-muted-foreground"}`}>Live</button></div></div>
            <div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-1.5 text-xs font-semibold">残高<input value={initialCash} onChange={(event) => setInitialCash(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label><label className="grid gap-1.5 text-xs font-semibold">Edge<input value={entryEdge} onChange={(event) => setEntryEdge(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label><label className="grid gap-1.5 text-xs font-semibold">市場数<input value={maxMarkets} onChange={(event) => setMaxMarkets(event.target.value)} inputMode="numeric" className="h-10 rounded-lg border bg-background px-2.5 font-normal" /></label></div>
            <div className="flex flex-wrap gap-2"><Button className="flex-1" onClick={() => void startRun()} disabled={loading || Boolean(activeRun)}><Play className="h-4 w-4" />{mode === "live" ? "開始" : "実行"}</Button><Button variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} aria-label="更新"><RefreshCw className="h-4 w-4" /></Button>{activeRun ? <><Button variant="secondary" size="icon" onClick={() => void tickRun()} disabled={loading} aria-label="手動tick"><Target className="h-4 w-4" /></Button><Button variant="outline" size="icon" onClick={() => void stopRun()} disabled={loading} aria-label="停止"><Square className="h-4 w-4" /></Button></> : null}</div>
            <div className="grid gap-2 border-t pt-3 text-xs text-muted-foreground">
              <p>{message}</p>
              <p className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{activeRun ? `${activeRun.asset}のLive runが稼働中` : "Worker待機中"}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <details className="rounded-lg border border-border bg-white shadow-sm" open>
        <summary className="flex cursor-pointer items-center justify-between gap-3 border-b px-4 py-3">
          <span className="text-base font-bold text-slate-950">Run履歴</span>
          <span className="text-xs text-muted-foreground">{updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP") : "—"}</span>
        </summary>
        <div className="overflow-x-auto p-2">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="py-3 pr-4">Asset</th><th className="py-3 pr-4">Mode</th><th className="py-3 pr-4">Status</th><th className="py-3 pr-4">損益</th><th className="py-3 pr-4">Brier</th><th className="py-3 pr-4">最大DD</th><th className="py-3">開始</th></tr>
            </thead>
            <tbody>{runs.slice(0, 10).map((run) => <tr key={run.id} className="border-t"><td className="py-3 pr-4 font-bold">{run.asset}</td><td className="py-3 pr-4">{run.mode === "live" ? "Live" : "Backtest"}</td><td className="py-3 pr-4"><span className={run.status === "running" ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700" : "rounded-full bg-secondary px-2 py-1 text-xs font-semibold"}>{run.status}</span></td><td className="py-3 pr-4 font-semibold">{run.metrics?.totalReturnPct !== undefined ? `${(run.metrics.totalReturnPct * 100).toFixed(2)}%` : "—"}</td><td className="py-3 pr-4">{run.metrics?.brierScore != null ? run.metrics.brierScore.toFixed(3) : "—"}</td><td className="py-3 pr-4">{run.metrics?.maxDrawdownPct !== undefined ? `${(run.metrics.maxDrawdownPct * 100).toFixed(2)}%` : "—"}</td><td className="py-3 text-muted-foreground">{new Date(run.startedAt).toLocaleString("ja-JP")}</td></tr>)}</tbody>
          </table>
          {runs.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">—</p> : null}
        </div>
      </details>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, sub }: { icon: typeof Activity; label: string; value: string; sub: string }) {
  return <Card><CardContent className="flex items-start gap-3 p-5"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary"><Icon className="h-5 w-5" /></span><div className="min-w-0"><p className="text-xs font-semibold text-muted-foreground">{label}</p><p className="mt-1 truncate text-2xl font-bold tracking-tight">{value}</p><p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p></div></CardContent></Card>;
}

function Range({ label, value, primary = false }: { label: string; value: number | null | undefined; primary?: boolean }) {
  return <div className={primary ? "rounded-lg bg-primary p-3 text-primary-foreground" : "rounded-lg bg-secondary p-3"}><p className="text-xs font-semibold opacity-75">{label}</p><p className="mt-1 text-lg font-bold">{value ? `$${price.format(value)}` : "—"}</p></div>;
}

function formatPrice(value: number | null | undefined) {
  return value ? `$${price.format(value)}` : "—";
}
