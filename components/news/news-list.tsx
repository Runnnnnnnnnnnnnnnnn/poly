"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import type { NewsItem } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

const filters = ["すべて", "公式情報", "日銀", "規制", "政治", "為替", "政策"] as const;

export function NewsList({ items }: { items: NewsItem[] }) {
  const [filter, setFilter] = useState<(typeof filters)[number]>("すべて");
  const filtered = useMemo(() => {
    if (filter === "すべて") return items;
    if (filter === "公式情報") return items.filter((item) => item.kind === "公式情報");
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
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.source}</Badge>
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
              </div>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-semibold hover:bg-accent"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                開く
              </a>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
