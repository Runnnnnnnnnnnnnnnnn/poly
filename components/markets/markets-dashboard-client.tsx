"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Globe2, Landmark, Layers3, RefreshCcw } from "lucide-react";

import { MarketAiEvaluationPanel } from "@/components/markets/market-ai-evaluation-panel";
import { MarketGroupExplorer } from "@/components/markets/market-group-explorer";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { groupMarkets } from "@/lib/market-groups";
import type { MarketsResponse } from "@/lib/types";
import { cn, formatDateTime, formatUsd } from "@/lib/utils";
import { fetchLocalApi } from "@/src/lib/localApiClient";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

export function MarketsDashboardClient({ initialData }: { initialData: MarketsResponse }) {
  const [data, setData] = useState(initialData);
  const [bridgeError, setBridgeError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const refreshMarkets = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setRefreshing(true);
    try {
      const payload = await fetchLocalApi<MarketsResponse>("/api/markets");
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
    void refreshMarkets({ silent: true });
    const timer = window.setInterval(() => void refreshMarkets({ silent: true }), 30_000);
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
      <div className="grid gap-5 rounded-lg border border-border bg-white p-5 shadow-sm md:p-7">
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
            手動更新
          </Button>
        </div>
        <div className="grid gap-4 md:flex md:items-end md:justify-between">
          <div className="grid gap-2">
            <p className="text-sm font-bold text-primary">Polymarket Watch</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950 md:text-4xl">予測市場一覧</h1>
            <p className="text-sm leading-6 text-muted-foreground">テーマ、確率、倍率、出来高を確認できます。</p>
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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard title="世界テーマ" value={`${globalMarkets.length}件`} icon={<Globe2 className="h-4 w-4" />} />
        <MetricCard title="日本テーマ" value={`${japanMarkets.length}件`} icon={<Landmark className="h-4 w-4" />} />
        <MetricCard title="整理済みテーマ" value={`${themeGroups.length}件`} icon={<Layers3 className="h-4 w-4" />} />
        <MetricCard title="合計出来高" value={formatUsd(totals.volume)} />
        <MetricCard title="合計流動性" value={formatUsd(totals.liquidity)} />
      </div>

      <MarketAiEvaluationPanel />

      <MarketGroupExplorer
        markets={data.markets}
        title="予測市場一覧"
      />
    </section>
  );
}

function MetricCard({ title, value, icon }: { title: string; value: string; icon?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="grid gap-2 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          {icon}
          {title}
        </div>
        <p className="text-2xl font-bold text-slate-950">{value}</p>
      </CardContent>
    </Card>
  );
}
