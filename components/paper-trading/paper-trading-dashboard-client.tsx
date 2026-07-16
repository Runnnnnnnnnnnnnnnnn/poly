"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Database,
  Gauge,
  LineChart,
  MinusCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
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
type Tone = "good" | "watch" | "bad" | "neutral";

type Signal = {
  label: string;
  description: string;
  tone: Tone;
  icon: LucideIcon;
};

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
  const modelSignal = getModelSignal(bestBacktest?.metrics?.brierScore);
  const profitSignal = getProfitSignal(latestMetrics?.totalReturnPct);

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
      setMessage("最新データを取得できませんでした。少し待ってから「画面を最新にする」を押してください。");
    }
  }, [asset]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function startRun() {
    setLoading(true);
    setMessage(mode === "live" ? "仮想運用を開始しています…" : "仮想の売買検証を実行しています…");
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
      if (!response.ok) throw new Error("仮想の売買検証を実行できませんでした");
      setMessage(mode === "live" ? "仮想運用を開始しました" : "仮想の売買検証が完了しました");
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
      if (!response.ok) throw new Error("市場価格の検証に失敗しました");
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
    setMessage("最新の市場データを保存しています…");
    try {
      const response = await fetch("/api/backtests/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assets: [asset], limit: Number(maxMarkets) || 40 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error("最新データを保存できませんでした");
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
              トレード用の予測モデルを作るために、市場価格がどれくらい当たったかを、損益・予測誤差・最大下落で確認します。実注文は出さず、仮想の売買だけを記録します。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
            実注文なし
          </div>
        </div>
      </section>

      <WorkflowExplainer />

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <VisualStatusPanel
          activeRun={activeRun}
          latestRun={latestRun}
          bestBacktest={bestBacktest}
          modelSignal={modelSignal}
          profitSignal={profitSignal}
          updatedAt={updatedAt}
        />
        <Card className="overflow-hidden">
          <CardHeader className="border-b bg-slate-50/70">
            <CardTitle>ひと目で見る指標</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
            <MetricCard icon={Wallet} label="直近の損益" value={formatPct(latestMetrics?.totalReturnPct)} sub={latestRun ? modeLabel(latestRun.mode) : "-"} tone={profitSignal.tone} meter={profitMeter(latestMetrics?.totalReturnPct)} />
            <MetricCard icon={BarChart3} label="予測誤差" value={formatNumber(latestMetrics?.brierScore, 3)} sub="低いほど正確" tone={getModelSignal(latestMetrics?.brierScore).tone} meter={errorMeter(latestMetrics?.brierScore)} />
            <MetricCard icon={TrendingDown} label="最大下落" value={formatPct(latestMetrics?.maxDrawdownPct)} sub="小さいほど安定" tone={drawdownTone(latestMetrics?.maxDrawdownPct)} meter={drawdownMeter(latestMetrics?.maxDrawdownPct)} />
            <MetricCard icon={LineChart} label="最良スコア" value={formatNumber(bestBacktest?.metrics?.brierScore, 3)} sub={bestBacktest ? `${bestBacktest.asset} / 予測誤差` : "-"} tone={modelSignal.tone} meter={errorMeter(bestBacktest?.metrics?.brierScore)} />
          </CardContent>
        </Card>
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
              <p>{bestBacktest ? `最新の比較対象: ${bestBacktest.asset}` : "まず「基準を作る」を押してください"}</p>
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
            <GuideStep number="3" title="失敗確認" body="外れた市場と理由を確認する" />
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
            <ForecastRangeTrack forecast={forecast} />
            <details className="rounded-lg border border-border bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-bold text-slate-800">指標の読み方</summary>
              <div className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground sm:grid-cols-2">
                <p>予測誤差: 確率の外れ幅。低いほど正確。</p>
                <p>大外しペナルティ: 自信を持って外した時に大きく悪化。</p>
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
              <Button onClick={() => void startRun()} disabled={loading || Boolean(activeRun)}><Play className="h-4 w-4" />仮想売買を試す</Button>
              <Button variant="outline" onClick={() => void runBaselineBacktest()} disabled={loading}><BarChart3 className="h-4 w-4" />基準を作る</Button>
              <Button variant="outline" onClick={() => void collectSnapshot()} disabled={loading}><Database className="h-4 w-4" />最新データを保存</Button>
              <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="h-4 w-4" />画面を最新にする</Button>
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

function WorkflowExplainer() {
  return (
    <section className="grid gap-3 rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5 md:grid-cols-3">
      <WorkflowStep
        icon={Database}
        title="1. データを保存"
        body="今の市場価格を記録し、あとで比較できる材料にします。"
      />
      <WorkflowStep
        icon={BarChart3}
        title="2. 基準を作る"
        body="市場価格だけでどれくらい当たるかを過去データで確認します。"
      />
      <WorkflowStep
        icon={Play}
        title="3. 仮想売買を試す"
        body="実注文なしで、損益と失敗パターンを記録します。"
      />
    </section>
  );
}

function WorkflowStep({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md bg-slate-50 p-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="font-bold text-slate-950">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function VisualStatusPanel({
  activeRun,
  latestRun,
  bestBacktest,
  modelSignal,
  profitSignal,
  updatedAt,
}: {
  activeRun: Run | null;
  latestRun: Run | undefined;
  bestBacktest: BacktestRun | null;
  modelSignal: Signal;
  profitSignal: Signal;
  updatedAt: string | null;
}) {
  const runSignal: Signal = activeRun
    ? {
        label: "稼働中",
        description: `${activeRun.asset}を自動更新しています`,
        tone: "good",
        icon: Activity,
      }
    : {
        label: "停止中",
        description: "必要な時だけ検証を開始できます",
        tone: "neutral",
        icon: MinusCircle,
      };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b bg-slate-50/70">
        <CardTitle>全体の見取り図</CardTitle>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-muted-foreground shadow-sm">
          {updatedAt ? new Date(updatedAt).toLocaleTimeString("ja-JP") : "更新待ち"}
        </span>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="grid gap-3 md:grid-cols-3">
          <SignalTile title="運用状態" signal={runSignal} pulse={Boolean(activeRun)} />
          <SignalTile title="モデル判定" signal={modelSignal} />
          <SignalTile title="損益傾向" signal={profitSignal} />
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-slate-950">次に見るポイント</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{nextActionText(activeRun, latestRun, bestBacktest)}</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${tonePillClass(modelSignal.tone)}`}>{modelSignal.label}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <ChecklistItem active={Boolean(bestBacktest)} label="過去検証あり" />
            <ChecklistItem active={Boolean(latestRun?.metrics)} label="損益データあり" />
            <ChecklistItem active={Boolean(activeRun)} label="自動更新中" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SignalTile({ title, signal, pulse = false }: { title: string; signal: Signal; pulse?: boolean }) {
  const Icon = signal.icon;
  return (
    <div className={`rounded-lg p-3 ${toneSoftClass(signal.tone)}`}>
      <div className="flex items-start gap-3">
        <span className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${toneIconClass(signal.tone)}`}>
          {pulse ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-30" /> : null}
          <Icon className="relative h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground">{title}</p>
          <p className="mt-1 text-lg font-bold leading-tight text-slate-950">{signal.label}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{signal.description}</p>
        </div>
      </div>
    </div>
  );
}

function ChecklistItem({ active, label }: { active: boolean; label: string }) {
  return (
    <div className={active ? "flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700" : "flex items-center gap-2 rounded-md bg-white px-3 py-2 text-xs font-bold text-muted-foreground"}>
      {active ? <CheckCircle2 className="h-4 w-4" /> : <MinusCircle className="h-4 w-4" />}
      {label}
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
        {sorted.map((run, index) => {
          const signal = getModelSignal(run.metrics?.brierScore);
          return (
            <button key={run.id} type="button" onClick={() => onSelect(run.id)} className="grid gap-3 rounded-md border border-border p-3 text-left hover:border-primary/40 hover:bg-accent">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-bold text-slate-950">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">{index + 1}</span>
                  <span className="break-words">{run.asset} / 判定基準 {formatPct(run.threshold)}</span>
                </span>
                <QualityPill signal={signal} />
              </div>
              <VisualMeter tone={signal.tone} value={errorMeter(run.metrics?.brierScore)} />
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                <span>予測誤差 <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
                <span>大外し <b className="text-slate-950">{formatNumber(run.metrics?.logLoss, 3)}</b></span>
                <span>損益 <b className={run.metrics?.returnPct && run.metrics.returnPct > 0 ? "text-emerald-700" : "text-slate-950"}>{formatPct(run.metrics?.returnPct)}</b></span>
                <span>市場数 <b className="text-slate-950">{run.metrics?.markets ?? 0}</b></span>
              </div>
            </button>
          );
        })}
        {!sorted.length ? <p className="p-4 text-sm text-muted-foreground">まだ過去検証の履歴がありません。「基準を作る」を実行してください。</p> : null}
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
        {runs.slice(0, 8).map((run) => {
          const signal = getProfitSignal(run.metrics?.totalReturnPct);
          return (
          <button key={run.id} type="button" onClick={() => onSelect(run.id)} className={`grid gap-3 rounded-md border p-3 text-left hover:border-primary/40 hover:bg-accent ${toneBorderClass(signal.tone)}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold text-slate-950">{run.asset} / {modeLabel(run.mode)}</span>
              <span className={run.status === "running" ? "rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700" : "rounded-full bg-secondary px-2 py-1 text-xs font-semibold"}>{statusLabel(run.status)}</span>
            </div>
            <VisualMeter tone={signal.tone} value={profitMeter(run.metrics?.totalReturnPct)} />
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>損益 <b className={signal.tone === "good" ? "text-emerald-700" : signal.tone === "bad" ? "text-rose-700" : "text-slate-950"}>{formatPct(run.metrics?.totalReturnPct)}</b></span>
              <span>予測誤差 <b className="text-slate-950">{formatNumber(run.metrics?.brierScore, 3)}</b></span>
              <span>最大下落 <b className="text-slate-950">{formatPct(run.metrics?.maxDrawdownPct)}</b></span>
              <span>約定数 <b className="text-slate-950">{run.metrics?.filledOrders ?? 0}</b></span>
            </div>
          </button>
          );
        })}
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
            <MiniMetric label="大外し" value={formatNumber(backtest.metrics?.logLoss, 3)} />
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

function MetricCard({ icon: Icon, label, value, sub, tone = "neutral", meter = 0 }: { icon: LucideIcon; label: string; value: string; sub: string; tone?: Tone; meter?: number }) {
  return (
    <div className={`rounded-lg border bg-white p-4 shadow-sm ${toneBorderClass(tone)}`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneIconClass(tone)}`}><Icon className="h-5 w-5" /></span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-bold tracking-tight">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        </div>
      </div>
      <VisualMeter tone={tone} value={meter} className="mt-3" />
    </div>
  );
}

function ForecastRangeTrack({ forecast }: { forecast: Forecast | null }) {
  const p10 = forecast?.quantiles.p10;
  const p25 = forecast?.quantiles.p25;
  const median = forecast?.impliedMedian;
  const p90 = forecast?.quantiles.p90;
  const values = [p10, p25, median, p90].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length < 3) {
    return (
      <div className="rounded-lg bg-slate-50 p-3 text-sm text-muted-foreground">
        予想レンジを描画するには、もう少し市場データが必要です。
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const marker = percentBetween(median ?? min, min, max);
  const low = percentBetween(p10 ?? min, min, max);
  const high = percentBetween(p90 ?? max, min, max);

  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <div className="flex items-center justify-between gap-3 text-xs font-semibold text-muted-foreground">
        <span>弱気</span>
        <span>市場の中心</span>
        <span>強気</span>
      </div>
      <div className="relative mt-4 h-4 rounded-full bg-slate-200">
        <div
          className="absolute top-0 h-4 rounded-full bg-gradient-to-r from-sky-300 via-primary to-emerald-300"
          style={{ left: `${low}%`, width: `${Math.max(6, high - low)}%` }}
        />
        <div className="absolute -top-2 h-8 w-1.5 rounded-full bg-slate-950 shadow" style={{ left: `calc(${marker}% - 3px)` }} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{formatPrice(min)}</span>
        <span className="rounded-full bg-primary px-3 py-1 font-bold text-primary-foreground">中央値 {formatPrice(median)}</span>
        <span>{formatPrice(max)}</span>
      </div>
    </div>
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

function getModelSignal(value: number | null | undefined): Signal {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return {
      label: "データ待ち",
      description: "基準を作ると判定できます",
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

function nextActionText(activeRun: Run | null, latestRun: Run | undefined, bestBacktest: BacktestRun | null) {
  if (!bestBacktest) return "まず「基準を作る」を押して、市場価格だけの比較基準を作ります。";
  if (!latestRun?.metrics) return "次に「仮想売買を試す」を押して、損益と予測誤差を記録します。";
  if (!activeRun) return "リアルタイムで見たい場合は、検証方法をリアルタイムにして開始します。";
  return "自動更新中です。成績比較と検証履歴の色を見て、悪化していないか確認します。";
}

function errorMeter(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return 100 - clamp((value / 0.2) * 100, 0, 100);
}

function profitMeter(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return clamp(50 + value * 500, 5, 100);
}

function drawdownMeter(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return 100 - clamp((value / 0.25) * 100, 0, 100);
}

function drawdownTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value)) return "neutral";
  if (value <= 0.05) return "good";
  if (value <= 0.15) return "watch";
  return "bad";
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

function percentBetween(value: number, min: number, max: number) {
  if (max <= min) return 50;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
