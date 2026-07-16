"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronRight, ExternalLink, Layers3 } from "lucide-react";

import { MarketImage } from "@/components/markets/market-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  groupMarkets,
  type MarketThemeGroup,
  type MarketThemeTabId,
} from "@/lib/market-groups";
import type { MarketSummary } from "@/lib/types";
import { cn, formatDate, formatPayoutMultiplier, formatPercent, formatUsd } from "@/lib/utils";

type SideId = Extract<MarketThemeTabId, "japan" | "global">;

const DISPLAY_THEME_TABS = [
  {
    id: "japan",
    label: "国内",
    caption: "日本関連",
    description: "日銀・為替・選挙・規制など、日本に関係するテーマ",
  },
  {
    id: "global",
    label: "国外",
    caption: "海外・世界",
    description: "海外政治・金融・テック・暗号資産など、世界のテーマ",
  },
] satisfies Array<{ id: SideId; label: string; caption: string; description: string }>;

// 各テーマは「国内 / 国外」のどちらか一方にだけ表示する。
// 構成市場の多数派スコープで判定し、同数なら主要市場のスコープで決める。
function groupSide(group: MarketThemeGroup): SideId {
  let japan = 0;
  let global = 0;
  for (const market of group.markets) {
    if (market.scope === "japan") japan += 1;
    else global += 1;
  }
  if (japan > global) return "japan";
  if (global > japan) return "global";
  return group.primaryMarket.scope === "japan" ? "japan" : "global";
}

export function MarketGroupExplorer({
  markets,
  title = "予測市場一覧",
  description,
}: {
  markets: MarketSummary[];
  title?: string;
  description?: string;
}) {
  const [activeTab, setActiveTab] = useState<SideId>("japan");
  const groups = useMemo(() => groupMarkets(markets), [markets]);
  const visibleGroups = useMemo(() => groups.filter((group) => groupSide(group) === activeTab), [activeTab, groups]);

  const counts = useMemo(() => {
    return DISPLAY_THEME_TABS.reduce(
      (acc, tab) => {
        acc[tab.id] = groups.filter((group) => groupSide(group) === tab.id).length;
        return acc;
      },
      {} as Record<SideId, number>,
    );
  }, [groups]);

  const activeTabMeta = DISPLAY_THEME_TABS.find((tab) => tab.id === activeTab) ?? DISPLAY_THEME_TABS[0];

  return (
    <section className="grid gap-4" aria-labelledby="theme-list-title">
      <div className="grid gap-1">
        <h2 id="theme-list-title" className="text-xl font-bold text-slate-950 md:text-2xl">
          {title}
        </h2>
        {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-slate-50 p-1.5" role="tablist" aria-label="国内・国外の切り替え">
        {DISPLAY_THEME_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 rounded-lg px-3 py-2.5 text-center transition-colors",
              activeTab === tab.id
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-slate-600 hover:bg-white hover:text-primary",
            )}
          >
            <span className="flex items-center gap-1.5 text-base font-bold">
              {tab.label}
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-bold",
                  activeTab === tab.id ? "bg-white/20 text-primary-foreground" : "bg-white text-slate-600",
                )}
              >
                {counts[tab.id]}
              </span>
            </span>
            <span className={cn("text-[11px] font-semibold", activeTab === tab.id ? "text-primary-foreground/80" : "text-muted-foreground")}>
              {tab.caption}
            </span>
          </button>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-accent/60 px-3 py-2.5 text-sm leading-6 text-slate-700">
        <Layers3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          <span className="font-bold text-slate-900">{activeTabMeta.label}</span>
          <span className="ml-1 font-semibold text-muted-foreground">／ {visibleGroups.length}テーマ</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{activeTabMeta.description}</span>
        </p>
      </div>

      <div className="grid gap-4">
        {visibleGroups.map((group) => (
          <ThemeGroupCard key={group.id} group={group} />
        ))}
        {visibleGroups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white p-8 text-center text-sm text-muted-foreground">
            この分類に該当するテーマはまだありません。「最新に更新」で市場データを再取得できます。
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ThemeGroupCard({ group }: { group: MarketThemeGroup }) {
  const primary = group.primaryMarket;
  const secondaryMarkets = group.markets.slice(0, 4);
  const issues = getThemeIssues(group);

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-white shadow-sm transition hover:shadow-md">
      <div className="grid lg:grid-cols-[220px_1fr]">
        <Link href={`/markets/${primary.id}`} className="relative block">
          <MarketImage src={primary.imageUrl} sizes="(min-width: 1024px) 220px, 100vw" aspectRatio="4 / 3" className="h-36 w-full sm:h-48 lg:h-full lg:min-h-[200px]" />
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
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" />
                {formatDate(primary.endDate)}
              </span>
            </div>

            <div className="grid gap-2">
              <Link href={`/markets/${primary.id}`} className="text-xl font-bold leading-snug text-slate-950 hover:text-primary md:text-2xl">
                {group.label}
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Metric label="確率レンジ" value={formatProbabilityRange(group)} emphasis />
            <Metric label="YES倍率" value={formatPayoutMultiplier(primary.yesPrice)} />
            <Metric label="出来高" value={formatUsd(group.totalVolume)} />
          </div>

          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">条件違いの市場と注意点を見る</summary>
            <div className="mt-3 grid gap-3">
              <div className="flex flex-wrap gap-2">
                {issues.map((issue) => (
                  <span key={issue} className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-700">
                    {issue}
                  </span>
                ))}
              </div>
              <div className="grid gap-2">
                {secondaryMarkets.map((market) => (
                  <div key={market.id} className="grid gap-1 rounded-md bg-white p-3">
                    <Link href={`/markets/${market.id}`} className="line-clamp-2 text-sm font-semibold text-slate-900 hover:text-primary">
                      {market.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      確率 {formatPercent(market.probability)} / YES {formatPayoutMultiplier(market.yesPrice)}
                    </p>
                  </div>
                ))}
                {group.markets.length > secondaryMarkets.length ? (
                  <p className="text-xs font-semibold text-muted-foreground">ほか {group.markets.length - secondaryMarkets.length} 件を集約</p>
                ) : null}
              </div>
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/markets/${primary.id}`}>
                テーマ詳細
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <a href={primary.url} target="_blank" rel="noreferrer">
                公式市場
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
    <div className="grid min-h-[64px] gap-1 rounded-md bg-slate-50 p-2.5 sm:min-h-[72px] sm:p-3">
      <span className="text-[11px] font-semibold leading-tight text-slate-500">{label}</span>
      <span className={cn("break-words font-bold", emphasis ? "text-base text-primary sm:text-xl" : "text-sm text-slate-900")}>{value}</span>
    </div>
  );
}

function formatProbabilityRange(group: MarketThemeGroup) {
  if (Math.round(group.probabilityMin * 100) === Math.round(group.probabilityMax * 100)) return formatPercent(group.probabilityMax);
  return `${formatPercent(group.probabilityMin)}〜${formatPercent(group.probabilityMax)}`;
}

function getThemeIssues(group: MarketThemeGroup) {
  const issues = [];
  if (group.markets.length > 1) issues.push("条件違いを集約");
  if (group.totalLiquidity < 10_000) issues.push("流動性に注意");
  if (group.category === "為替" || group.category === "日銀" || group.category === "金融") issues.push("金利・為替を確認");
  if (group.category === "政治" || group.category === "選挙" || group.category === "規制") issues.push("判定条件を確認");
  if (group.category === "イベント") issues.push("締切と対象を確認");
  if (group.category === "暗号資産") issues.push("価格変動が大きい");
  if (group.category === "テック") issues.push("関連ニュースを確認");
  if (issues.length === 0) issues.push("判定条件を確認");
  return issues.slice(0, 3);
}
