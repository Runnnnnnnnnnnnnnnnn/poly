"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, ChevronRight, ExternalLink, Layers3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  filterMarketGroups,
  groupMarkets,
  labelForMarketTag,
  MARKET_THEME_TABS,
  type MarketThemeGroup,
  type MarketThemeTabId,
} from "@/lib/market-groups";
import type { MarketSummary } from "@/lib/types";
import { cn, formatDate, formatPercent, formatUsd } from "@/lib/utils";

export function MarketGroupExplorer({
  markets,
  title = "テーマ一覧",
  description = "タブで分類し、似た市場は同じテーマにまとめて表示します。",
}: {
  markets: MarketSummary[];
  title?: string;
  description?: string;
}) {
  const [activeTab, setActiveTab] = useState<MarketThemeTabId>("featured");
  const groups = useMemo(() => groupMarkets(markets), [markets]);
  const visibleGroups = useMemo(() => filterMarketGroups(groups, activeTab), [activeTab, groups]);

  const counts = useMemo(() => {
    return MARKET_THEME_TABS.reduce(
      (acc, tab) => {
        acc[tab.id] = filterMarketGroups(groups, tab.id).length;
        return acc;
      },
      {} as Record<MarketThemeTabId, number>,
    );
  }, [groups]);

  const activeDescription = MARKET_THEME_TABS.find((tab) => tab.id === activeTab)?.description ?? description;

  return (
    <section className="grid gap-4" aria-labelledby="theme-list-title">
      <div className="grid gap-2 md:flex md:items-end md:justify-between">
        <div className="grid gap-1">
          <h2 id="theme-list-title" className="text-xl font-bold text-slate-950 md:text-2xl">
            {title}
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{activeDescription}</p>
        </div>
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Layers3 className="h-4 w-4" />
          {groups.length}テーマに整理
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="テーマ分類">
        {MARKET_THEME_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors",
              activeTab === tab.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-white text-slate-600 hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {tab.label}
            <span className={cn("ml-2 text-xs", activeTab === tab.id ? "text-primary-foreground/80" : "text-muted-foreground")}>
              {counts[tab.id]}
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-4">
        {visibleGroups.map((group) => (
          <ThemeGroupCard key={group.id} group={group} />
        ))}
        {visibleGroups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white p-8 text-center text-sm text-muted-foreground">
            この分類に該当するテーマはまだありません。手動更新で最新データを再取得できます。
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ThemeGroupCard({ group }: { group: MarketThemeGroup }) {
  const primary = group.primaryMarket;
  const secondaryMarkets = group.markets.slice(0, 4);

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-white shadow-sm transition hover:shadow-md">
      <div className="grid lg:grid-cols-[260px_1fr]">
        <Link href={`/markets/${primary.id}`} className="relative block min-h-[190px] bg-slate-100">
          <Image
            src={primary.imageUrl}
            alt=""
            fill
            sizes="(min-width: 1024px) 260px, 100vw"
            className="object-cover"
          />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/75 to-transparent p-3">
            <Badge variant="secondary" className="bg-white/95 text-slate-800">
              {primary.themeLabel}
            </Badge>
          </div>
        </Link>

        <div className="grid gap-4 p-4 md:p-5">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={primary.status} />
              {group.tags.slice(0, 5).map((tag) => (
                <Badge key={tag} variant="outline">
                  {labelForMarketTag(tag)}
                </Badge>
              ))}
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" />
                {formatDate(primary.endDate)}
              </span>
            </div>

            <div className="grid gap-2">
              <Link href={`/markets/${primary.id}`} className="text-xl font-bold leading-snug text-slate-950 hover:text-primary md:text-2xl">
                {group.label}
              </Link>
              <p className="max-w-4xl text-sm leading-6 text-muted-foreground">{group.summary}</p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <Metric label="確率レンジ" value={formatProbabilityRange(group)} emphasis />
            <Metric label="個別市場" value={`${group.markets.length}件`} />
            <Metric label="出来高" value={formatUsd(group.totalVolume)} />
            <Metric label="流動性" value={formatUsd(group.totalLiquidity)} />
          </div>

          <div className="grid gap-2 border-t border-border pt-3">
            <p className="text-xs font-bold text-muted-foreground">関連する個別市場</p>
            {secondaryMarkets.map((market) => (
              <div key={market.id} className="grid gap-2 border-b border-border/70 py-2 last:border-b-0 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <Link href={`/markets/${market.id}`} className="line-clamp-2 text-sm font-semibold text-slate-900 hover:text-primary">
                    {market.title}
                  </Link>
                  <p className="mt-1 text-xs text-muted-foreground">
                    YES {formatPercent(market.probability)} / 締切 {formatDate(market.endDate)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/markets/${market.id}`}>
                      詳細
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <a href={market.url} target="_blank" rel="noreferrer">
                      Polymarket
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  </Button>
                </div>
              </div>
            ))}
            {group.markets.length > secondaryMarkets.length ? (
              <p className="text-xs font-semibold text-muted-foreground">ほか {group.markets.length - secondaryMarkets.length} 件の市場をこのテーマに集約しています。</p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/markets/${primary.id}`}>
                詳細を見る
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <a href={primary.url} target="_blank" rel="noreferrer">
                Polymarketで確認
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="grid min-h-[72px] gap-1 rounded-md bg-slate-50 p-3">
      <span className="text-[11px] font-semibold text-slate-500">{label}</span>
      <span className={cn("break-words font-bold", emphasis ? "text-xl text-primary" : "text-sm text-slate-900")}>{value}</span>
    </div>
  );
}

function formatProbabilityRange(group: MarketThemeGroup) {
  if (Math.round(group.probabilityMin * 100) === Math.round(group.probabilityMax * 100)) return formatPercent(group.probabilityMax);
  return `${formatPercent(group.probabilityMin)}〜${formatPercent(group.probabilityMax)}`;
}
