"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Database,
  Gauge,
  MinusCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Target,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchLocalApi, isSnapshotMode } from "@/src/lib/localApiClient";

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

type AiHistorySummary = {
  total: number;
  pending: number;
  resolved: number;
  averageBrierScore: number | null;
  averageMarketBrierScore: number | null;
  improvementVsMarket: number | null;
  latestRecordedAt: string | null;
};

type AiEvaluationsResponse = {
  status: string;
  updatedAt: string;
  model: string;
  historySummary: AiHistorySummary;
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

type ModelDecision = Signal & {
  reason: string;
  nextStep: string;
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
  const [aiEvaluations, setAiEvaluations] = useState<AiEvaluationsResponse | null>(null);
  const [selectedPaperRun, setSelectedPaperRun] = useState<PaperRunDetail | null>(null);
  const [selectedBacktest, setSelectedBacktest] = useState<BacktestRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState("準備完了");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(false);
  const refreshingRef = useRef(false);
  const lastAiFetchAtRef = useRef(0);

  const activeRun = useMemo(() => runs.find((run) => run.asset === asset && run.status === "running") ?? null, [asset, runs]);
  const latestPaperRun = useMemo(
    () => runs
      .filter((run) => run.asset === asset && run.status !== "running" && run.metrics)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null,
    [asset, runs],
  );
  const bestBacktest = useMemo(() => bestScoredBacktest(backtests, asset), [asset, backtests]);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const staticMode = isSnapshotMode();
      setSnapshot(staticMode);
      if (staticMode) {
        const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
        const response = await fetch(`${base}/ai-evaluations.json`, { cache: "no-store" });
        if (response.ok) setAiEvaluations(await response.json());
        setMessage("公開版は保存データの閲覧専用です。仮想売買を実行するにはAPIへ接続してください。");
        setUpdatedAt(new Date().toISOString());
        return;
      }
      const shouldFetchAi = !aiEvaluations || Date.now() - lastAiFetchAtRef.current >= 60_000;
      const [runsPayload, forecastPayload, backtestsPayload, aiPayload] = await Promise.all([
        fetchLocalApi<{ items: Run[] }>("/api/paper-trading/runs"),
        fetchLocalApi<Forecast>(`/api/backtests/forecast?asset=${asset}`),
        fetchLocalApi<{ items: BacktestRun[] }>("/api/backtests?limit=20"),
        shouldFetchAi ? fetchLocalApi<AiEvaluationsResponse>("/api/ai/evaluations") : Promise.resolve(null),
      ]);
      setRuns(runsPayload.items ?? []);
      setForecast(forecastPayload);
      setBacktests(backtestsPayload.items ?? []);
      if (aiPayload) {
        setAiEvaluations(aiPayload);
        lastAiFetchAtRef.current = Date.now();
      }
      setUpdatedAt(new Date().toISOString());
    } catch (error) {
      setMessage(error instanceof Error && /401/.test(error.message) ? "APIの接続キーが確認できません。接続URLを発行し直してください。" : "最新データを取得できませんでした。少し待ってから「画面を最新にする」を押してください。");
    } finally {
      refreshingRef.current = false;
    }
  }, [aiEvaluations, asset]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function startRun() {
    setLoading(true);
    setMessage(mode === "live" ? "継続観察を開始しています…" : "仮想売買を検証しています…");
    try {
      const result = await fetchLocalApi<PaperRunDetail>("/api/paper-trading/runs", {
        method: "POST",
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
      setMessage(mode === "live" ? "継続観察を開始しました" : "仮想売買の検証が完了しました");
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
    <div className="space-y-5 pb-24">
      <section className="rounded-lg border border-border bg-white p-5 shadow-sm md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-sm font-bold text-primary"><Activity className="h-4 w-4" />モデル検証</div>
            <h1 className="break-words text-2xl font-bold leading-tight tracking-tight text-slate-950 md:text-3xl">予測モデルの成績を見る</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              実注文なしで、市場価格の予測精度と仮想売買の損益を確認します。
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
            {snapshot ? "公開版・閲覧専用" : "実注文なし"}
          </div>
        </div>
      </section>

      <WorkflowExplainer />

      <ModelSummaryPanel asset={asset} aiEvaluations={aiEvaluations} bestBacktest={bestBacktest} latestPaperRun={latestPaperRun} activeRun={activeRun} updatedAt={updatedAt} />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-start justify-between space-y-0 border-b bg-slate-50/70">
            <div><CardTitle>参考：市場価格の予想レンジ</CardTitle><p className="mt-1 text-xs text-muted-foreground">DeepSeekの判定とは別に、市場価格だけから{forecast?.marketCount ?? 0}件を集計</p></div>
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
          <CardHeader className="border-b bg-slate-50/70">
            <CardTitle>検証を開始</CardTitle>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">過去の成績を確認するか、最新データを追跡します。</p>
          </CardHeader>
          <CardContent className="space-y-4 pt-5">
            <div>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">対象</p>
              <div className="grid grid-cols-4 gap-2">
                {assets.map((item) => (
                  <button key={item} type="button" onClick={() => setAsset(item)} disabled={snapshot} className={`h-10 rounded-lg border text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${asset === item ? "border-primary bg-primary text-primary-foreground shadow-sm" : "bg-background text-muted-foreground hover:bg-accent"}`}>{item}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">確認方法</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => setMode("historical")} disabled={snapshot} className={`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === "historical" ? "border-primary bg-primary/5 shadow-sm" : "bg-background hover:bg-accent"}`}>
                  <span className={`text-sm font-bold ${mode === "historical" ? "text-primary" : "text-slate-950"}`}>過去検証</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">過去の結果と比べる</span>
                </button>
                <button type="button" onClick={() => setMode("live")} disabled={snapshot} className={`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === "live" ? "border-primary bg-primary/5 shadow-sm" : "bg-background hover:bg-accent"}`}>
                  <span className={`text-sm font-bold ${mode === "live" ? "text-primary" : "text-slate-950"}`}>継続観察</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">最新データを追跡する</span>
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => void startRun()} disabled={loading || snapshot || Boolean(activeRun)}><Play className="h-4 w-4" />{mode === "live" ? "継続観察を開始" : "仮想売買を試す"}</Button>
              <Button variant="outline" onClick={() => void runBaselineBacktest()} disabled={loading || snapshot}><BarChart3 className="h-4 w-4" />市場価格で過去検証</Button>
            </div>
            <p className="text-xs text-muted-foreground">実注文は発生しません。</p>
            <details className="rounded-lg border border-border bg-slate-50 p-3">
              <summary className="cursor-pointer text-sm font-bold text-slate-800">条件とデータ更新</summary>
              <div className="mt-3 grid gap-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1.5 text-xs font-semibold">初期資金<input disabled={snapshot} value={initialCash} onChange={(event) => setInitialCash(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal disabled:opacity-50" /></label>
                  <label className="grid gap-1.5 text-xs font-semibold">売買に必要な差<input disabled={snapshot} value={entryEdge} onChange={(event) => setEntryEdge(event.target.value)} inputMode="decimal" className="h-10 rounded-lg border bg-background px-2.5 font-normal disabled:opacity-50" /></label>
                  <label className="grid gap-1.5 text-xs font-semibold">見る市場数<input disabled={snapshot} value={maxMarkets} onChange={(event) => setMaxMarkets(event.target.value)} inputMode="numeric" className="h-10 rounded-lg border bg-background px-2.5 font-normal disabled:opacity-50" /></label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => void collectSnapshot()} disabled={loading || snapshot}><Database className="h-4 w-4" />データを保存</Button>
                  <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="h-4 w-4" />画面を更新</Button>
                </div>
              </div>
            </details>
            {activeRun ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => void tickRun()} disabled={loading || snapshot}><Target className="h-4 w-4" />今すぐ1回更新</Button>
                <Button variant="outline" size="sm" onClick={() => void stopRun()} disabled={loading || snapshot}><Square className="h-4 w-4" />停止</Button>
              </div>
            ) : null}
            <div className="grid gap-2 border-t pt-3 text-xs text-muted-foreground">
              <p>{message}</p>
              <p className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{activeRun ? `${activeRun.asset}を継続観察中` : "継続観察は停止中"}</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <ScoreboardCard asset={asset} backtests={backtests} onSelect={(id) => void loadBacktest(id)} />
        <PaperRunsCard asset={asset} runs={runs} updatedAt={updatedAt} onSelect={(id) => void loadPaperRun(id)} />
      </section>

      <DetailPanel paperRun={selectedPaperRun} backtest={selectedBacktest} loading={detailLoading} />
    </div>
  );
}

function WorkflowExplainer() {
  return (
    <section className="rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5" aria-label="検証の流れ">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold text-slate-950">検証の流れ</h2>
        <p className="text-xs text-muted-foreground">過去検証 → 仮想売買 → 継続観察</p>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
      <WorkflowStep
        icon={BarChart3}
        title="1. 過去検証"
        body="市場価格だけで、どれくらい当たるかを確認します。"
      />
      <WorkflowStep
        icon={Play}
        title="2. 仮想売買"
        body="実注文なしで、損益と失敗パターンを確認します。"
      />
      <WorkflowStep
        icon={Activity}
        title="3. 継続観察"
        body="新しいデータで、成績が続くかを追跡します。"
      />
      </div>
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

function ModelSummaryPanel({
  asset,
  aiEvaluations,
  bestBacktest,
  latestPaperRun,
  activeRun,
  updatedAt,
}: {
  asset: string;
  aiEvaluations: AiEvaluationsResponse | null;
  bestBacktest: BacktestRun | null;
  latestPaperRun: Run | null;
  activeRun: Run | null;
  updatedAt: string | null;
}) {
  const decision = aiEvaluations ? getAiModelDecision(aiEvaluations.historySummary) : getModelDecision(bestBacktest);
  const DecisionIcon = decision.icon;
  const paperSignal = getProfitSignal(latestPaperRun?.metrics?.totalReturnPct);
  const paperValue = latestPaperRun ? formatPct(latestPaperRun.metrics?.totalReturnPct) : activeRun ? "計測中" : "未実行";
  const paperNote = latestPaperRun ? `${modeLabel(latestPaperRun.mode)}の結果` : activeRun ? "結果が出るまで待機" : "仮想売買の結果なし";
  const nextStep = activeRun ? `${activeRun.asset}の新しい結果を待ちます。` : decision.nextStep;
  const aiSummary = aiEvaluations?.historySummary;
  const aiValue = formatNumber(aiSummary?.averageBrierScore, 3);
  const aiNote = aiSummary ? `${aiSummary.resolved}件確定 / 市場との差 ${formatSignedNumber(aiSummary.improvementVsMarket)}` : "まだ結果が確定していません";

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between space-y-0 border-b bg-slate-50/70">
        <div>
          <CardTitle>現在の判定</CardTitle>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">DeepSeekの結果確定分と、市場価格を基準にした検証を分けて表示しています。</p>
        </div>
        <span className="shrink-0 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">実注文なし</span>
      </CardHeader>
      <CardContent className="grid gap-4 pt-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(280px,0.95fr)]">
        <div className={`rounded-lg p-4 ${toneSoftClass(decision.tone)}`}>
          <div className="flex items-start gap-3">
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${toneIconClass(decision.tone)}`}><DecisionIcon className="h-6 w-6" /></span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-muted-foreground">モデルの信頼度</p>
              <p className="mt-1 text-2xl font-bold leading-tight text-slate-950">{decision.label}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{decision.description}</p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <SummaryMetric label="DeepSeek AI" value={aiValue} note={aiNote} tone={decision.tone} />
            <SummaryMetric label={`${asset}市場価格`} value={formatNumber(bestBacktest?.metrics?.brierScore, 3)} note={bestBacktest ? `${bestBacktest.metrics?.markets ?? 0}市場 / ${bestBacktest.metrics?.observations ?? 0}時点` : "まだ実行されていません"} tone="neutral" />
            <SummaryMetric label="仮想売買" value={paperValue} note={paperNote} tone={paperSignal.tone} />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-white p-4">
          <p className="text-sm font-bold text-slate-950">判定の根拠</p>
          <div className="mt-3 grid gap-3">
            <SummaryReason title="AI予測誤差" value={aiSummary ? formatNumber(aiSummary.averageBrierScore, 3) : "未計測"} note="小さいほど、AIの確率と結果の差が小さい" />
            <SummaryReason title="市場との比較" value={aiSummary ? formatSignedNumber(aiSummary.improvementVsMarket) : "未計測"} note={decision.reason} />
            <SummaryReason title="市場価格基準" value={bestBacktest ? `${bestBacktest.metrics?.markets ?? 0}市場` : "未実行"} note="市場価格だけで同じ結果を確認" />
            <SummaryReason title="次にすること" value={activeRun ? "継続観察中" : "必要な時に実行"} note={nextStep} />
          </div>
        </div>
      </CardContent>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <span>{activeRun ? `${activeRun.asset}を継続観察中` : "継続観察は停止中"}</span>
        <span>{updatedAt ? `最終更新 ${new Date(updatedAt).toLocaleTimeString("ja-JP")}` : "更新待ち"}</span>
      </div>
    </Card>
  );
}

function SummaryMetric({ label, value, note, tone }: { label: string; value: string; note: string; tone: Tone }) {
  return (
    <div className={`rounded-md border px-3 py-2.5 ${toneBorderClass(tone)}`}>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{note}</p>
    </div>
  );
}

function SummaryReason({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs font-semibold text-muted-foreground">{title}</p>
          <p className="text-sm font-bold text-slate-950">{value}</p>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

function ScoreboardCard({ asset, backtests, onSelect }: { asset: string; backtests: BacktestRun[]; onSelect: (id: string) => void }) {
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
            <button key={run.id} type="button" onClick={() => onSelect(run.id)} className="grid gap-3 rounded-md border border-border p-3 text-left hover:border-primary/40 hover:bg-accent">
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

function PaperRunsCard({ asset, runs, updatedAt, onSelect }: { asset: string; runs: Run[]; updatedAt: string | null; onSelect: (id: string) => void }) {
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
          <button key={run.id} type="button" onClick={() => onSelect(run.id)} className={`grid gap-3 rounded-md border p-3 text-left hover:border-primary/40 hover:bg-accent ${toneBorderClass(signal.tone)}`}>
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

function bestScoredBacktest(backtests: BacktestRun[], asset: string) {
  return [...backtests]
    .filter((run) => run.asset === asset && run.metrics?.brierScore !== null && run.metrics?.brierScore !== undefined)
    .sort((a, b) => {
      const sampleDifference = (b.metrics?.markets ?? 0) - (a.metrics?.markets ?? 0);
      if ((a.metrics?.markets ?? 0) < 10 || (b.metrics?.markets ?? 0) < 10) return sampleDifference;
      return (a.metrics?.brierScore ?? Number.POSITIVE_INFINITY) - (b.metrics?.brierScore ?? Number.POSITIVE_INFINITY) || sampleDifference;
    })[0] ?? null;
}

function scoreBacktest(run: BacktestRun) {
  return run.metrics?.brierScore ?? Number.POSITIVE_INFINITY;
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

function getModelDecision(run: BacktestRun | null): ModelDecision {
  const metrics = run?.metrics;
  const score = metrics?.brierScore;
  if (!metrics || score === null || score === undefined || !Number.isFinite(score)) {
    return {
      label: "未検証",
      description: "過去検証を実行すると、モデルの信頼度を判定できます。",
      tone: "neutral",
      icon: Gauge,
      reason: "まだ比較できる過去検証がありません。",
      nextStep: "市場価格で過去検証を実行し、最初の基準を作ります。",
    };
  }
  const marketCount = metrics.markets;
  if (marketCount < 10) {
    return {
      label: "データ不足",
      description: "結果は出ていますが、判断にはもう少し市場数が必要です。",
      tone: "watch",
      icon: AlertCircle,
      reason: `${marketCount}市場を確認。10市場未満のため慎重に見ます。`,
      nextStep: "データを追加して、同じ傾向が続くか確認します。",
    };
  }
  const signal = getModelSignal(score);
  return {
    ...signal,
    reason: `${marketCount}市場を確認。結果が増えるほど判断が安定します。`,
    nextStep: signal.tone === "good" ? "仮想売買の損益も確認し、安定しているか見ます。" : "市場数を増やし、同じ結果が出るか確認します。",
  };
}

function getAiModelDecision(summary: AiHistorySummary | undefined): ModelDecision {
  if (!summary || summary.resolved === 0 || summary.averageBrierScore === null) {
    return {
      label: "結果待ち",
      description: "市場が確定するまで、AIの成績は判定しません。",
      tone: "neutral",
      icon: Gauge,
      reason: `${summary?.pending ?? 0}件が結果待ちです。未確定の予想を成績に含めていません。`,
      nextStep: "市場が確定した後に、AIと市場価格の誤差を比較します。",
    };
  }
  if (summary.resolved < 10) {
    return {
      label: "データ不足",
      description: "確定結果が少ないため、良し悪しを断定しません。",
      tone: "watch",
      icon: AlertCircle,
      reason: `${summary.resolved}件が確定。10件以上になるまで参考値として扱います。`,
      nextStep: "予想を継続し、確定件数を増やします。",
    };
  }
  const improvement = summary.improvementVsMarket;
  if (improvement === null) {
    return {
      label: "比較待ち",
      description: "市場価格との比較値がまだありません。",
      tone: "watch",
      icon: AlertCircle,
      reason: `${summary.resolved}件が確定していますが、比較値を計算できません。`,
      nextStep: "次回更新で市場価格との比較を再計算します。",
    };
  }
  if (improvement >= 0.005) {
    return {
      label: "市場より良好",
      description: "確定結果では、AIの確率誤差が市場価格より小さい状態です。",
      tone: "good",
      icon: CheckCircle2,
      reason: `${summary.resolved}件で、AI ${formatNumber(summary.averageBrierScore, 3)} / 市場 ${formatNumber(summary.averageMarketBrierScore, 3)}。`,
      nextStep: "仮想売買の損益と、別期間でも同じ傾向が続くか確認します。",
    };
  }
  if (improvement <= -0.005) {
    return {
      label: "市場より弱い",
      description: "現時点では、市場価格を上回る根拠が確認できません。",
      tone: "bad",
      icon: AlertCircle,
      reason: `${summary.resolved}件で、AI ${formatNumber(summary.averageBrierScore, 3)} / 市場 ${formatNumber(summary.averageMarketBrierScore, 3)}。`,
      nextStep: "ニュースの関連性、確率の補正、対象テーマを見直します。",
    };
  }
  return {
    label: "差は小さい",
    description: "市場価格との差は小さく、優位性はまだ確認できません。",
    tone: "watch",
    icon: AlertCircle,
    reason: `${summary.resolved}件で比較。AIと市場の差は${formatSignedNumber(improvement)}です。`,
    nextStep: "確定件数を増やして、偶然ではないか確認します。",
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

function formatSignedNumber(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}

function formatUsd(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : `$${value.toFixed(2)}`;
}
