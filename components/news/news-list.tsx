"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { groupMarkets, type MarketThemeGroup } from "@/lib/market-groups";
import type { MarketSummary, NewsItem } from "@/lib/types";
import { formatDateTime, formatPayoutMultiplier, formatPercent } from "@/lib/utils";

const filters = ["すべて", "報道", "公式情報"] as const;

export function NewsList({ items, markets }: { items: NewsItem[]; markets: MarketSummary[] }) {
  const [filter, setFilter] = useState<(typeof filters)[number]>("すべて");
  const filtered = useMemo(() => {
    if (filter === "すべて") return items;
    return items.filter((item) => item.kind === filter);
  }, [filter, items]);

  return (
    <div className="grid gap-4">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
        {filters.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setFilter(item)}
            className={[
              "h-10 shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-semibold transition-colors",
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
          <article key={item.id} className="rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5">
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{item.source}</Badge>
                <Badge variant={item.kind === "公式情報" ? "live" : "secondary"}>{item.kind}</Badge>
                <Badge variant="secondary">{item.category}</Badge>
                <StatusBadge status={item.status} />
                <span className="text-xs text-muted-foreground">{formatDateTime(item.publishedAt)}</span>
              </div>
              <h2 className="text-lg font-semibold leading-snug">
                <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-primary">
                  {item.title}
                </a>
              </h2>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <a href={item.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    ニュースを開く
                  </a>
                </Button>
              </div>
              <details className="rounded-md border border-border bg-slate-50 p-3">
                <summary className="cursor-pointer text-sm font-bold text-slate-800">ニュースの要点と関係するテーマを見る</summary>
                <div className="mt-3 grid gap-3">
                  <p className="text-sm leading-6 text-muted-foreground">{item.summary}</p>
                  <RelatedThemes item={item} markets={markets} />
                </div>
              </details>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function RelatedThemes({ item, markets }: { item: NewsItem; markets: MarketSummary[] }) {
  const related = useMemo(() => findRelatedThemeGroups(item, markets), [item, markets]);

  return (
    <aside className="grid gap-2">
      <p className="text-xs font-bold text-muted-foreground">関連テーマ</p>
      {related.length > 0 ? (
        related.map((group) => (
          <Link key={group.id} href={`/markets/${group.primaryMarket.id}`} className="grid gap-1 rounded-md border border-border bg-white p-3 hover:border-primary/40 hover:bg-accent">
            <span className="line-clamp-2 text-sm font-semibold leading-snug text-slate-950">{group.label}</span>
            <span className="text-xs text-muted-foreground">
              確率 {formatProbabilityRange(group)} / YES倍率 {formatPayoutMultiplier(group.primaryMarket.yesPrice)} / 個別市場 {group.markets.length}件
            </span>
          </Link>
        ))
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">関連テーマは取得中です。「最新に更新」で市場データを再確認できます。</p>
      )}
    </aside>
  );
}

function findRelatedThemeGroups(item: NewsItem, markets: MarketSummary[]) {
  const newsText = normalize([item.title, item.summary, item.relatedMarket ?? "", item.category].join(" "));
  return groupMarkets(markets)
    .map((group) => {
      const marketText = normalize([
        group.label,
        group.category,
        group.primaryMarket.title,
        group.primaryMarket.originalTitle,
        group.primaryMarket.summaryJa,
        group.markets.slice(0, 6).map((market) => market.title).join(" "),
      ].join(" "));
      const relatedMarketText = normalize(item.relatedMarket ?? "");
      let score = 0;
      const categoryScore = categoryMatchScore(item.category, group);
      score += categoryScore;
      score += aliasMatchScore(newsText, group.id);
      if ((item.category === "為替" || item.category === "日銀") && categoryScore === 0) return { group, score: 0 };
      if (relatedMarketText && relatedMarketText !== "polymarket") {
        const groupLabel = normalize(group.label);
        if (groupLabel.includes(relatedMarketText) || relatedMarketText.includes(groupLabel)) score += 30;
        else if (marketText.includes(relatedMarketText.slice(0, 18))) score += 10;
      }
      for (const token of importantTokens(newsText)) {
        if (marketText.includes(token)) score += token.length > 4 ? 2 : 1;
      }
      if (item.source.includes("日本") && group.scope === "japan") score += 1;
      return { group, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.group.totalVolume + b.group.totalLiquidity - (a.group.totalVolume + a.group.totalLiquidity))
    .slice(0, 3)
    .map((entry) => entry.group);
}

function categoryMatchScore(category: NewsItem["category"], group: MarketThemeGroup) {
  if (category === "為替") return group.id === "theme:usd-jpy" ? 24 : 0;
  if (category === "日銀") return group.id === "theme:boj-policy" ? 24 : 0;
  if (category === group.category) return 8;
  if (category === "金融" && group.tags.includes("finance")) return 4;
  if ((category === "規制" || category === "政治" || category === "政策") && group.tags.includes("politics")) return 4;
  return 0;
}

function aliasMatchScore(newsText: string, groupId: string) {
  const aliases: Record<string, string[]> = {
    "theme:usd-jpy": ["usd/jpy", "ドル円", "円相場", "為替", "yen", "boj", "日銀"],
    "theme:nikkei-225": ["日経平均", "nikkei", "日本株", "半導体株"],
    "theme:boj-policy": ["日銀", "植田", "金融政策", "利上げ", "利下げ", "boj"],
    "theme:japan-election": ["選挙", "首相", "内閣", "衆院", "参院"],
    "theme:japan-crypto-regulation": ["暗号資産", "ステーブルコイン", "金融庁", "税制"],
    "theme:world-cup-2026": ["ワールドカップ", "fifa", "サッカー"],
    "theme:us-politics": ["米大統領", "trump", "biden", "democrat", "republican"],
    "theme:iran-geopolitics": ["イラン", "イスラエル", "停戦", "中東"],
    "theme:ai-tech": ["ai", "半導体", "nvidia", "openai"],
  };
  return (aliases[groupId] ?? []).reduce((score, alias) => score + (newsText.includes(alias) ? 8 : 0), 0);
}

function formatProbabilityRange(group: MarketThemeGroup) {
  if (Math.round(group.probabilityMin * 100) === Math.round(group.probabilityMax * 100)) return formatPercent(group.probabilityMax);
  return `${formatPercent(group.probabilityMin)}〜${formatPercent(group.probabilityMax)}`;
}

function importantTokens(text: string) {
  return Array.from(new Set(text.split(/[^a-z0-9ぁ-んァ-ヶ一-龠ー/]+/u).filter((token) => token.length >= 2)))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !["ニュース", "市場", "日本", "関連", "速報", "今日", "明日", "今年", "について", "する"].includes(token))
    .slice(0, 24);
}

function normalize(value: string) {
  return value.toLowerCase();
}
