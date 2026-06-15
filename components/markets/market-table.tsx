"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownUp, ExternalLink } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { WatchButton } from "@/components/markets/watch-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MARKET_FILTERS } from "@/lib/constants";
import type { MarketSummary } from "@/lib/types";
import { formatDate, formatDateTime, formatPercent, formatUsd } from "@/lib/utils";

type Filter = (typeof MARKET_FILTERS)[number];

export function MarketTable({ markets }: { markets: MarketSummary[] }) {
  const [filter, setFilter] = useState<Filter>("すべて");

  const filtered = useMemo(() => {
    const rows = [...markets];
    if (filter === "高注目") return rows.sort((a, b) => b.volume + b.liquidity - (a.volume + a.liquidity)).slice(0, 8);
    if (filter === "締切が近い順") {
      return rows.sort((a, b) => new Date(a.endDate ?? "2999-01-01").getTime() - new Date(b.endDate ?? "2999-01-01").getTime());
    }
    if (filter === "更新が新しい順") {
      return rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    if (filter === "すべて") return rows;
    return rows.filter((market) => market.category === filter);
  }, [filter, markets]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {MARKET_FILTERS.map((item) => (
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

      <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] border-collapse text-sm">
            <thead className="bg-slate-50 text-left text-xs font-bold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3">市場名</th>
                <th className="px-4 py-3">確率</th>
                <th className="px-4 py-3">YES</th>
                <th className="px-4 py-3">NO</th>
                <th className="px-4 py-3">Bid</th>
                <th className="px-4 py-3">Ask</th>
                <th className="px-4 py-3">スプレッド</th>
                <th className="px-4 py-3">出来高</th>
                <th className="px-4 py-3">流動性</th>
                <th className="px-4 py-3">締切</th>
                <th className="px-4 py-3">関連</th>
                <th className="px-4 py-3">最終更新</th>
                <th className="px-4 py-3">状態</th>
                <th className="px-4 py-3">
                  <span className="inline-flex items-center gap-1">
                    操作 <ArrowDownUp className="h-3.5 w-3.5" />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((market) => (
                <tr key={market.id} className="border-t border-border align-top hover:bg-slate-50/70">
                  <td className="max-w-[320px] px-4 py-4">
                    <div className="grid gap-1">
                      <Link href={`/markets/${market.id}`} className="font-semibold text-slate-950 hover:text-primary">
                        {market.title}
                      </Link>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{market.summaryJa}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">元タイトル: {market.originalTitle}</span>
                      <Badge variant="outline">{market.category}</Badge>
                    </div>
                  </td>
                  <td className="px-4 py-4 text-lg font-bold text-primary">{formatPercent(market.probability)}</td>
                  <td className="px-4 py-4">{market.yesPrice.toFixed(2)}</td>
                  <td className="px-4 py-4">{market.noPrice.toFixed(2)}</td>
                  <td className="px-4 py-4">{market.bestBid === null ? "-" : market.bestBid.toFixed(2)}</td>
                  <td className="px-4 py-4">{market.bestAsk === null ? "-" : market.bestAsk.toFixed(2)}</td>
                  <td className="px-4 py-4">{market.spread === null ? "-" : market.spread.toFixed(3)}</td>
                  <td className="px-4 py-4">{formatUsd(market.volume)}</td>
                  <td className="px-4 py-4">{formatUsd(market.liquidity)}</td>
                  <td className="px-4 py-4">{formatDate(market.endDate)}</td>
                  <td className="px-4 py-4">{market.relatedNewsCount}件</td>
                  <td className="px-4 py-4">{formatDateTime(market.updatedAt)}</td>
                  <td className="px-4 py-4">
                    <StatusBadge status={market.status} />
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/markets/${market.id}`}>詳細を見る</Link>
                      </Button>
                      <Button asChild size="sm" variant="secondary">
                        <Link href={`/calculator?market=${market.id}`}>試算する</Link>
                      </Button>
                      <WatchButton marketId={market.id} />
                      <Button asChild size="sm" variant="ghost">
                        <a href={market.url} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
