"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, Eye, Globe2, Landmark } from "lucide-react";

import { MarketImage } from "@/components/markets/market-image";
import { StatusBadge } from "@/components/status-badge";
import { WatchButton } from "@/components/markets/watch-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MARKET_FILTERS } from "@/lib/constants";
import type { MarketSummary } from "@/lib/types";
import { formatDate, formatPayoutMultiplier, formatPercent, formatUsd } from "@/lib/utils";

type Filter = (typeof MARKET_FILTERS)[number];

export function MarketTable({
  markets,
  title,
  description,
  showFilters = true,
}: {
  markets: MarketSummary[];
  title?: string;
  description?: string;
  showFilters?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("すべて");

  const filtered = useMemo(() => {
    const rows = [...markets];
    if (filter === "世界") return rows.filter((market) => market.scope === "global");
    if (filter === "日本") return rows.filter((market) => market.scope === "japan");
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
    <section className="grid gap-4">
      {title || description ? (
        <div className="grid gap-1">
          {title ? <h2 className="text-xl font-bold text-slate-950 md:text-2xl">{title}</h2> : null}
          {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}

      {showFilters ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {MARKET_FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              className={[
                "h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors",
                filter === item
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-white text-slate-600 hover:bg-accent hover:text-accent-foreground",
              ].join(" ")}
            >
              {item}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((market) => (
          <MarketCard key={market.id} market={market} />
        ))}
      </div>
    </section>
  );
}

function MarketCard({ market }: { market: MarketSummary }) {
  const RegionIcon = market.scope === "global" ? Globe2 : Landmark;

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <Link href={`/markets/${market.id}`} className="block">
        <div className="relative">
          <MarketImage src={market.imageUrl} sizes="(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw" aspectRatio="16 / 9" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/70 to-transparent p-3">
            <Badge variant="secondary" className="bg-white/92 text-slate-800">
              <RegionIcon className="mr-1 h-3.5 w-3.5" />
              {market.themeLabel}
            </Badge>
          </div>
        </div>
      </Link>

      <div className="grid gap-4 p-4">
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <StatusBadge status={market.status} />
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              {formatDate(market.endDate)}
            </span>
          </div>
          <Link href={`/markets/${market.id}`} className="line-clamp-2 min-h-[3.25rem] text-lg font-bold leading-snug text-slate-950 hover:text-primary">
            {market.title}
          </Link>
          <p className="line-clamp-2 min-h-[2.75rem] text-sm leading-6 text-muted-foreground">{market.summaryJa}</p>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-3">
          <Metric label="市場確率" value={formatPercent(market.probability)} emphasis />
          <Metric label="出来高" value={compactUsd(market.volume)} />
          <Metric label="流動性" value={compactUsd(market.liquidity)} />
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <SmallQuote label="YES倍率" value={formatPayoutMultiplier(market.yesPrice)} />
          <SmallQuote label="NO倍率" value={formatPayoutMultiplier(market.noPrice)} />
          <SmallQuote label="Bid" value={market.bestBid === null ? "-" : market.bestBid.toFixed(2)} />
          <SmallQuote label="Ask" value={market.bestAsk === null ? "-" : market.bestAsk.toFixed(2)} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" className="h-10 flex-1">
            <Link href={`/markets/${market.id}`}>
              <Eye className="h-4 w-4" />
              詳細
            </Link>
          </Button>
          <WatchButton marketId={market.id} />
          <Button asChild size="icon" variant="outline" aria-label="公式ページを見る">
            <a href={market.url} target="_blank" rel="noreferrer">
              <ArrowUpRight className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="grid gap-1">
      <span className="text-[11px] font-semibold text-slate-500">{label}</span>
      <span className={emphasis ? "text-xl font-bold text-primary" : "text-sm font-bold text-slate-900"}>{value}</span>
    </div>
  );
}

function SmallQuote({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function compactUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return formatUsd(value);
}
