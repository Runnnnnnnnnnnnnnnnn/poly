import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { MarketDetailTabs } from "@/components/markets/market-detail-tabs";
import { MarketImage } from "@/components/markets/market-image";
import { WatchButton } from "@/components/markets/watch-button";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCalculatorDefaults, getMarketDetailDashboard, getMarketsDashboard } from "@/lib/server/dashboard";
import type { NewsItem } from "@/lib/types";
import { formatDate } from "@/lib/utils";
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

        <MarketDetailTabs market={market} rate={rate} themeNews={themeNews} sourceStatuses={data.sourceStatuses} />
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
