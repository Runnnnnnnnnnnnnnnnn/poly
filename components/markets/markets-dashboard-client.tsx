"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Globe2, Landmark, Layers3, RefreshCcw } from "lucide-react";

import { DataUsagePanel } from "@/components/data-usage-panel";
import { MarketAiEvaluationPanel } from "@/components/markets/market-ai-evaluation-panel";
import { MarketGroupExplorer } from "@/components/markets/market-group-explorer";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { groupMarkets } from "@/lib/market-groups";
import type { MarketsResponse } from "@/lib/types";
import { cn, formatDateTime, formatUsd } from "@/lib/utils";
import { fetchLocalApi, isSnapshotMode } from "@/src/lib/localApiClient";
import { loadMarketsClient } from "@/src/lib/staticDataSource";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

export function MarketsDashboardClient({ initialData }: { initialData: MarketsResponse }) {
  const [data, setData] = useState(initialData);
  const [bridgeError, setBridgeError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const refreshMarkets = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      // 公開（静的）版は CORS 許可された Polymarket 公開API をブラウザから直接取得してライブ表示する。
      // ローカル版は同梱の /api 経由で取得する。
      const payload = isSnapshotMode()
        ? await loadMarketsClient()
        : await fetchLocalApi<MarketsResponse>("/api/markets");
      if (!mountedRef.current) return;
      setData(payload);
      setBridgeError(false);
    } catch {
      if (mountedRef.current) setBridgeError(true);
    } finally {
      if (!silent && mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // 公開（静的）版はブラウザ直取得のためリクエスト数が多い。負荷を抑えるため自動更新の間隔を長くする。
    const liveViaBrowser = isSnapshotMode();
    void refreshMarkets({ silent: true });
    const timer = window.setInterval(() => void refreshMarkets({ silent: true }), liveViaBrowser ? 120_000 : 30_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refreshMarkets]);

  const globalMarkets = data.globalMarkets?.length ? data.globalMarkets : data.markets.filter((market) => market.scope === "global");
  const japanMarkets = data.japanMarkets?.length ? data.japanMarkets : data.markets.filter((market) => market.scope === "japan");
  const themeGroups = useMemo(() => groupMarkets(data.markets), [data.markets]);

  const totals = useMemo(
    () => ({
      volume: data.markets.reduce((sum, market) => sum + market.volume, 0),
      liquidity: data.markets.reduce((sum, market) => sum + market.liquidity, 0),
    }),
    [data.markets],
  );

  return (
    <section className="grid gap-8">
      <div className="grid gap-4 rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5 md:gap-5 md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={bridgeError ? "error" : data.status} />
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <RefreshCcw className="h-4 w-4" />
              {bridgeError ? "更新を確認できません" : `最終更新 ${formatDateTime(data.updatedAt)}`}
            </span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void refreshMarkets()} disabled={refreshing}>
            <RefreshCcw className={cn("h-4 w-4", refreshing ? "animate-spin" : "")} />
            最新に更新
          </Button>
        </div>
        <div className="grid gap-4 md:flex md:items-end md:justify-between">
          <div className="grid gap-2">
            <p className="text-sm font-bold text-primary">Polymarket Watch</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950 md:text-4xl">予測市場一覧</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              国内・国外のテーマを分けて、確率、倍率、出来高、関連情報を確認できます。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href="https://polymarket.com/ja" target="_blank" rel="noreferrer">
                公式ページを見る
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <AskConciergeButton
              label="テーマを相談"
              context={{ kind: "markets", title: "予測市場一覧" }}
            />
          </div>
        </div>
      </div>

      <MarketSummaryStrip
        globalCount={globalMarkets.length}
        japanCount={japanMarkets.length}
        groupCount={themeGroups.length}
        volume={totals.volume}
        liquidity={totals.liquidity}
      />

      <DataUsagePanel mode="markets" sourceStatuses={data.sourceStatuses} />

      <MarketAiEvaluationPanel />

      <MarketGroupExplorer
        markets={data.markets}
        title="国内・国外のテーマ"
        description="日本に関係するテーマと、海外・世界のテーマに分けて表示します。下のタブで切り替えてください。"
      />
    </section>
  );
}

function MarketSummaryStrip({
  globalCount,
  japanCount,
  groupCount,
  volume,
  liquidity,
}: {
  globalCount: number;
  japanCount: number;
  groupCount: number;
  volume: number;
  liquidity: number;
}) {
  return (
    <section className="rounded-lg border border-border bg-white p-3 shadow-sm sm:p-4" aria-label="市場サマリー">
      <div className="grid grid-cols-3 gap-2">
        <SummaryMetric title="国外" value={`${globalCount}件`} icon={<Globe2 className="h-4 w-4" />} />
        <SummaryMetric title="国内" value={`${japanCount}件`} icon={<Landmark className="h-4 w-4" />} />
        <SummaryMetric title="整理済み" value={`${groupCount}件`} icon={<Layers3 className="h-4 w-4" />} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-muted-foreground">
        <span className="rounded-md bg-slate-50 px-2.5 py-1.5">出来高 {formatUsd(volume)}</span>
        <span className="rounded-md bg-slate-50 px-2.5 py-1.5">流動性 {formatUsd(liquidity)}</span>
      </div>
    </section>
  );
}

function SummaryMetric({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="grid gap-1 rounded-md bg-slate-50 p-2.5 sm:p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      <p className="text-lg font-bold text-slate-950 sm:text-xl">{value}</p>
    </div>
  );
}
