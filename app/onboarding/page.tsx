import Link from "next/link";
import { ArrowRight, ExternalLink, ShieldAlert } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { marketScaleNotes, officialPolymarketLinks, polymarketReferenceLinks, type ReferenceLink } from "@/lib/polymarket-reference-links";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

const basics = [
  {
    title: "何を見るか",
    body: "市場ごとの確率、倍率、出来高、流動性、判定条件を確認します。",
  },
  {
    title: "価格の読み方",
    body: "確率が42%なら、当たった場合の参考倍率は約2.4倍です。",
  },
  {
    title: "注意点",
    body: "日本国内から金銭を賭ける利用は法的リスクがあります。この画面は情報整理用です。",
  },
];

export default function OnboardingPage() {
  return (
    <AppShell>
      <section className="grid gap-8">
        <div className="grid gap-5 rounded-lg border border-border bg-white p-6 shadow-sm md:p-8">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="grid gap-3">
              <p className="text-sm font-bold text-primary">Polymarket Watch</p>
              <h1 className="text-4xl font-bold tracking-tight text-slate-950 md:text-5xl">Polymarketとは</h1>
              <p className="max-w-3xl text-base leading-8 text-muted-foreground">
                将来の出来事をテーマに、市場価格から参加者の見方を読む予測市場です。実際の利用可否や法規制は国・地域で異なるため、ここでは情報整理に限定して扱います。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[260px] lg:grid-cols-1">
              <Button asChild size="lg">
                <Link href="/markets">
                  予測市場一覧へ <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="https://polymarket.com/ja" target="_blank" rel="noreferrer">
                  公式ページを見る <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
              <AskConciergeButton
                label="基本を相談"
                context={{ kind: "home", title: "Polymarketとは" }}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {basics.map((item) => (
            <Card key={item.title}>
              <CardHeader>
                <CardTitle>{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{item.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>市場規模の目安</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {marketScaleNotes.map((note) => (
              <p key={note} className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
                {note}
              </p>
            ))}
          </CardContent>
        </Card>

        <section className="grid gap-4" aria-labelledby="reference-title">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-primary" />
            <h2 id="reference-title" className="text-2xl font-bold tracking-tight text-slate-950">
              引用元リンク
            </h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {[...officialPolymarketLinks, ...polymarketReferenceLinks].map((item) => (
              <ReferenceCard key={item.url} item={item} />
            ))}
          </div>
        </section>
      </section>
    </AppShell>
  );
}

function ReferenceCard({ item }: { item: ReferenceLink }) {
  return (
    <a href={item.url} target="_blank" rel="noreferrer" className="grid gap-3 rounded-lg border border-border bg-white p-5 shadow-sm hover:border-primary/40 hover:bg-slate-50">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={item.kind === "公式" ? "live" : "outline"}>{item.kind}</Badge>
        <span className="text-xs font-semibold text-muted-foreground">{item.source}</span>
      </div>
      <div className="grid gap-1">
        <h3 className="text-base font-bold leading-snug text-slate-950">{item.title}</h3>
        <p className="text-sm leading-6 text-muted-foreground">{item.note}</p>
      </div>
      <span className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
        リンクを開く <ExternalLink className="h-4 w-4" />
      </span>
    </a>
  );
}
