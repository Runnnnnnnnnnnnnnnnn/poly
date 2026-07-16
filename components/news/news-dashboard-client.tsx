"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";

import { NewsList } from "@/components/news/news-list";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { MarketSummary, MarketsResponse, NewsResponse } from "@/lib/types";
import { cn, formatDateTime } from "@/lib/utils";
import { fetchLocalApi, isSnapshotMode } from "@/src/lib/localApiClient";

export function NewsDashboardClient({ initialData, initialMarkets }: { initialData: NewsResponse; initialMarkets: MarketSummary[] }) {
  const [data, setData] = useState(initialData);
  const [markets, setMarkets] = useState(initialMarkets);
  const [bridgeError, setBridgeError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [snapshot, setSnapshot] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (silent = true) => {
    if (!silent) setRefreshing(true);
    try {
      const [payload, marketPayload] = await Promise.all([fetchLocalApi<NewsResponse>("/api/news"), fetchLocalApi<MarketsResponse>("/api/markets")]);
      if (mountedRef.current) {
        setData(payload);
        setMarkets(marketPayload.markets);
        setBridgeError(false);
      }
    } catch {
      if (mountedRef.current) setBridgeError(true);
    } finally {
      if (!silent && mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // 公開版の保存データでは自動更新しない。
    if (isSnapshotMode()) {
      setSnapshot(true);
      return () => {
        mountedRef.current = false;
      };
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  return (
    <section className="grid gap-6">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={snapshot ? data.status : bridgeError ? "error" : data.status} />
            <span className="text-sm text-muted-foreground">
              {snapshot ? `公開版の保存データ（${formatDateTime(data.updatedAt)} 時点）` : `最終更新 ${formatDateTime(data.updatedAt)}`}
            </span>
            {!snapshot && bridgeError ? <span className="text-sm text-muted-foreground">更新を確認できません</span> : null}
          </div>
          {snapshot ? null : (
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh(false)} disabled={refreshing}>
              <RefreshCcw className={cn("h-4 w-4", refreshing ? "animate-spin" : "")} />
              手動更新
            </Button>
          )}
        </div>
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">ニュース・公式情報</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          話題になっているニュースと、その背景確認に使える関連テーマを並べて表示します。
        </p>
      </div>
      <NewsList items={data.items} markets={markets} />
    </section>
  );
}
