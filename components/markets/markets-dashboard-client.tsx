"use client";

import type React from "react";
import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { Globe2, Landmark, RefreshCcw } from "lucide-react";

import { MarketTable } from "@/components/markets/market-table";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import type { MarketsResponse, MarketSummary } from "@/lib/types";
import { formatDateTime, formatPercent, formatUsd } from "@/lib/utils";
import { fetchLocalApi } from "@/src/lib/localApiClient";

export function MarketsDashboardClient({ initialData }: { initialData: MarketsResponse }) {
  const [data, setData] = useState(initialData);
  const [bridgeError, setBridgeError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const payload = await fetchLocalApi<MarketsResponse>("/api/markets");
        if (!cancelled) {
          setData(payload);
          setBridgeError(false);
        }
      } catch {
        if (!cancelled) setBridgeError(true);
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const globalMarkets = data.globalMarkets?.length ? data.globalMarkets : data.markets.filter((market) => market.scope === "global");
  const japanMarkets = data.japanMarkets?.length ? data.japanMarkets : data.markets.filter((market) => market.scope === "japan");
  const featured = globalMarkets[0] ?? japanMarkets[0] ?? data.markets[0];

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
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={bridgeError ? "error" : data.status} />
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <RefreshCcw className="h-4 w-4" />
            {bridgeError ? "更新を確認できません" : `最終更新 ${formatDateTime(data.updatedAt)}`}
          </span>
        </div>
        <div className="grid gap-5 lg:grid-cols-[1fr_0.85fr] lg:items-end">
          <div className="grid gap-3">
            <p className="text-sm font-bold text-primary">世界と日本の予測テーマ</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-950 md:text-5xl">世界と日本の注目テーマを一画面で把握</h1>
            <p className="max-w-3xl text-base leading-8 text-muted-foreground">
              世界で取引が集まっているテーマと、日本に関係するテーマを分けて表示します。市場価格は参加者の期待確率の目安として読み、投資判断ではなく情報整理に使います。
            </p>
          </div>
          {featured ? <FeaturedTheme market={featured} /> : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard title="世界テーマ" value={`${globalMarkets.length}件`} icon={<Globe2 className="h-4 w-4" />} />
        <MetricCard title="日本テーマ" value={`${japanMarkets.length}件`} icon={<Landmark className="h-4 w-4" />} />
        <MetricCard title="合計出来高" value={formatUsd(totals.volume)} />
        <MetricCard title="合計流動性" value={formatUsd(totals.liquidity)} />
      </div>

      <MarketTable
        markets={globalMarkets}
        title="世界で注目されているテーマ"
        description="出来高と流動性の大きいテーマを中心に、国際情勢、金融、暗号資産、スポーツなどを表示します。"
        showFilters={false}
      />

      <MarketTable
        markets={japanMarkets}
        title="日本に関係するテーマ"
        description="日銀、円相場、選挙、規制、暗号資産など、日本語の一次情報と合わせて確認しやすいテーマです。"
        showFilters={false}
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
