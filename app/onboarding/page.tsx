import Link from "next/link";
import { ArrowRight, BookOpen, ExternalLink, Scale, TrendingUp } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { marketScaleNotes, officialPolymarketLinks, polymarketReferenceLinks, type ReferenceLink } from "@/lib/polymarket-reference-links";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

const overviewCards = [
  {
    title: "予測市場",
    body: "政治、金融、スポーツ、テックなど、将来の出来事に対して「起きる / 起きない」の見方が取引されます。",
  },
  {
    title: "価格の意味",
    body: "YESが0.42付近なら、市場参加者はその出来事をおおむね42%程度の見方として扱っている、と読みます。",
  },
  {
    title: "この画面の用途",
    body: "売買やウォレット接続ではなく、ニュース、価格、出来高、判定条件を並べて情報整理するために使います。",
  },
];

const explainerSections = [
  {
    title: "Polymarketで分かること",
    icon: BookOpen,
    body: "Polymarketは、将来の出来事について市場参加者の見方を価格として集約する予測市場です。世論調査や専門家コメントとは違い、参加者が価格を通じて見方を更新するため、ニュースへの反応や市場の関心が数字に出やすい点が特徴です。",
  },
  {
    title: "市場規模と注目度",
    icon: TrendingUp,
    body: "2024年の米大統領選をきっかけに注目が広がり、その後も政治、地政学、暗号資産、スポーツなどへテーマが拡大しています。日本語のオンチェーン分析記事では、2026年3月のPolymarket月間取引高が約95億ドル、月間アクティブユーザーが約78万ウォレット規模だったと整理されています。",
  },
  {
    title: "日本での見通し",
    icon: Scale,
    body: "日本では、金銭参加型の予測市場は賭博規制や金融規制との関係が大きな論点です。一方で、Polymarketが2030年までの日本承認を目指す動きも報じられており、短期的には情報を見る用途や限定的な実証、ランキング型の設計が現実的な入口として議論されています。",
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
                ニュースで話題になる出来事について、市場参加者の見方を価格として読むための予測市場です。ここでは売買ではなく、価格、出来高、ニュース、判定条件を情報として整理します。
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
          {overviewCards.map((item) => (
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

        <div className="grid gap-4">
          {explainerSections.map((section) => {
            const Icon = section.icon;
            return (
              <Card key={section.title}>
                <CardHeader>
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-accent text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <CardTitle>{section.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-7 text-muted-foreground">{section.body}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="grid gap-3 rounded-lg border border-border bg-white p-5 shadow-sm">
          <h2 className="text-xl font-bold tracking-tight text-slate-950">数字を見るときの注意点</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {marketScaleNotes.map((note) => (
              <p key={note} className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
                {note}
              </p>
            ))}
            <p className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
              日本国内から金銭を賭ける利用には法的リスクがあります。このダッシュボードでは市場データを情報として読むことに限定します。
            </p>
            <p className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
              市場価格は将来を保証するものではありません。出来高、流動性、スプレッド、判定条件、関連ニュースを合わせて確認します。
            </p>
          </div>
        </div>

        <section className="grid gap-4" aria-labelledby="reference-title">
          <div className="flex items-center gap-2">
            <h2 id="reference-title" className="text-2xl font-bold tracking-tight text-slate-950">
              さらに読む
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
