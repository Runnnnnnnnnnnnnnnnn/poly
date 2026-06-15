import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { CalculatorClient } from "@/components/calculator-client";
import { ProbabilityChart, VolumeChart } from "@/components/charts/market-charts";
import { WatchButton } from "@/components/markets/watch-button";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCalculatorDefaults, getMarketDetailDashboard, getMarketsDashboard } from "@/lib/server/dashboard";
import type { NewsItem } from "@/lib/types";
import { formatDate, formatPercent, formatUsd } from "@/lib/utils";
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
            <div className="relative aspect-[16/10] bg-slate-100 lg:aspect-auto">
              <Image src={market.imageUrl} alt="" fill priority sizes="(min-width: 1024px) 42vw, 100vw" className="object-cover" />
            </div>
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
                    Polymarketで確認
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

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Metric title="現在確率" value={formatPercent(market.probability)} />
          <Metric title="YES / NO" value={`${market.yesPrice.toFixed(2)} / ${market.noPrice.toFixed(2)}`} />
          <Metric title="Best Bid / Ask" value={`${market.bestBid?.toFixed(2) ?? "-"} / ${market.bestAsk?.toFixed(2) ?? "-"}`} />
          <Metric title="スプレッド" value={market.spread === null ? "-" : market.spread.toFixed(3)} />
          <Metric title="出来高" value={formatUsd(market.volume)} />
          <Metric title="流動性" value={formatUsd(market.liquidity)} />
          <Metric title="ニュース・公式情報" value={`${themeNews.length}件`} />
          <Metric title="データ状態" value={market.status === "live" ? "リアルタイム" : "参考データ"} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>このテーマの収益計算</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm leading-6 text-muted-foreground">
              現在のYES価格を初期値にして、想定売却価格、投資額、USD/JPY、手数料から参考損益を確認できます。
            </p>
            <CalculatorClient
              initialUsdJpy={rate.usdJpy}
              rateStatus={rate.status}
              initialBuyPrice={market.yesPrice}
              initialSellPrice={Math.min(0.99, Math.max(0.01, market.yesPrice + 0.08))}
            />
          </CardContent>
        </Card>

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
              <CardTitle>出来高チャート</CardTitle>
            </CardHeader>
            <CardContent>
              <VolumeChart data={market.volumeHistory} />
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_0.75fr]">
          <Card>
            <CardHeader>
              <CardTitle>解決条件</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <p className="whitespace-pre-line text-sm leading-7 text-muted-foreground">{market.description}</p>
              <p className="text-sm font-semibold">判定に使われる情報: {market.resolutionSource || "Polymarketの市場ルール"}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>確認ポイント</CardTitle>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>ニュース・公式情報</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
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
                <span className="text-sm leading-6 text-muted-foreground">{item.summary}</span>
                <span className="text-xs text-muted-foreground">
                  関連テーマ: {item.relatedMarket ?? market.title} / {item.category}
                </span>
              </a>
            ))}
          </CardContent>
        </Card>
      </section>
    </AppShell>
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

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-bold text-slate-950">{value}</p>
      </CardContent>
    </Card>
  );
}
