"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MarketSummary, NewsItem } from "@/lib/types";
import { formatDateTime, formatPercent, formatUsd } from "@/lib/utils";

const filters = ["すべて", "報道", "公式情報", "日銀", "金融", "規制", "政治", "為替", "政策"] as const;

export function NewsList({ items, markets }: { items: NewsItem[]; markets: MarketSummary[] }) {
  const [filter, setFilter] = useState<(typeof filters)[number]>("すべて");
  const filtered = useMemo(() => {
    if (filter === "すべて") return items;
    if (filter === "公式情報") return items.filter((item) => item.kind === "公式情報");
    if (filter === "報道") return items.filter((item) => item.kind === "報道");
    return items.filter((item) => item.category === filter);
  }, [filter, items]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {filters.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setFilter(item)}
            className={[
              "rounded-md border px-3 py-2 text-sm font-semibold transition-colors",
              filter === item
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-white text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="grid gap-3">
        {filtered.map((item) => (
          <article key={item.id} className="rounded-lg border border-border bg-white p-5 shadow-sm">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.source}</Badge>
                  <Badge variant={item.kind === "公式情報" ? "live" : "secondary"}>{item.kind}</Badge>
                  <Badge variant="secondary">{item.category}</Badge>
                  <StatusBadge status={item.status} />
                </div>
                <h2 className="text-lg font-semibold leading-snug">
                  <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-primary">
                    {item.title}
                  </a>
                </h2>
                <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{item.summary}</p>
                <p className="text-xs text-muted-foreground">
                  関連市場: {item.relatedMarket ?? "未分類"} / 公開: {formatDateTime(item.publishedAt)}
                </p>
                <div>
                  <Button asChild size="sm" variant="outline">
                    <a href={item.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      ニュースを開く
                    </a>
                  </Button>
                </div>
              </div>
              <RelatedThemes item={item} markets={markets} />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function RelatedThemes({ item, markets }: { item: NewsItem; markets: MarketSummary[] }) {
  const related = useMemo(() => findRelatedMarkets(item, markets), [item, markets]);

  return (
    <aside className="grid gap-2 rounded-md bg-slate-50 p-3">
      <p className="text-xs font-bold text-muted-foreground">関連テーマ</p>
      {related.length > 0 ? (
        related.map((market) => (
          <Link key={market.id} href={`/markets/${market.id}`} className="grid gap-1 rounded-md border border-border bg-white p-3 hover:border-primary/40 hover:bg-accent">
            <span className="line-clamp-2 text-sm font-semibold leading-snug text-slate-950">{market.title}</span>
            <span className="text-xs text-muted-foreground">
              YES {formatPercent(market.probability)} / 出来高 {formatUsd(market.volume)} / {market.themeLabel}
            </span>
          </Link>
        ))
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">関連テーマは取得中です。手動更新で最新の市場データを確認できます。</p>
      )}
    </aside>
  );
}

function findRelatedMarkets(item: NewsItem, markets: MarketSummary[]) {
  const newsText = normalize([item.title, item.summary, item.relatedMarket ?? "", item.category].join(" "));
  return markets
    .map((market) => {
      const marketText = normalize([market.title, market.originalTitle, market.summaryJa, market.category, market.themeLabel].join(" "));
      const relatedMarketText = normalize(item.relatedMarket ?? "");
      let score = 0;
      if (item.category === market.category) score += 5;
      if (relatedMarketText && marketText.includes(relatedMarketText.slice(0, 18))) score += 5;
      for (const token of importantTokens(newsText)) {
        if (marketText.includes(token)) score += token.length > 4 ? 2 : 1;
      }
      if (item.source.includes("日本") && market.scope === "japan") score += 1;
      return { market, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.market.volume + b.market.liquidity - (a.market.volume + a.market.liquidity))
    .slice(0, 3)
    .map((entry) => entry.market);
}

function importantTokens(text: string) {
  return Array.from(new Set(text.split(/[^a-z0-9ぁ-んァ-ヶ一-龠ー]+/u).filter((token) => token.length >= 2))).slice(0, 24);
}

function normalize(value: string) {
  return value.toLowerCase();
}
