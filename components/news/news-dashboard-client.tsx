"use client";

import { useEffect, useState } from "react";

import { NewsList } from "@/components/news/news-list";
import { StatusBadge } from "@/components/status-badge";
import type { NewsResponse } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { fetchLocalApi } from "@/src/lib/localApiClient";

export function NewsDashboardClient({ initialData }: { initialData: NewsResponse }) {
  const [data, setData] = useState(initialData);
  const [bridgeError, setBridgeError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const payload = await fetchLocalApi<NewsResponse>("/api/news");
        if (!cancelled) {
          setData(payload);
          setBridgeError(false);
        }
      } catch {
        if (!cancelled) {
          setBridgeError(true);
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

  return (
    <section className="grid gap-6">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={bridgeError ? "error" : data.status} />
          <span className="text-sm text-muted-foreground">最終更新 {formatDateTime(data.updatedAt)}</span>
          {bridgeError ? <span className="text-sm text-muted-foreground">更新を確認できません</span> : null}
        </div>
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">ニュース・公式情報</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          国会会議録、e-Gov、日本銀行RSSを中心に、市場の背景確認に使う一次情報をまとめます。
        </p>
      </div>
      <NewsList items={data.items} />
    </section>
  );
}
