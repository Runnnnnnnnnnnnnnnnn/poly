import Link from "next/link";
import { AlertCircle, ArrowLeft, CheckCircle2, ExternalLink, Gauge, type LucideIcon } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { CalculatorClient } from "@/components/calculator-client";
import { ProbabilityChart, VolumeChart } from "@/components/charts/market-charts";
import { MarketImage } from "@/components/markets/market-image";
import { WatchButton } from "@/components/markets/watch-button";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCalculatorDefaults, getMarketDetailDashboard, getMarketsDashboard } from "@/lib/server/dashboard";
import type { NewsItem } from "@/lib/types";
import { formatDate, formatPayoutMultiplier, formatPercent, formatUsd } from "@/lib/utils";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

export const dynamicParams = false;

export async function generateStaticParams() {
  const data = await getMarketsDashboard();
  return data.markets.slice(0, 120).map((market) => ({ id: market.id }));
}

export default async function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [data, rate] = await Promise.all([getMarketDetailDashboard(id), getCalculatorDefaults()]);
  const market = data.market;
  const themeNews = dedupeNews([...market.officialInfo, ...market.relatedNews]);

  return (
    <AppShell>
      <section className="grid gap-6">
        <div>
          <Button asChild variant="ghost" size="sm">
            <Link href="/markets">
              <ArrowLeft className="h-4 w-4" />
              テーマ一覧へ戻る
            </Link>
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
            <MarketImage src={market.imageUrl} priority sizes="(min-width: 1024px) 42vw, 100vw" aspectRatio="16 / 10" className="h-56 w-full sm:h-72 lg:h-full lg:min-h-[340px]" />
            <div className="grid gap-5 p-5 md:p-7">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={market.status} />
                <Badge variant="outline">{market.themeLabel}</Badge>
                <span className="text-sm text-muted-foreground">締切 {formatDate(market.endDate)}</span>
              </div>
              <div className="grid gap-3">
                <h1 className="text-3xl font-bold tracking-tight text-slate-950 md:text-4xl">{market.title}</h1>
                <p className="max-w-4xl text-sm leading-7 text-muted-foreground">{market.summaryJa}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <WatchButton marketId={market.id} />
                <Button asChild variant="outline">
                  <a href={market.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    公式ページを見る
                  </a>
                </Button>
                <AskConciergeButton
                  label="このテーマを相談"
                  context={{ kind: "market-detail", marketId: market.id, title: market.title }}
                />
              </div>
            </div>
          </div>
        </div>

        <MarketReadinessPanel
          probability={market.probability}
          liquidity={market.liquidity}
          spread={market.spread}
          volume={market.volume}
        />

        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 xl:grid-cols-4">
          <Metric title="現在確率" value={formatPercent(market.probability)} emphasis />
          <Metric title="YES倍率 / NO倍率" value={`${formatPayoutMultiplier(market.yesPrice)} / ${formatPayoutMultiplier(market.noPrice)}`} />
          <Metric title="最良買い / 最良売り" value={`${market.bestBid?.toFixed(2) ?? "-"} / ${market.bestAsk?.toFixed(2) ?? "-"}`} />
          <Metric title="スプレッド" value={market.spread === null ? "-" : market.spread.toFixed(3)} />
          <Metric title="出来高" value={formatUsd(market.volume)} />
          <Metric title="流動性" value={formatUsd(market.liquidity)} />
          <Metric title="ニュース・公式情報" value={`${themeNews.length}件`} />
          <Metric title="データ状態" value={market.status === "live" ? "リアルタイム" : "参考データ"} />
        </div>

        <details className="rounded-lg border border-border bg-white shadow-sm">
          <summary className="cursor-pointer px-4 py-3 text-base font-bold text-slate-950 sm:px-5">
            このテーマの収益計算
          </summary>
          <div className="grid gap-4 border-t border-border p-4 sm:p-5">
            <p className="text-sm leading-6 text-muted-foreground">
              現在の市場価格を初期値にして、想定売却価格、投資額、USD/JPY、手数料から参考損益を確認できます。
            </p>
            <CalculatorClient
              initialUsdJpy={rate.usdJpy}
              rateStatus={rate.status}
              initialBuyPrice={market.yesPrice}
              initialSellPrice={Math.min(0.99, Math.max(0.01, market.yesPrice + 0.08))}
            />
          </div>
        </details>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>確率推移</CardTitle>
            </CardHeader>
            <CardContent>
              <ProbabilityChart data={market.priceHistory} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>出来高推移</CardTitle>
            </CardHeader>
            <CardContent>
              <VolumeChart data={market.volumeHistory} />
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_0.75fr]">
          <details className="rounded-lg border border-border bg-white shadow-sm">
            <summary className="cursor-pointer px-4 py-3 text-base font-bold text-slate-950 sm:px-5">
              解決条件
            </summary>
            <div className="grid gap-4 border-t border-border p-4 sm:p-5">
              <p className="whitespace-pre-line text-sm leading-7 text-muted-foreground">{market.description}</p>
              <p className="text-sm font-semibold">判定に使われる情報: {market.resolutionSource || "Polymarketの市場ルール"}</p>
            </div>
          </details>
          <details className="rounded-lg border border-border bg-white shadow-sm">
            <summary className="cursor-pointer px-4 py-3 text-base font-bold text-slate-950 sm:px-5">
              確認ポイント
            </summary>
            <div className="border-t border-border p-4 sm:p-5">
              <div className="mb-4 grid gap-2 rounded-md bg-slate-50 p-3 text-sm text-muted-foreground">
                <p>次回イベント日: {formatDate(market.endDate)}</p>
                <p>ニュース・公式情報: {themeNews.length}件</p>
                <p>通貨換算: このテーマ内の収益計算でUSD/JPYを確認</p>
                <p>リスク注意: 流動性、スプレッド、解決条件を確認</p>
              </div>
              <ul className="grid gap-3 text-sm leading-6 text-muted-foreground">
                {market.watchPoints.map((point) => (
                  <li key={point} className="rounded-md bg-slate-50 p-3">
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>

        <details className="rounded-lg border border-border bg-white shadow-sm">
          <summary className="cursor-pointer px-4 py-3 text-base font-bold text-slate-950 sm:px-5">
            ニュース・公式情報
          </summary>
          <div className="grid gap-3 border-t border-border p-4 sm:p-5">
            {themeNews.map((item) => (
              <a
                key={item.id}
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="grid gap-1 rounded-md border border-border p-4 hover:bg-slate-50"
              >
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={item.kind === "公式情報" ? "live" : "secondary"}>{item.kind}</Badge>
                  <span>{item.source}</span>
                  <span>{formatDate(item.publishedAt)}</span>
                </span>
                <span className="text-sm font-semibold text-slate-950">{item.title}</span>
              </a>
            ))}
          </div>
        </details>
      </section>
    </AppShell>
  );
}

function MarketReadinessPanel({ probability, liquidity, spread, volume }: { probability: number; liquidity: number; spread: number | null; volume: number }) {
  const liquiditySignal = getLiquiditySignal(liquidity);
  const spreadSignal = getSpreadSignal(spread);
  const attention = probability >= 0.65 ? "成立寄り" : probability <= 0.35 ? "不成立寄り" : "拮抗";

  return (
    <section className="grid gap-3 rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-slate-950">このテーマの見方</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">まず市場の確率、次に取引の厚みと価格差を確認します。</p>
          </div>
          <span className="rounded-full bg-primary px-3 py-1 text-xs font-bold text-primary-foreground">{attention}</span>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground">
            <span>不成立</span>
            <span>現在 {formatPercent(probability)}</span>
            <span>成立</span>
          </div>
          <div className="relative mt-3 h-3 rounded-full bg-slate-200">
            <div className="h-3 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, probability * 100))}%` }} />
            <div className="absolute -top-1 h-5 w-1 rounded-full bg-slate-950" style={{ left: `calc(${Math.min(100, Math.max(0, probability * 100))}% - 2px)` }} />
          </div>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        <SignalBox title="取引の厚み" value={formatUsd(liquidity)} signal={liquiditySignal} />
        <SignalBox title="価格差" value={spread === null ? "-" : spread.toFixed(3)} signal={spreadSignal} />
        <SignalBox title="注目度" value={formatUsd(volume)} signal={{ label: "出来高", tone: "neutral", icon: Gauge }} />
      </div>
    </section>
  );
}

function SignalBox({ title, value, signal }: { title: string; value: string; signal: { label: string; tone: "good" | "watch" | "bad" | "neutral"; icon: LucideIcon } }) {
  const Icon = signal.icon;
  return (
    <div className={`flex items-center gap-3 rounded-lg p-3 ${signalSoftClass(signal.tone)}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${signalIconClass(signal.tone)}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-muted-foreground">{title}</p>
        <p className="mt-0.5 break-words text-base font-bold text-slate-950">{value}</p>
        <p className="text-xs font-semibold text-muted-foreground">{signal.label}</p>
      </div>
    </div>
  );
}

function dedupeNews(items: NewsItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url || item.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Metric({ title, value, emphasis = false }: { title: string; value: string; emphasis?: boolean }) {
  return (
    <div className="grid content-start gap-1 rounded-lg border border-border bg-white p-3 shadow-sm sm:p-4">
      <span className="text-[11px] font-semibold leading-tight text-slate-500 sm:text-xs">{title}</span>
      <span
        className={
          emphasis
            ? "text-xl font-bold text-primary sm:text-2xl"
            : "break-words text-base font-bold text-slate-950 sm:text-xl"
        }
      >
        {value}
      </span>
    </div>
  );
}

function getLiquiditySignal(liquidity: number) {
  if (liquidity >= 100_000) return { label: "見やすい", tone: "good" as const, icon: CheckCircle2 };
  if (liquidity >= 10_000) return { label: "標準", tone: "watch" as const, icon: Gauge };
  return { label: "薄め", tone: "bad" as const, icon: AlertCircle };
}

function getSpreadSignal(spread: number | null) {
  if (spread === null || !Number.isFinite(spread)) return { label: "確認中", tone: "neutral" as const, icon: Gauge };
  if (spread <= 0.03) return { label: "狭い", tone: "good" as const, icon: CheckCircle2 };
  if (spread <= 0.08) return { label: "やや広い", tone: "watch" as const, icon: AlertCircle };
  return { label: "広い", tone: "bad" as const, icon: AlertCircle };
}

function signalSoftClass(tone: "good" | "watch" | "bad" | "neutral") {
  const classes = {
    good: "bg-emerald-50",
    watch: "bg-amber-50",
    bad: "bg-rose-50",
    neutral: "bg-slate-50",
  };
  return classes[tone];
}

function signalIconClass(tone: "good" | "watch" | "bad" | "neutral") {
  const classes = {
    good: "bg-emerald-100 text-emerald-700",
    watch: "bg-amber-100 text-amber-700",
    bad: "bg-rose-100 text-rose-700",
    neutral: "bg-slate-100 text-primary",
  };
  return classes[tone];
}
