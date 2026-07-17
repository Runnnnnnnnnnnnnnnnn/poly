"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Database,
  Gauge,
  Layers3,
  LockKeyhole,
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

type CombinedSignalRule = "polymarket-only" | "trend-confirmed" | "contrarian" | "hyperliquid-momentum" | "hyperliquid-reversion" | "hyperliquid-funding-carry" | "hyperliquid-funding-momentum" | "polymarket-funding-consensus";

type HoldoutSlice = {
  key: string;
  label: string;
  trades: number;
  wins: number;
  winRate: number | null;
  netReturnPct: number;
  averageNetTradeReturn: number | null;
};

type MonitoringSnapshot = {
  status: "live" | "delayed" | "offline";
  generatedAt: string;
  collection: {
    startedAt: string | null;
    latestAt: string | null;
    totalRecords: number;
    last24Hours: number;
    synchronizedPrices?: {
      records: number;
      last24Hours: number;
      latestAt: string | null;
      maximumSkewMs: number | null;
      targetCadenceMinutes: number;
      quality?: {
        status: "collecting" | "healthy" | "attention";
        records: number;
        completeRecords: number;
        totalRecords: number;
        coverage: number;
        durationHours: number;
        medianSkewMs: number | null;
        p95SkewMs: number | null;
        medianSpread: number | null;
        p95Spread: number | null;
        medianAbsoluteBasisPct: number | null;
        p95AbsoluteBasisPct: number | null;
        passedGates: number;
        totalGates: number;
        assets: Array<{ asset: string; records: number }>;
        gates: Array<{
          id: "records" | "duration" | "coverage" | "timing" | "assets" | "basis";
          label: string;
          passed: boolean;
        }>;
      };
    };
  };
  tradeReadiness: {
    objective: string;
    currentStage: "backtest" | "shadow";
    realTradingEnabled: boolean;
    combinedPaperRunning: boolean;
    hyperliquidOrderConnection: "not_installed" | "connector_ready" | "testnet_ready" | "testnet_armed";
    gates: Array<{
      id: "data" | "edge" | "shadow" | "testnet" | "live";
      label: string;
      status: "ready" | "running" | "attention" | "blocked" | "not_started" | "locked";
    }>;
  };
  combinedShadow: {
    status: string;
    startedAt: string | null;
    updatedAt: string | null;
    initialEquity: number | null;
    equity: number | null;
    returnPct: number | null;
    cash: number | null;
    realizedPnl: number | null;
    openPositions: Array<{
      asset: string;
      side: "LONG" | "SHORT";
      quantity: number;
      entryPrice: number;
      markPrice: number;
      signalZ: number;
      polymarketSide: string | null;
      entryTrendZ6h: number | null;
      entryFunding24h: number | null;
      horizonHours: number | null;
      priceBasisPct: number | null;
      openedAt: string;
      exitAt: string;
    }>;
    trades: number;
    wins: number;
    winRate: number | null;
    maxDrawdownPct: number | null;
    riskStatus: string;
    emergencyStopped: boolean;
    experimentKey: string | null;
    experimentLabel: string | null;
    forwardOnly: boolean;
    minimumSignalZ: number | null;
    minimumFunding24h: number | null;
    signalRule: CombinedSignalRule;
    modelVersion: string | null;
    forwardEvaluation: {
      status: "collecting" | "promising" | "underperforming";
      trades: number;
      wins: number;
      winRate: number | null;
      controlTrades: number;
      comparableEvents: number;
      minimumTrades: number;
      minimumComparableEvents: number;
      progressPct: number;
      activeHorizonHours?: number;
      totalTrades?: number;
      totalMinimumTrades?: number;
      comparisonStartedAt: string | null;
      netReturnPct: number | null;
      benchmarkReturnPct: number | null;
      benchmarkLabel: "Polymarket方向のみ" | "常時ロング" | "常時ショート" | null;
      excessReturnPct: number | null;
      excessConfidenceInterval95: [number, number] | null;
      deflatedSharpeProbability: number | null;
      maxDrawdownPct: number;
      passedGates: number;
      totalGates: number;
      gates: Array<{
        id: "trades" | "control" | "net-positive" | "benchmark" | "significance" | "selection-bias" | "drawdown" | "settlement";
        label: string;
        passed: boolean;
      }>;
      benchmarks: {
        polymarketOnlyReturnPct: number | null;
        alwaysLongReturnPct: number | null;
        alwaysShortReturnPct: number | null;
      };
      attribution: {
        byAsset: Array<{
          asset: string;
          trades: number;
          wins: number;
          returnContributionPct: number;
          averageTradeReturnPct: number | null;
        }>;
      };
      horizons?: Array<{
        horizonHours: number;
        status: "collecting" | "promising" | "underperforming";
        trades: number;
        minimumTrades: number;
        progressPct: number;
        netReturnPct: number | null;
        excessReturnPct: number | null;
        maxDrawdownPct: number;
        passedGates: number;
        totalGates: number;
        horizonEligibleMarkets: number;
        priceReadyEvents: number;
        latestAction: string | null;
        latestReason: string;
        nextWindowAt: string | null;
      }>;
    } | null;
    settlementBasis: {
      status: "collecting" | "healthy" | "attention";
      samples: number;
      medianAbsolutePct: number | null;
      maximumAbsolutePct: number | null;
      medianReferenceCaptureLagSeconds: number | null;
    };
    funnel: {
      scans: number;
      scannedMarkets: number;
      structuredMarkets: number;
      horizonEligibleMarkets: number;
      groupedEvents: number;
      priceReadyEvents: number;
      thresholdSignals: number;
      opened: number;
      closed: number;
    };
    latestDecision: {
      action: string;
      reason: string;
      asset: string | null;
      signalZ: number | null;
      spotPrice: number | null;
      targetPrice: number | null;
      polymarketSide: string | null;
      strategySide: string | null;
      trendZ6h: number | null;
      hyperliquidFunding24h: number | null;
      horizonHours: number | null;
      marketBestBid: number | null;
      marketBestAsk: number | null;
      marketSpread: number | null;
      polymarketReferencePrice: number | null;
      referenceSource: string | null;
      priceBasisPct: number | null;
      ladderViolations: number | null;
      nextWindowAt: string | null;
      observedAt: string;
    } | null;
    testnet: {
      installed: boolean;
      accountConfigured: boolean;
      apiWalletConfigured: boolean;
      enabled: boolean;
      autoMirrorEnabled: boolean;
      ready: boolean;
      maximumNotionalUsd: number;
      mainnetSupported: false;
      reconciliation: {
        status: string;
        lastSuccessAt: string | null;
        message: string | null;
      };
    };
  };
  polymarket: { snapshots: number; markets: number; latestAt: string | null; backtestRuns: number; backtestPoints: number };
  model: {
    name: string;
    selectedCandidate: string | null;
    selectedCandidateKind: "market" | "logit-pool" | "ridge-logit-pool" | null;
    combinedStrategy: string | null;
    combinedMinimumSignalZ: number | null;
    selectedFromValidation: boolean;
    totalEligibleSignals: number;
    validationEligibleSignals: number;
    executionStartedAt: string | null;
    executionEndedAt: string | null;
    validationStartedAt: string | null;
    validationEndedAt: string | null;
    testStartedAt: string | null;
    testEndedAt: string | null;
    closestValidationCandidate: {
      id: string;
      minimumSignalZ: number;
      signalRule: CombinedSignalRule;
      minimumTrendZ: number;
      minimumFunding24h: number;
      positionPct: number;
    } | null;
    closestHoldoutAudit: {
      strategy: {
        id: string;
        minimumSignalZ: number;
        signalRule: CombinedSignalRule;
        minimumTrendZ: number;
        minimumFunding24h: number;
        positionPct: number;
      };
      trades: number;
      wins: number;
      winRate: number | null;
      netReturnPct: number;
      benchmarkReturnPct: number;
      excessReturnPct: number;
      returnConfidenceInterval95: [number, number] | null;
      statisticallyPositive: boolean;
      deflatedSharpeProbability: number | null;
      maxDrawdownPct: number;
      attribution: {
        byAsset: HoldoutSlice[];
        bySide: HoldoutSlice[];
        byFundingStrength: HoldoutSlice[];
        byConsensus: HoldoutSlice[];
      };
    } | null;
    candidateDiagnostics: Array<{
      strategy: {
        id: string;
        minimumSignalZ: number;
        signalRule: CombinedSignalRule;
        minimumTrendZ: number;
        minimumFunding24h: number;
        positionPct: number;
      };
      validationSignals: number;
      trades: number;
      netReturnPct: number;
      benchmarkReturnPct: number;
      excessReturnPct: number;
      profitableFolds: number;
      deflatedSharpeProbability: number | null;
      confidenceInterval95: [number, number] | null;
      passed: boolean;
      gates: Array<{ id: string; label: string; passed: boolean }>;
    }>;
    structuralFeatureCoverage: number | null;
    fundingFeatureCoverage: number | null;
    synchronizedExecutionCoverage: number;
    testSynchronizedExecutionCoverage: number;
    evaluationStatus: "promising" | "inconclusive" | "underperforming" | "building";
    latestAsset: string | null;
    latestBrierScore: number | null;
    latestAccuracy: number | null;
    latestReturnPct: number | null;
    benchmarkReturnPct: number | null;
    benchmarkReturns: {
      alwaysLongReturnPct: number;
      alwaysShortReturnPct: number;
      polymarketDirectionReturnPct: number;
      randomMedianReturnPct: number;
      randomTrials: number;
      bestReturnPct: number;
      bestLabel: string;
    } | null;
    horizonStudies: Array<{
      horizonHours: number;
      status: "promising" | "inconclusive" | "underperforming" | "unavailable";
      totalEvents: number;
      testEvents: number;
      eligibleSignals: number;
      trades: number;
      netReturnPct: number | null;
      bestBenchmarkReturnPct: number | null;
      excessReturnPct: number | null;
      deflatedSharpeProbability: number | null;
      testExecutionFeatureCoverage: number | null;
      testSynchronizedExecutionCoverage: number | null;
      maximumExecutionTimingErrorMinutes: number | null;
      error?: string;
    }>;
    excessReturnPct: number | null;
    eligibleSignals: number;
    testedMarkets: number;
    testedEvents: number;
    observations: number;
    brierImprovement: number | null;
    previousBrierScore: number | null;
    confidenceInterval95: [number, number] | null;
    statisticallyPositive: boolean;
    deflatedSharpeProbability: number | null;
    strategyTrials: number;
    walkForwardFolds: number;
    profitableValidationFolds: number;
    completedAt: string | null;
    datasetStartedAt: string | null;
    datasetEndedAt: string | null;
    trades: number;
    longTrades: number;
    shortTrades: number;
    winRate: number | null;
    averageTradeReturn: number | null;
    maxDrawdownPct: number | null;
    medianObservationLagMinutes: number | null;
    medianEntryLagMinutes: number | null;
    medianExitLeadMinutes: number | null;
    maximumExecutionTimingErrorMinutes: number | null;
    probabilityLadderEvents: number;
    probabilityLadderViolationEvents: number;
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
  paperExperiment: {
    label: string;
    strategy: string | null;
    status: string;
    realMoney: false;
    initialCash: number | null;
    equity: number | null;
    returnPct: number | null;
    unrealizedPnl: number | null;
    openPositions: number;
    fills: number;
    updatedAt: string | null;
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
  operations?: {
    alerts: { status: "healthy" | "waiting" | "error"; message: string; lastSuccessAt: string | null; webhookConfigured: boolean };
    tunnel: { mode: string; status: "healthy" | "waiting" | "starting"; publicUrl: string | null; fixedUrl: boolean; fallback: boolean; publishedAt: string | null; updatedAt: string | null };
    backup: { status: "healthy" | "waiting"; encrypted: boolean; copies: number; latestAt: string | null };
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

  async function controlCombinedShadow(action: "tick" | "emergency-stop" | "resume") {
    setLoading(true);
    setMessage(action === "tick" ? "組み合わせ仮想売買を更新しています…" : action === "resume" ? "仮想売買を再開しています…" : "仮想売買を緊急停止しています…");
    try {
      await fetchLocalApi("/api/combined-trading", { method: "POST", body: JSON.stringify({ action }) });
      await refresh();
      setMessage(action === "tick" ? "組み合わせ仮想売買を更新しました" : action === "resume" ? "仮想売買を再開しました" : "仮想売買を緊急停止しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "組み合わせ仮想売買の操作に失敗しました");
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
          <div className="flex items-center gap-2 text-xs font-bold text-primary"><Activity className="h-4 w-4" />POLYMARKET × HYPERLIQUID</div>
          <h1 className="mt-1 max-w-3xl text-2xl font-bold leading-tight text-slate-950 md:text-3xl">予測で売買するモデルを検証中</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Polymarketの予測とHyperliquidの値動きを組み合わせ、ロング・ショート・見送りを判断する仕組みを開発しています。</p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold ${!snapshot && monitoring?.status === "live" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
            <span className={`h-2.5 w-2.5 rounded-full ${!snapshot && monitoring?.status === "live" ? "animate-pulse bg-emerald-500" : "bg-amber-500"}`} />
            {snapshot ? "公開スナップショット" : monitoring?.status === "live" ? "稼働中" : monitoring?.status === "delayed" ? "更新遅延" : "接続確認中"}
          </div>
          <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} aria-label="最新情報に更新" title="最新情報に更新">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </section>

      <ModelSummaryPanel monitoring={monitoring} />

      <CombinedShadowPanel snapshot={monitoring} />

      <TradingPurposePanel snapshot={monitoring} />

      <DevelopmentMonitor snapshot={monitoring} readOnly={snapshot} />

      <MonitoringDetails snapshot={monitoring} />

      {!readOnly ? <PaperExperimentPanel snapshot={monitoring} /> : null}

      {!readOnly ? <details className="rounded-lg border border-border bg-white shadow-sm">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <span className="flex items-center gap-2 text-sm font-bold text-slate-950"><Gauge className="h-4 w-4 text-primary" />管理者用の操作</span>
          <span className="max-w-[60%] truncate text-xs text-muted-foreground">{readOnly ? message : "管理者用"}</span>
        </summary>
        <div className="grid gap-4 border-t p-4 sm:p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            <Button onClick={() => void runModelEvaluation()} disabled={loading || readOnly}><Target className="h-4 w-4" />モデルを再検証</Button>
            <Button variant="secondary" onClick={() => void collectSnapshot()} disabled={loading || readOnly}><Database className="h-4 w-4" />市場データを保存</Button>
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="h-4 w-4" />画面を更新</Button>
          </div>
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="secondary" size="sm" onClick={() => void controlCombinedShadow("tick")} disabled={loading || readOnly}><RefreshCw className="h-4 w-4" />組み合わせを今すぐ更新</Button>
            {monitoring?.combinedShadow.emergencyStopped ? (
              <Button variant="outline" size="sm" onClick={() => void controlCombinedShadow("resume")} disabled={loading || readOnly}><Play className="h-4 w-4" />仮想売買を再開</Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void controlCombinedShadow("emergency-stop")} disabled={loading || readOnly}><Square className="h-4 w-4" />組み合わせを緊急停止</Button>
            )}
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
                <Button variant="outline" onClick={() => void startRun("historical")} disabled={loading || readOnly || Boolean(activeRun)}><Play className="h-4 w-4" />Poly単体を検証</Button>
                <Button variant="outline" onClick={() => void startRun("live")} disabled={loading || readOnly || Boolean(activeRun)}><Activity className="h-4 w-4" />Poly単体を観察</Button>
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
      </details> : null}

      {!readOnly ? <section className="grid gap-4 xl:grid-cols-2">
        <ScoreboardCard asset={asset} backtests={backtests} onSelect={readOnly ? undefined : (id) => void loadBacktest(id)} />
        <PaperRunsCard asset={asset} runs={runs} updatedAt={updatedAt} onSelect={readOnly ? undefined : (id) => void loadPaperRun(id)} />
      </section> : null}

      {!readOnly ? <DetailPanel paperRun={selectedPaperRun} backtest={selectedBacktest} loading={detailLoading} /> : null}
    </div>
  );
}

function TradingPurposePanel({ snapshot }: { snapshot: MonitoringSnapshot | null }) {
  const gates = snapshot?.tradeReadiness?.gates ?? fallbackReadinessGates;
  const shadowRunning = snapshot?.tradeReadiness.currentStage === "shadow";
  const edgeReady = gates.find((gate) => gate.id === "edge")?.status === "ready";
  const improving = shadowRunning && !edgeReady;
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-white shadow-sm" aria-label="取引モデルの仕組みと現在地">
      <div className={`grid gap-3 border-b px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5 ${shadowRunning ? "border-sky-200 bg-sky-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex min-w-0 items-start gap-3">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${shadowRunning ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-800"}`}>{shadowRunning ? <Activity className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}</span>
          <div>
            <p className={`text-xs font-bold ${shadowRunning ? "text-sky-700" : "text-amber-800"}`}>現在地: {improving ? "2. 次期モデル検証" : shadowRunning ? "3. シャドー検証" : "2. バックテスト"}</p>
            <p className="mt-1 text-base font-bold text-slate-950">{improving ? "現行モデルは不採用。次期候補を実資金なしで検証中" : shadowRunning ? "実資金なしで市場確認と判断を継続記録中" : "優位性が確認できるまで、実取引は行いません"}</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">{improving ? "開始後に発生した取引だけを採点し、過去データへの合わせ込みを防いでいます。" : shadowRunning ? "2市場の情報を組み合わせた売買を仮想実行。採用条件を満たすまでは実注文を止めます。" : "未使用期間のテストで採用条件に届かず、Hyperliquidへの注文は停止しています。"}</p>
          </div>
        </div>
        <span className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-slate-950 px-3 text-xs font-bold text-white"><LockKeyhole className="h-4 w-4" />実取引 OFF</span>
      </div>
      <div className="p-4 sm:p-5">
        <p className="text-xs font-bold text-muted-foreground">やっていること</p>
        <div className="mt-4 grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)] md:gap-3">
          <FlowStep icon={Database} number="1" title="予測を読む" source="Polymarket" detail="将来価格の確率" state="収集中" tone="good" />
          <ArrowRight className="h-5 w-5 rotate-90 self-center justify-self-center text-slate-300 md:rotate-0" />
          <FlowStep icon={BrainCircuit} number="2" title="方向を決める" source="予測モデル" detail="買い・売り・見送り" state="検証中" tone="watch" />
          <ArrowRight className="h-5 w-5 rotate-90 self-center justify-self-center text-slate-300 md:rotate-0" />
          <FlowStep icon={TrendingUp} number="3" title="注文する" source="Hyperliquid" detail="ロング・ショート" state={shadowRunning ? "仮想稼働" : "未開始"} tone={shadowRunning ? "watch" : "neutral"} />
        </div>
      </div>
      <div className="grid grid-cols-2 border-t sm:grid-cols-5">
        {gates.map((gate, index) => (
          <div key={gate.id} className="flex min-w-0 items-center gap-2 border-b border-r p-3 last:border-r-0 sm:border-b-0 sm:p-4">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${readinessStepClass(gate.status)}`}>{gate.status === "ready" ? <CheckCircle2 className="h-4 w-4" /> : index + 1}</span>
            <div className="min-w-0">
              <p className="break-words text-xs font-bold leading-4 text-slate-800">{gate.label}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-muted-foreground">{readinessStatusLabel(gate.status)}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FlowStep({ icon: Icon, number, title, source, detail, state, tone }: { icon: LucideIcon; number: string; title: string; source: string; detail: string; state: string; tone: Tone }) {
  return (
    <div className="flex min-h-24 items-center gap-3 rounded-md border border-border p-3 sm:p-4">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${toneIconClass(tone)}`}><Icon className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-bold text-muted-foreground">STEP {number}</p>
          <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${tonePillClass(tone)}`}>{state}</span>
        </div>
        <p className="mt-1 text-sm font-bold text-slate-950">{title}</p>
        <p className="mt-0.5 truncate text-xs font-semibold text-slate-600">{source} / {detail}</p>
      </div>
    </div>
  );
}

function CombinedShadowPanel({ snapshot }: { snapshot: MonitoringSnapshot | null }) {
  const shadow = snapshot?.combinedShadow;
  const forward = shadow?.forwardEvaluation;
  const running = shadow?.status === "running" && !shadow.emergencyStopped;
  const displayedReturn = forward ? forward.netReturnPct : shadow?.returnPct;
  const pnlSignal = getProfitSignal(displayedReturn);
  const DecisionIcon = running ? Activity : AlertCircle;
  const position = shadow?.openPositions[0];
  const latest = shadow?.latestDecision;
  const decisionLabel = formatShadowAction(latest?.action);
  const hasClosedTrades = (forward?.trades ?? shadow?.trades ?? 0) > 0;
  const forwardOnly = shadow?.forwardOnly === true;
  const progressTrades = forward?.trades ?? shadow?.trades ?? 0;
  const requiredTrades = forward?.minimumTrades ?? 50;
  const allHorizonTrades = forward?.totalTrades ?? progressTrades;
  const remainingTrades = Math.max(0, requiredTrades - progressTrades);
  const totalProgress = requiredTrades > 0 ? progressTrades / requiredTrades : 0;
  const evaluationMeta = forward?.status === "promising"
    ? { label: "基準達成", tone: "good" as const }
    : forward?.status === "underperforming"
      ? { label: "改善が必要", tone: "bad" as const }
      : { label: "収集中", tone: "neutral" as const };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-white shadow-sm" aria-label="組み合わせ仮想売買の現在成績">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <DecisionIcon className={`h-4 w-4 ${running ? "text-emerald-600" : "text-amber-600"}`} />
          <h2 className="text-sm font-bold text-slate-950">{forward?.horizons?.length ? "4時間軸の固定フォワード検証" : forwardOnly ? "次期モデルのフォワード検証" : "リアルタイム検証"}</h2>
          <span className={`rounded-sm px-2 py-0.5 text-[10px] font-bold ${tonePillClass(evaluationMeta.tone)}`}>{forwardOnly ? evaluationMeta.label : "候補収集"}</span>
        </div>
        <span className={`rounded-sm px-2 py-1 text-[11px] font-bold ${running ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{running ? "5分ごとに市場を確認" : shadow?.emergencyStopped ? "緊急停止中" : "開始待ち"}</span>
      </div>
      <div className="grid lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]">
        <div className={`border-b p-5 lg:border-b-0 lg:border-r sm:p-6 ${toneSoftClass(pnlSignal.tone)}`}>
          <p className="text-xs font-bold text-muted-foreground">{forward?.activeHorizonHours ? `先行中の${forward.activeHorizonHours}時間モデル` : "コスト控除後の累計損益"}</p>
          <p className={`mt-3 text-4xl font-bold leading-none sm:text-5xl ${pnlSignal.tone === "good" ? "text-emerald-700" : pnlSignal.tone === "bad" ? "text-rose-700" : "text-slate-950"}`}>{hasClosedTrades ? formatSignedPct(displayedReturn) : "未判定"}</p>
          <div className="mt-5 flex items-center justify-between gap-3 text-xs font-bold text-slate-700">
            <span>{progressTrades} / {requiredTrades}取引</span>
            <span>{forward?.status === "collecting" || !forward ? `あと${remainingTrades}件` : `${forward.passedGates} / ${forward.totalGates}条件`}</span>
          </div>
          <VisualMeter tone={evaluationMeta.tone} value={Math.min(100, totalProgress * 100)} className="mt-2" />
          <p className="mt-3 text-xs font-semibold leading-5 text-slate-600">{forward?.status === "promising" ? "優位性の基準をすべて満たしました。次はテストネット検証です。" : forward?.status === "underperforming" ? "十分な件数で基準を満たさず、実取引には進みません。" : forward?.horizons?.length ? "4つを混ぜず、各時間軸50件まで固定条件で収集します。" : "50件までは結果を確定せず、固定条件のまま収集します。"}</p>
        </div>
        <div className="grid min-w-0">
          <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
            <CompactMetric label="全時間軸の決済" value={`${allHorizonTrades}件`} />
            <CompactMetric label="単純戦略との差" value={hasClosedTrades ? formatSignedPct(forward?.excessReturnPct) : "未判定"} />
            <CompactMetric label="95%下限" value={forward?.status !== "collecting" ? formatSignedPct(forward?.excessConfidenceInterval95?.[0]) : "50件後"} />
            <CompactMetric label="最大下落" value={hasClosedTrades ? formatPct(forward?.maxDrawdownPct ?? shadow?.maxDrawdownPct) : "未判定"} />
          </div>
          <div className="grid gap-3 border-t bg-slate-50 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-sm bg-white px-2 py-1 text-[10px] font-bold text-slate-700 ring-1 ring-border">直近の判断</span>
                <span className="text-sm font-bold text-slate-950">{decisionLabel}</span>
              </div>
              <p className="mt-2 break-words text-xs leading-5 text-slate-600">{latest?.reason ?? "最初の市場確認を待っています"}</p>
              {latest?.nextWindowAt ? <p className="mt-1 text-[11px] font-semibold text-sky-700">次の観測帯 {formatJapanDateTime(latest.nextWindowAt)}</p> : null}
            </div>
            <div className="text-left sm:text-right">
              <p className="text-[10px] font-bold text-muted-foreground">現在の保有</p>
              <p className="mt-1 text-sm font-bold text-slate-950">{position ? `${position.asset} ${position.side === "LONG" ? "ロング" : "ショート"}` : "なし"}</p>
              <p className="mt-0.5 text-[10px] font-semibold text-muted-foreground">{latest?.observedAt ? relativeTime(latest.observedAt) : "更新待ち"}</p>
            </div>
          </div>
        </div>
      </div>
      {forward?.horizons?.length ? <ForwardHorizonProgress horizons={forward.horizons} /> : null}
      <ScanFunnel funnel={shadow?.funnel} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-[11px] font-bold text-slate-600 sm:px-5">
        <span>比較対象: {forward?.benchmarkLabel ?? "Polymarket方向のみを同時収集中"}</span>
        <span className="text-rose-700">実取引 OFF</span>
      </div>
      <details className="group border-t">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-bold text-slate-800 sm:px-5">
          <span>評価条件と資産別成績</span>
          <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t bg-slate-50 px-4 py-4 sm:px-5">
          <p className="text-xs leading-5 text-slate-600">開始後のデータだけを使い、同時稼働するPolymarket単体戦略と同期間で比較します。</p>
          <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
            {(forward?.gates ?? []).map((gate) => (
              <div key={gate.id} className="flex items-center gap-2 border-b py-2.5 text-xs font-semibold text-slate-700">
                {gate.passed ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : <MinusCircle className="h-4 w-4 shrink-0 text-slate-400" />}
                <span>{gate.label}</span>
              </div>
            ))}
          </div>
          {(forward?.attribution.byAsset.length ?? 0) > 0 ? (
            <div className="mt-5">
              <p className="text-xs font-bold text-slate-800">資産別</p>
              <div className="mt-2 divide-y border-y">
                {forward?.attribution.byAsset.map((asset) => (
                  <div key={asset.asset} className="grid grid-cols-[48px_1fr_auto] items-center gap-3 py-2.5 text-xs">
                    <span className="font-bold text-slate-950">{asset.asset}</span>
                    <span className="font-semibold text-slate-600">{asset.trades}取引 / 勝率 {formatPct(asset.trades ? asset.wins / asset.trades : null)}</span>
                    <span className={`font-bold ${asset.returnContributionPct >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatSignedPct(asset.returnContributionPct)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[11px] font-semibold text-slate-500">
            <span>同期間比較 {forward?.comparableEvents ?? 0}件</span>
            <span>参照価格差 {shadow?.settlementBasis.samples ?? 0}件 / 中央 {formatBasisBps(shadow?.settlementBasis.medianAbsolutePct)}</span>
            <span>固定ルール {formatShadowRule(shadow?.signalRule)}</span>
            <span>{shadow?.testnet.ready ? "テストネット接続可" : "テストネット設定待ち"}</span>
          </div>
        </div>
      </details>
    </section>
  );
}

function ForwardHorizonProgress({ horizons }: {
  horizons: NonNullable<NonNullable<MonitoringSnapshot["combinedShadow"]["forwardEvaluation"]>["horizons"]>;
}) {
  return (
    <div className="border-t bg-slate-50" aria-label="時間軸別のフォワード検証進捗">
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <p className="text-xs font-bold text-slate-800">時間軸別</p>
        <p className="text-[10px] font-semibold text-muted-foreground">各50取引を独立評価</p>
      </div>
      <div className="grid grid-cols-2 border-t sm:grid-cols-4">
        {horizons.map((horizon, index) => {
          const tone = horizon.status === "promising" ? "good" : horizon.status === "underperforming" ? "bad" : "neutral";
          return (
            <div key={horizon.horizonHours} className={`min-w-0 p-3 sm:p-4 ${index % 2 === 0 ? "border-r" : ""} ${index < 2 ? "border-b sm:border-b-0" : ""} sm:border-r sm:last:border-r-0`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-base font-bold tabular-nums text-slate-950">{horizon.horizonHours}時間</p>
                <span className={`rounded-sm px-1.5 py-0.5 text-[9px] font-bold ${tonePillClass(tone)}`}>{horizon.status === "promising" ? "合格" : horizon.status === "underperforming" ? "不合格" : "収集中"}</span>
              </div>
              <p className="mt-2 text-xl font-bold tabular-nums text-slate-950">{horizon.trades}<span className="ml-1 text-xs font-semibold text-slate-500">/ {horizon.minimumTrades}</span></p>
              <VisualMeter tone={tone} value={horizon.progressPct * 100} className="mt-2" />
              <p className="mt-2 text-[10px] font-semibold leading-4 text-slate-500">対象 {horizon.horizonEligibleMarkets}件 / 計算可能 {horizon.priceReadyEvents}件</p>
              <p className="mt-1 line-clamp-2 min-h-8 text-[10px] font-semibold leading-4 text-slate-600">{horizon.latestReason}</p>
              {horizon.nextWindowAt ? <p className="mt-1 text-[10px] font-bold text-sky-700">次回 {formatJapanDateTime(horizon.nextWindowAt)}</p> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScanFunnel({ funnel }: { funnel: MonitoringSnapshot["combinedShadow"]["funnel"] | undefined }) {
  const steps = [
    { label: "市場を確認", value: funnel?.scannedMarkets ?? 0, note: "直近" },
    { label: "価格型", value: funnel?.structuredMarkets ?? 0, note: "直近" },
    { label: "時間が一致", value: funnel?.horizonEligibleMarkets ?? 0, note: "直近" },
    { label: "計算可能", value: funnel?.priceReadyEvents ?? 0, note: "直近" },
    { label: "基準を通過", value: funnel?.thresholdSignals ?? 0, note: "累計" },
    { label: "仮想発注", value: funnel?.opened ?? 0, note: "累計" },
  ];
  return (
    <div className="border-t bg-white px-4 py-4 sm:px-5" aria-label="市場確認から仮想発注までの件数">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-800">判断の流れ</p>
        <p className="text-[10px] font-semibold text-muted-foreground">確認 {funnel?.scans ?? 0}回</p>
      </div>
      <div className="grid grid-cols-3 overflow-hidden rounded-md border border-border sm:grid-cols-6">
        {steps.map((step, index) => (
          <div key={step.label} className="relative min-w-0 border-b border-r p-2.5 last:border-r-0 sm:border-b-0 sm:p-3">
            <p className="truncate text-[9px] font-bold text-muted-foreground sm:text-[10px]">{step.label}</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-slate-950 sm:text-2xl">{step.value}</p>
            <p className="text-[9px] font-semibold text-slate-400">{step.note}</p>
            {index < steps.length - 1 ? <ArrowRight className="absolute right-0 top-1/2 z-10 hidden h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white text-slate-300 sm:block" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function PaperExperimentPanel({ snapshot }: { snapshot: MonitoringSnapshot | null }) {
  const paper = snapshot?.paperExperiment;
  const signal = getProfitSignal(paper?.returnPct);
  const ProfitIcon = signal.icon;
  return (
    <details className="overflow-hidden rounded-lg border border-border bg-white shadow-sm" aria-label="参考用のPolymarket単体実験">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-bold text-slate-950"><Activity className="h-4 w-4 text-sky-700" />参考実験: Polymarket単体</span>
        <span className="shrink-0 text-xs font-bold text-muted-foreground">{formatSignedPct(paper?.returnPct)}</span>
      </summary>
      <div className="border-t">
      <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-sky-100 text-sky-700"><Activity className="h-5 w-5" /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-bold text-muted-foreground">現在動いている別実験</p>
              <span className="rounded-sm bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">仮想資金</span>
            </div>
            <h2 className="mt-1 text-base font-bold text-slate-950">主モデルとは別の比較データ</h2>
            <p className="mt-1 max-w-xl text-xs leading-5 text-slate-600">実資金もHyperliquid注文も使わないため、主な運用判定には含めません。</p>
          </div>
        </div>
        <div className="grid grid-cols-3 divide-x divide-border border-t pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
          <CompactMetric label="仮想残高" value={formatUsd(paper?.equity)} />
          <CompactMetric label="現在損益" value={formatSignedPct(paper?.returnPct)} />
          <CompactMetric label="保有中" value={`${paper?.openPositions ?? 0}件`} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-slate-50 px-4 py-2.5 text-[11px] font-semibold text-muted-foreground sm:px-5">
        <span className="inline-flex items-center gap-1.5"><ProfitIcon className={`h-3.5 w-3.5 ${signal.tone === "good" ? "text-emerald-600" : signal.tone === "bad" ? "text-rose-600" : "text-slate-500"}`} />含み損益 {formatUsd(paper?.unrealizedPnl)} / 仮想約定 {paper?.fills ?? 0}件</span>
        <span>{paper?.updatedAt ? `${relativeTime(paper.updatedAt)}に更新` : "データ待ち"}</span>
      </div>
      </div>
    </details>
  );
}

function DevelopmentMonitor({ snapshot, readOnly }: { snapshot: MonitoringSnapshot | null; readOnly: boolean }) {
  const healthyPipelines = snapshot?.pipelines.filter((pipeline) => pipeline.status === "healthy").length ?? 0;
  const synchronizedPrices = snapshot?.collection.synchronizedPrices;
  const synchronizedQuality = synchronizedPrices?.quality;
  const operationRows = [
    {
      label: "異常通知",
      value: snapshot?.operations?.alerts.status === "healthy" ? "監視中" : snapshot?.operations?.alerts.status === "error" ? "要確認" : "起動待ち",
      status: snapshot?.operations?.alerts.status ?? "waiting",
    },
    {
      label: "公開接続",
      value: snapshot?.operations?.tunnel.fixedUrl ? "固定URL" : snapshot?.operations?.tunnel.status === "healthy" ? "自動接続" : "確認中",
      status: snapshot?.operations?.tunnel.status === "healthy" ? "healthy" : "waiting",
    },
    {
      label: "暗号化保管",
      value: snapshot?.operations?.backup.status === "healthy" ? `${snapshot.operations.backup.copies}世代` : "確認中",
      status: snapshot?.operations?.backup.status ?? "waiting",
    },
  ] as const;
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
        <MonitorMetric
          label="1分板価格同期"
          value={formatCompact(synchronizedPrices?.records)}
          note={synchronizedQuality
            ? `同期 ${Math.round(synchronizedQuality.coverage * 100)}%・ずれ ${formatMilliseconds(synchronizedQuality.p95SkewMs)}`
            : synchronizedPrices?.records ? `最大ずれ ${formatMilliseconds(synchronizedPrices.maximumSkewMs)}` : "新しい記録を収集中"}
        />
        <MonitorMetric label="最終テスト" value={`${snapshot?.model.testedEvents ?? 0}件`} note="未使用期間で評価" />
        <MonitorMetric
          label={synchronizedQuality ? "同期継続" : "連続蓄積"}
          value={synchronizedQuality ? formatDurationHours(synchronizedQuality.durationHours) : formatElapsed(snapshot?.collection.startedAt)}
          note={synchronizedQuality ? "48時間で品質判定" : relativeTime(snapshot?.collection.latestAt)}
        />
      </div>
      <div className="grid grid-cols-2 border-t sm:grid-cols-4 sm:divide-x sm:divide-border">
        {(snapshot?.pipelines ?? fallbackPipelines).map((pipeline) => (
          <div key={pipeline.id} className="flex items-center justify-between gap-2 border-b px-3 py-2.5 odd:border-r sm:border-b-0 sm:border-r-0 sm:px-4 sm:py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${readOnly ? "bg-slate-300" : pipeline.status === "healthy" ? "bg-emerald-500" : pipeline.status === "error" ? "bg-rose-500" : "bg-amber-400"}`} />
              <span className="break-words text-[11px] font-bold leading-4 text-slate-800">{pipeline.label}</span>
            </div>
            <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">{pipeline.cadence}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 divide-x divide-border border-t bg-slate-50/70">
        {operationRows.map((row) => (
          <div key={row.label} className="flex min-w-0 items-center justify-center gap-2 px-2 py-2.5 sm:px-4">
            <span className={`h-2 w-2 shrink-0 rounded-full ${row.status === "healthy" ? "bg-emerald-500" : row.status === "error" ? "bg-rose-500" : "bg-amber-400"}`} />
            <span className="min-w-0 truncate text-[10px] font-bold text-slate-700 sm:text-xs">{row.label} {row.value}</span>
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
  const synchronizedQuality = snapshot?.collection.synchronizedPrices?.quality;
  const holdoutAudit = model?.closestHoldoutAudit;
  const auditedReturn = holdoutAudit?.netReturnPct ?? model?.latestReturnPct;
  const auditedBenchmark = holdoutAudit?.benchmarkReturnPct ?? model?.benchmarkReturnPct;
  const auditedDrawdown = holdoutAudit?.maxDrawdownPct ?? model?.maxDrawdownPct;
  const passedChecks = snapshot?.backtestQuality.checks.filter((check) => check.passed).length ?? 0;
  const qualitySignal = getEvaluationSignal(snapshot?.backtestQuality.status);
  const synchronizedTone: Tone = synchronizedQuality?.status === "healthy"
    ? "good"
    : synchronizedQuality?.status === "attention" ? "bad" : "watch";
  return (
    <details className="rounded-lg border border-border bg-white shadow-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <span className="flex items-center gap-2 text-sm font-bold text-slate-950"><Layers3 className="h-4 w-4 text-primary" />詳しい収集・検証データ</span>
        <span className="text-xs font-semibold text-muted-foreground">必要なときだけ表示</span>
      </summary>
      <div className="grid gap-4 border-t bg-slate-50/60 p-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] sm:p-4">
      <div className="rounded-md border border-border bg-white p-4 sm:p-5">
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
          <CompactMetric label={holdoutAudit ? "候補の最終損益" : "戦略損益"} value={formatSignedPct(auditedReturn)} />
          <CompactMetric label="最良の単純戦略" value={formatSignedPct(auditedBenchmark)} />
          <CompactMetric label="最大下落" value={formatPct(auditedDrawdown)} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
          {(snapshot?.backtestQuality.checks ?? []).map((check) => (
            <span key={check.label} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold ${check.passed ? "bg-emerald-50 text-emerald-700" : snapshot?.backtestQuality.status === "underperforming" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`}>
              {check.passed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
              {check.label}
            </span>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border bg-white p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers3 className="h-5 w-5 text-primary" />
            <h2 className="text-base font-bold text-slate-950">同期価格の品質</h2>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${tonePillClass(synchronizedTone)}`}>
            {synchronizedQuality?.status === "healthy" ? "基準合格" : synchronizedQuality?.status === "attention" ? "要改善" : "48時間を確認中"}
          </span>
        </div>
        <div className="mt-5 grid grid-cols-3 divide-x divide-border">
          <CompactMetric label="同期率" value={formatPct(synchronizedQuality?.coverage)} />
          <CompactMetric label="時刻ずれ 95%" value={formatMilliseconds(synchronizedQuality?.p95SkewMs)} />
          <CompactMetric label="価格差 95%" value={formatBasisBps(synchronizedQuality?.p95AbsoluteBasisPct)} />
        </div>
        <div className="mt-4 rounded-md border border-border bg-slate-50 px-3 py-3">
          <div className="flex items-center justify-between gap-3 text-xs font-bold">
            <span className="text-slate-700">最終テストを1分板価格で再現</span>
            <span className="tabular-nums text-slate-950">{formatPct(model?.testSynchronizedExecutionCoverage)}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <span
              className={`block h-full rounded-full ${(model?.testSynchronizedExecutionCoverage ?? 0) >= 0.9 ? "bg-emerald-500" : "bg-amber-400"}`}
              style={{ width: `${Math.max(0, Math.min(100, (model?.testSynchronizedExecutionCoverage ?? 0) * 100))}%` }}
            />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
          {(synchronizedQuality?.gates ?? []).map((gate) => (
            <span key={gate.id} className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold ${gate.passed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
              {gate.passed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
              {gate.label}
            </span>
          ))}
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
        <p className="border-t pt-3 text-[11px] leading-5 text-muted-foreground">
          CLOB板・判定参照価格・Hyperliquid板を1分ごとに同時保存し、{formatCompact(snapshot?.collection.synchronizedPrices?.records)}件を検査中です。収集済み期間は実際の買値・売値で再現し、未収集期間の1時間足は参考値としてのみ残します。
        </p>
      </div>
      </div>
    </details>
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
  { id: "polymarket", label: "価格同期収集", cadence: "1分ごと", status: "waiting" as const },
  { id: "hyperliquid", label: "相場データ収集", cadence: "1分ごと", status: "waiting" as const },
  { id: "backtest", label: "モデル再検証", cadence: "6時間ごと", status: "waiting" as const },
  { id: "forward-experiment", label: "固定フォワード検証", cadence: "5分ごと", status: "waiting" as const },
];

const fallbackReadinessGates: MonitoringSnapshot["tradeReadiness"]["gates"] = [
  { id: "data", label: "データ収集", status: "attention" },
  { id: "edge", label: "優位性確認", status: "blocked" },
  { id: "shadow", label: "シャドー検証", status: "not_started" },
  { id: "testnet", label: "テストネット", status: "not_started" },
  { id: "live", label: "実取引", status: "locked" },
];

function ModelSummaryPanel({ monitoring }: { monitoring: MonitoringSnapshot | null }) {
  const model = monitoring?.model;
  const decision = getEvaluationSignal(model?.evaluationStatus, model?.combinedStrategy);
  const DecisionIcon = decision.icon;
  const hasTrades = (model?.trades ?? 0) > 0;
  const leadingCandidate = selectLeadingCandidate(model?.candidateDiagnostics);
  const holdoutAudit = model?.closestHoldoutAudit;
  const isAuditingRejectedCandidate = model?.combinedStrategy === "no-trade guard" && Boolean(holdoutAudit);
  const displayedTrades = isAuditingRejectedCandidate ? holdoutAudit?.trades ?? 0 : model?.trades ?? 0;
  const displayedReturn = isAuditingRejectedCandidate ? holdoutAudit?.netReturnPct : model?.latestReturnPct;
  const displayedDrawdown = isAuditingRejectedCandidate ? holdoutAudit?.maxDrawdownPct : model?.maxDrawdownPct;
  const sampleReady = displayedTrades >= 50;
  const leadingPassedGates = leadingCandidate?.gates.filter((gate) => gate.passed).length ?? 0;
  const edgeConfidence = model?.deflatedSharpeProbability
    ?? holdoutAudit?.deflatedSharpeProbability
    ?? leadingCandidate?.deflatedSharpeProbability;
  const edgeReady = holdoutAudit
    ? (holdoutAudit.deflatedSharpeProbability ?? 0) >= 0.95 && holdoutAudit.statisticallyPositive
    : (edgeConfidence ?? 0) >= 0.95
      && (model?.statisticallyPositive === true
        || leadingCandidate?.gates.some((gate) => gate.id === "significance" && gate.passed) === true);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-white shadow-sm" aria-label="組み合わせ戦略の検証結果">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5">
        <h2 className="text-sm font-bold text-slate-950">Polymarket → Hyperliquid の検証結果</h2>
        <span className="inline-flex items-center gap-1.5 rounded-sm bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700"><LockKeyhole className="h-3.5 w-3.5" />実取引 OFF</span>
      </div>
      <div className={`grid gap-4 border-b p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:p-6 ${toneSoftClass(decision.tone)}`}>
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${toneIconClass(decision.tone)}`}>
          <DecisionIcon className="h-6 w-6" />
        </span>
        <div>
          <p className="text-xs font-bold text-muted-foreground">現在の運用判定</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className="text-3xl font-bold leading-tight text-slate-950 sm:text-4xl">{decision.label}</p>
            <p className="text-sm font-semibold text-slate-700">{decision.description}</p>
          </div>
        </div>
      </div>
      {leadingCandidate && model?.combinedStrategy === "no-trade guard" ? (
        <div className={`flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${(holdoutAudit?.netReturnPct ?? 0) > 0 ? "bg-slate-50" : "bg-rose-50"}`}>
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-slate-500">最有力候補 / 選定に使わない最終期間で監査</p>
            <p className="mt-1 text-sm font-bold text-slate-950">{formatCombinedStrategy(leadingCandidate.strategy.id)}</p>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-bold">
            <span className="rounded-sm bg-white px-2 py-1 text-slate-700">選定時 {leadingPassedGates}/{leadingCandidate.gates.length} 条件</span>
            <span className="rounded-sm bg-white px-2 py-1 text-slate-700">最終 {holdoutAudit?.trades ?? 0}取引</span>
            <span className={`rounded-sm bg-white px-2 py-1 ${(holdoutAudit?.netReturnPct ?? 0) > 0 ? "text-emerald-700" : "text-rose-700"}`}>最終損益 {formatSignedPct(holdoutAudit?.netReturnPct)}</span>
            <span className="rounded-sm bg-white px-2 py-1 text-amber-800">確信度 {formatPct(edgeConfidence)}</span>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 divide-x divide-y divide-border lg:grid-cols-5 lg:divide-y-0">
        <ResultMetric
          icon={Database}
          label="最終テスト"
          value={`${model?.testedEvents ?? 0}件`}
          note="学習に未使用"
          tone={(model?.testedEvents ?? 0) >= 30 ? "good" : "watch"}
        />
        <ResultMetric
          icon={Target}
          label={isAuditingRejectedCandidate ? "候補の最終取引" : "決済取引"}
          value={`${displayedTrades} / 50`}
          note={sampleReady ? "必要数に到達" : `あと${Math.max(0, 50 - displayedTrades)}件`}
          tone={sampleReady ? "good" : "watch"}
          meter={clamp((displayedTrades / 50) * 100, 0, 100)}
        />
        <ResultMetric
          icon={TrendingUp}
          label={isAuditingRejectedCandidate ? "候補の最終損益" : "純損益"}
          value={displayedTrades > 0 ? formatSignedPct(displayedReturn) : "未判定"}
          note={displayedTrades > 0 ? "全コスト控除後" : "取引0件"}
          tone={displayedTrades > 0 ? getProfitSignal(displayedReturn).tone : "neutral"}
        />
        <ResultMetric
          icon={ShieldCheck}
          label="優位性の確信度"
          value={edgeConfidence === null || edgeConfidence === undefined ? "未判定" : formatPct(edgeConfidence)}
          note={edgeReady ? "補正後95%以上" : "95%以上が必要"}
          tone={edgeReady ? "good" : "watch"}
          meter={edgeConfidence === null || edgeConfidence === undefined ? 0 : edgeConfidence * 100}
        />
        <ResultMetric
          icon={TrendingDown}
          label={isAuditingRejectedCandidate ? "候補の最大下落" : "最大下落"}
          value={displayedTrades > 0 ? formatPct(displayedDrawdown) : "未判定"}
          note="上限5.00%"
          tone={displayedTrades > 0 && (displayedDrawdown ?? 0) <= 0.05 ? "good" : "neutral"}
        />
      </div>
      <details className="border-t">
        <summary className="cursor-pointer px-4 py-3 text-xs font-bold text-slate-700 sm:px-5">詳しい検証数値を見る</summary>
        <div className="border-t">
          {!hasTrades ? <p className="px-5 py-4 text-sm leading-6 text-slate-600">採用基準を通ったルールがないため、最終テストでは資金を動かしていません。単純戦略の成績は、見送り結果とは別に比較しています。</p> : null}
          <ModelSampleFlow model={model} />
          <HoldoutAttribution audit={holdoutAudit} />
          <CandidateDiagnosis diagnostics={model?.candidateDiagnostics} />
          <HorizonComparison studies={model?.horizonStudies} />
          <ReturnComparison strategyReturn={hasTrades ? model?.latestReturnPct : null} benchmarks={model?.benchmarkReturns} />
          <div className="flex flex-wrap gap-2 border-t px-5 py-3 text-[11px] font-bold text-slate-600">
            <span className="rounded-sm bg-slate-100 px-2 py-1">順次検証 {model?.profitableValidationFolds ?? 0}/{model?.walkForwardFolds ?? 0}期間でプラス</span>
            <span className="rounded-sm bg-slate-100 px-2 py-1">累計候補 {model?.strategyTrials ?? 0}通りを補正</span>
            <span className="rounded-sm bg-slate-100 px-2 py-1">時刻誤差 最大 {formatMinutes(model?.maximumExecutionTimingErrorMinutes)}</span>
            <span className="rounded-sm bg-slate-100 px-2 py-1">確率帯の矛盾 {model?.probabilityLadderViolationEvents ?? 0}/{model?.probabilityLadderEvents ?? 0}テーマ</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
            <span>{model?.name ?? "モデル検証準備中"} / 採用: {formatCombinedStrategy(model?.combinedStrategy)}</span>
            <span>{formatEvaluationPeriod(model?.datasetStartedAt, model?.datasetEndedAt)}</span>
          </div>
        </div>
      </details>
    </section>
  );
}

function ModelSampleFlow({ model }: { model: MonitoringSnapshot["model"] | undefined }) {
  if (!model?.totalEligibleSignals) return null;
  const steps = [
    { label: "売買可能", value: model.totalEligibleSignals },
    { label: "ルール選定", value: model.validationEligibleSignals },
    { label: "最終テスト", value: model.testedEvents },
  ];
  return (
    <div className="border-t px-5 py-4" aria-label="モデル検証データの分割">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        {steps.map((step, index) => (
          <div className="contents" key={step.label}>
            <div className="min-w-0 text-center">
              <p className="text-xl font-bold tabular-nums text-slate-950">{step.value}</p>
              <p className="mt-1 text-[10px] font-bold text-muted-foreground">{step.label}</p>
            </div>
            {index < steps.length - 1 ? <ArrowRight className="h-4 w-4 shrink-0 text-slate-300" /> : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[11px] font-semibold text-slate-500">実売買価格の期間 {formatCompactPeriod(model.executionStartedAt, model.executionEndedAt)}</p>
    </div>
  );
}

function HoldoutAttribution({ audit }: { audit: MonitoringSnapshot["model"]["closestHoldoutAudit"] | undefined }) {
  if (!audit?.attribution) return null;
  const groups = [
    { label: "資産別", items: audit.attribution.byAsset },
    { label: "売買方向別", items: audit.attribution.bySide },
    { label: "資金調達率別", items: audit.attribution.byFundingStrength },
    { label: "Poly方向との関係", items: audit.attribution.byConsensus },
  ];
  return (
    <div className="border-t px-5 py-4" aria-label="最終テストの損益内訳">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-bold text-muted-foreground">不採用候補が負けた場所</p>
        <span className="rounded-sm bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600">原因分析専用</span>
      </div>
      <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {groups.map((group) => (
          <div key={group.label} className="min-w-0">
            <p className="border-b pb-1.5 text-[10px] font-bold text-slate-500">{group.label}</p>
            {group.items.map((item) => (
              <div key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-slate-100 py-2 text-xs">
                <span className="truncate font-semibold text-slate-700">{item.label}</span>
                <span className="tabular-nums text-slate-500">{item.trades}件</span>
                <span className={`min-w-16 text-right font-bold tabular-nums ${(item.averageNetTradeReturn ?? 0) > 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatSignedPct(item.averageNetTradeReturn)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[10px] font-semibold text-slate-500">右端は1取引あたりの平均損益。次期ルールの過去成績としては使用しません。</p>
    </div>
  );
}

function CandidateDiagnosis({ diagnostics }: { diagnostics: MonitoringSnapshot["model"]["candidateDiagnostics"] | undefined }) {
  const best = selectLeadingCandidate(diagnostics);
  if (!best) return null;
  const passed = best.gates.filter((gate) => gate.passed).length;
  const families = [
    { rule: "polymarket-only" as const, label: "Poly方向" },
    { rule: "hyperliquid-momentum" as const, label: "HL順張り" },
    { rule: "hyperliquid-reversion" as const, label: "HL反転" },
    { rule: "hyperliquid-funding-carry" as const, label: "資金受取" },
    { rule: "hyperliquid-funding-momentum" as const, label: "資金方向" },
  ].flatMap(({ rule, label }) => {
    const candidate = [...(diagnostics ?? [])]
      .filter((item) => item.strategy.signalRule === rule)
      .sort((left, right) => right.netReturnPct - left.netReturnPct)[0];
    return candidate ? [{ label, candidate }] : [];
  });

  return (
    <div className="border-t px-5 py-4" aria-label="候補ルールの採用診断">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-bold text-muted-foreground">採用に最も近いルール</p>
          <p className="mt-1 text-base font-bold text-slate-950">{formatCombinedStrategy(best.strategy.id)}</p>
        </div>
        <span className={`rounded-sm px-2 py-1 text-xs font-bold ${best.passed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
          {passed}/{best.gates.length} 条件
        </span>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-1" aria-label={`${passed}/${best.gates.length}条件を達成`}>
        {best.gates.map((gate) => <span key={gate.id} className={`h-2 rounded-sm ${gate.passed ? "bg-emerald-500" : "bg-slate-200"}`} title={gate.label} />)}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {best.gates.map((gate) => (
          <span key={gate.id} className={`inline-flex items-center gap-1 text-[10px] font-bold ${gate.passed ? "text-emerald-700" : "text-slate-500"}`}>
            {gate.passed ? <CheckCircle2 className="h-3 w-3" /> : <MinusCircle className="h-3 w-3" />}{gate.label}
          </span>
        ))}
      </div>
      <p className="mt-3 text-xs font-semibold text-slate-600">
        検証 {best.trades}取引 / 損益 {formatSignedPct(best.netReturnPct)} / 単純戦略との差 {formatSignedPct(best.excessReturnPct)} / 確信度 {formatPct(best.deflatedSharpeProbability)}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-y-2 divide-x rounded-md bg-slate-50 py-2 text-center sm:grid-cols-5">
        {families.map(({ label, candidate }) => (
          <div className="min-w-0 px-2" key={label}>
            <p className="text-[10px] font-bold text-slate-500">{label}</p>
            <p className={`mt-1 text-xs font-bold ${candidate.netReturnPct > 0 ? "text-emerald-700" : "text-rose-700"}`}>{formatSignedPct(candidate.netReturnPct)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function selectLeadingCandidate(diagnostics: MonitoringSnapshot["model"]["candidateDiagnostics"] | undefined) {
  return diagnostics?.length ? [...diagnostics].sort((left, right) =>
    Number(right.passed) - Number(left.passed)
    || right.gates.filter((gate) => gate.passed).length - left.gates.filter((gate) => gate.passed).length
    || right.netReturnPct - left.netReturnPct
    || right.excessReturnPct - left.excessReturnPct,
  )[0] : null;
}

function HorizonComparison({ studies }: { studies: MonitoringSnapshot["model"]["horizonStudies"] | undefined }) {
  const rows = studies?.length ? [...studies].sort((a, b) => a.horizonHours - b.horizonHours) : [6, 12, 24, 48].map((horizonHours) => ({
    horizonHours,
    status: "unavailable" as const,
    totalEvents: 0,
    testEvents: 0,
    eligibleSignals: 0,
    trades: 0,
    netReturnPct: null,
    bestBenchmarkReturnPct: null,
    excessReturnPct: null,
    deflatedSharpeProbability: null,
    testExecutionFeatureCoverage: null,
    testSynchronizedExecutionCoverage: null,
    maximumExecutionTimingErrorMinutes: null,
  }));

  return (
    <div className="border-t px-5 py-4" aria-label="時間軸別の検証結果">
      <p className="mb-3 text-[11px] font-bold text-muted-foreground">判定までの時間別</p>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
        {rows.map((row) => {
          const noTrade = row.trades === 0;
          const positive = (row.netReturnPct ?? 0) > 0;
          return (
            <div key={row.horizonHours} className="min-w-0 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-base font-bold tabular-nums text-slate-950">{row.horizonHours}時間前</span>
                <span className={`h-2 w-2 shrink-0 rounded-full ${row.status === "promising" ? "bg-emerald-500" : row.status === "underperforming" ? "bg-rose-500" : "bg-amber-400"}`} />
              </div>
              <p className="mt-2 text-xl font-bold leading-none text-slate-950">{noTrade ? "見送り" : formatSignedPct(row.netReturnPct)}</p>
              <p className="mt-2 text-[10px] font-semibold leading-4 text-muted-foreground">テスト {row.testEvents}件 / 取引 {row.trades}件</p>
              <div className={`mt-2 h-1 rounded-full ${noTrade ? "bg-amber-300" : positive ? "bg-emerald-500" : "bg-rose-500"}`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReturnComparison({ strategyReturn, benchmarks }: { strategyReturn: number | null | undefined; benchmarks: MonitoringSnapshot["model"]["benchmarkReturns"] | undefined }) {
  const rows = [
    { label: "組み合わせ", value: strategyReturn, className: (strategyReturn ?? 0) >= 0 ? "bg-emerald-500" : "bg-rose-500" },
    { label: "常時ロング", value: benchmarks?.alwaysLongReturnPct, className: "bg-slate-500" },
    { label: "常時ショート", value: benchmarks?.alwaysShortReturnPct, className: "bg-slate-400" },
    { label: "Poly方向", value: benchmarks?.polymarketDirectionReturnPct, className: "bg-sky-500" },
    { label: `ランダム${benchmarks?.randomTrials ? ` ${benchmarks.randomTrials}回` : ""}`, value: benchmarks?.randomMedianReturnPct, className: "bg-slate-300" },
  ];
  const maximum = Math.max(...rows.map((row) => Math.abs(row.value ?? 0)), 0.01) * 1.12;
  return (
    <div className="grid gap-2 border-t px-5 py-4" aria-label="未使用期間の損益比較">
      <div className="flex items-center justify-between text-[11px] font-bold text-muted-foreground"><span>未使用期間の損益</span><span>中央より右が利益</span></div>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[88px_minmax(0,1fr)_64px] items-center gap-2 text-xs">
          <span className="font-bold text-slate-700">{row.label}</span>
          <div className="relative h-3 overflow-hidden rounded-full bg-slate-100">
            <span className="absolute inset-y-0 left-1/2 w-px bg-slate-300" />
            <span
              className={`absolute inset-y-0 ${row.className}`}
              style={row.value === null || row.value === undefined
                ? { width: 0 }
                : row.value >= 0
                  ? { left: "50%", width: `${Math.max(2, Math.abs(row.value) / maximum * 50)}%` }
                  : { right: "50%", width: `${Math.max(2, Math.abs(row.value) / maximum * 50)}%` }}
            />
          </div>
          <span className="text-right font-bold tabular-nums text-slate-950">{formatSignedPct(row.value)}</span>
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
        <span className="text-base font-bold text-slate-950">Polymarket単体の仮想履歴</span>
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
            <h2 className="text-xl font-bold text-slate-950">Polymarket単体の仮想売買</h2>
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
  combinedStrategy?: string | null,
): Signal {
  if (status === "promising") {
    return { label: "優位性を確認", description: "Polymarketの予測を使ったHyperliquid取引が、未使用期間でもコスト控除後に基準を上回りました。", tone: "good", icon: CheckCircle2 };
  }
  if (status === "underperforming") {
    return { label: "改善が必要", description: "十分な履歴で単純戦略を下回りました。本番利用せず、モデルを見直します。", tone: "bad", icon: TrendingDown };
  }
  if (status === "inconclusive") {
    if (combinedStrategy === "no-trade guard") {
      return { label: "実取引はまだ不可", description: "検証条件を満たす売買ルールがまだ見つかっていません。0%は利益ではなく、見送りルールが働いて0回だった結果です。", tone: "watch", icon: AlertCircle };
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

function readinessStatusLabel(status: MonitoringSnapshot["tradeReadiness"]["gates"][number]["status"]) {
  const labels = {
    ready: "完了",
    running: "稼働中",
    attention: "確認中",
    blocked: "未合格",
    not_started: "未開始",
    locked: "停止中",
  } as const;
  return labels[status];
}

function readinessStepClass(status: MonitoringSnapshot["tradeReadiness"]["gates"][number]["status"]) {
  if (status === "ready") return "bg-emerald-100 text-emerald-700";
  if (status === "running") return "bg-sky-100 text-sky-700";
  if (status === "attention") return "bg-sky-100 text-sky-700";
  if (status === "blocked") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-500";
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
  return labels[status.toLowerCase()] ?? status;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number | null | undefined, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value) ? "-" : value.toFixed(digits);
}

function formatCombinedStrategy(strategy: string | null | undefined) {
  if (!strategy) return "選定中";
  if (strategy === "no-trade guard") return "取引見送り";
  if (strategy.startsWith("hl funding carry")) return `資金調達を受け取る方向 / 24時間 ${strategy.split(" ").at(-1)}以上`;
  if (strategy.startsWith("hl funding momentum")) return `資金調達と同じ方向 / 24時間 ${strategy.split(" ").at(-1)}以上`;
  const threshold = strategy.match(/[0-9.]+$/)?.[0];
  if (!threshold) return strategy;
  if (strategy.startsWith("contrarian")) return `予測乖離へ逆張り / 強度 ${threshold}以上`;
  if (strategy.startsWith("hl momentum")) return `6時間値動きへ順張り / Poly強度 ${threshold}以上`;
  if (strategy.startsWith("hl reversion")) return `6時間値動きへ反転 / Poly強度 ${threshold}以上`;
  return strategy.startsWith("trend")
    ? `予測方向 + 6時間トレンド / 強度 ${threshold}以上`
    : `予測方向 / 強度 ${threshold}以上`;
}

function formatShadowAction(action: string | null | undefined) {
  const labels: Record<string, string> = {
    OPEN_LONG: "ロングを仮想発注",
    OPEN_SHORT: "ショートを仮想発注",
    HOLD: "保有を継続",
    WAIT: "条件待ち",
    NO_SIGNAL: "対象市場待ち",
    SKIP: "重複のため見送り",
    BLOCKED: "リスク制限で停止",
  };
  return action ? labels[action] ?? action : "確認待ち";
}

function formatShadowRule(rule: MonitoringSnapshot["combinedShadow"]["signalRule"] | null | undefined) {
  if (rule === "contrarian") return "予測乖離へ逆張り";
  if (rule === "hyperliquid-momentum") return "6時間値動きへ順張り";
  if (rule === "hyperliquid-reversion") return "6時間値動きへ反転";
  if (rule === "hyperliquid-funding-carry") return "資金調達を受け取る方向";
  if (rule === "hyperliquid-funding-momentum") return "資金調達と同じ方向";
  if (rule === "polymarket-funding-consensus") return "Poly方向と資金受取方向が一致";
  return "予測方向に追随";
}

function formatEvaluationPeriod(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return "検証期間を準備中";
  const formatter = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit" });
  return `検証期間 ${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

function formatCompactPeriod(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return "準備中";
  const formatter = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
}

function formatJapanDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMinutes(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value < 60 ? `${Math.round(value)}分` : `${(value / 60).toFixed(1)}時間`;
}

function formatMilliseconds(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}秒`;
}

function formatDurationHours(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value < 1) return `${Math.max(1, Math.round(value * 60))}分`;
  if (value < 24) return `${value.toFixed(1)}時間`;
  return `${Math.floor(value / 24)}日 ${Math.floor(value % 24)}時間`;
}

function formatBasisBps(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const basisPoints = value * 10_000;
  return `${basisPoints.toFixed(Math.abs(basisPoints) < 10 ? 1 : 0)}bp`;
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
  return value === null || value === undefined || !Number.isFinite(value)
    ? "-"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
