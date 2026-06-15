"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Globe2, Landmark, Layers3, RefreshCcw } from "lucide-react";

import { MarketGroupExplorer } from "@/components/markets/market-group-explorer";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { groupMarkets } from "@/lib/market-groups";
import type { MarketsResponse, MarketSummary } from "@/lib/types";
import { cn, formatDateTime, formatPercent, formatUsd } from "@/lib/utils";
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
  const featured = globalMarkets[0] ?? japanMarkets[0] ?? data.markets[0];
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
        <div className="grid gap-5 lg:grid-cols-[1fr_0.85fr] lg:items-end">
          <div className="grid gap-3">
            <p className="text-sm font-bold text-primary">世界と日本の予測テーマ</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950 md:text-5xl">世界と日本の注目テーマを一画面で把握</h1>
            <p className="max-w-3xl text-base leading-8 text-muted-foreground">
              世界で取引が集まっているテーマと、日本に関係するテーマをタブで整理します。似た市場は同じテーマにまとめ、市場価格は参加者の期待確率の目安として読みます。
            </p>
            <div className="flex flex-wrap gap-2">
              <AskConciergeButton
                label="テーマの見方を相談"
                context={{ kind: "markets", title: "テーマ一覧" }}
              />
            </div>
          </div>
          {featured ? <FeaturedTheme market={featured} /> : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard title="世界テーマ" value={`${globalMarkets.length}件`} icon={<Globe2 className="h-4 w-4" />} />
        <MetricCard title="日本テーマ" value={`${japanMarkets.length}件`} icon={<Landmark className="h-4 w-4" />} />
        <MetricCard title="整理済みテーマ" value={`${themeGroups.length}件`} icon={<Layers3 className="h-4 w-4" />} />
        <MetricCard title="合計出来高" value={formatUsd(totals.volume)} />
        <MetricCard title="合計流動性" value={formatUsd(totals.liquidity)} />
      </div>

      <MarketGroupExplorer
        markets={data.markets}
        title="テーマ一覧"
        description="日本国内、国外、スポーツ、金融・為替などのタブで切り替えられます。USD/JPYや日経平均のように条件違いが並びやすい市場は、同じテーマ内に集約します。"
      />
    </section>
  );
}

function FeaturedTheme({ market }: { market: MarketSummary }) {
  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-[16/9] bg-slate-100">
        <Image src={market.imageUrl} alt="" fill priority sizes="(min-width: 1024px) 38vw, 100vw" className="object-cover" />
      </div>
      <CardContent className="grid gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-bold text-primary">{market.themeLabel}</span>
          <span className="text-2xl font-bold text-primary">{formatPercent(market.probability)}</span>
        </div>
        <p className="line-clamp-2 text-base font-bold leading-snug text-slate-950">{market.title}</p>
        <p className="text-sm leading-6 text-muted-foreground">{market.summaryJa}</p>
      </CardContent>
    </Card>
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
