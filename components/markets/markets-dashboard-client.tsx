"use client";

import { useEffect, useMemo, useState } from "react";

import { MarketTable } from "@/components/markets/market-table";
import { SourceStatusList } from "@/components/source-status-list";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MarketsResponse } from "@/lib/types";
import { formatDateTime, formatPercent, formatUsd } from "@/lib/utils";
import { fetchLocalApi } from "@/src/lib/localApiClient";

export function MarketsDashboardClient({ initialData }: { initialData: MarketsResponse }) {
  const [data, setData] = useState(initialData);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const payload = await fetchLocalApi<MarketsResponse>("/api/markets");
        if (!cancelled) {
          setData(payload);
          setBridgeError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setBridgeError(error instanceof Error ? error.message : "ローカルAPIに接続できませんでした");
        }
      }
    }

    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const topMarket = data.markets[0];
  const totals = useMemo(
    () => ({
      volume: data.markets.reduce((sum, market) => sum + market.volume, 0),
      liquidity: data.markets.reduce((sum, market) => sum + market.liquidity, 0),
    }),
    [data.markets],
  );

  return (
    <section className="grid gap-6">
      <div className="grid gap-4 md:flex md:items-end md:justify-between">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={bridgeError ? "error" : data.status} />
            <span className="text-sm text-muted-foreground">最終更新 {formatDateTime(data.updatedAt)}</span>
            {bridgeError ? <span className="text-sm text-muted-foreground">静的データを表示中</span> : null}
          </div>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">日本関連の予測市場</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Polymarketの公開市場データを読み取り、日本関連キーワードで抽出しています。
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title="検出市場" value={`${data.markets.length}件`} />
        <MetricCard title="合計出来高" value={formatUsd(totals.volume)} />
        <MetricCard title="合計流動性" value={formatUsd(totals.liquidity)} />
      </div>

      {topMarket ? (
        <Card>
          <CardHeader>
            <CardTitle>高注目市場</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="font-semibold">{topMarket.title}</p>
              <p className="text-sm text-muted-foreground">{topMarket.summaryJa}</p>
            </div>
            <div className="text-2xl font-bold text-primary">{formatPercent(topMarket.probability)}</div>
          </CardContent>
        </Card>
      ) : null}

      <SourceStatusList items={data.sourceStatuses} />
      <MarketTable markets={data.markets} />
    </section>
  );
}

function MetricCard({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold text-slate-950">{value}</p>
      </CardContent>
    </Card>
  );
}
