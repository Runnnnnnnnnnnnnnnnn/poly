import Link from "next/link";
import { ArrowRight, BookOpen, ChartNoAxesCombined, CircleDollarSign, Info, Landmark, ShieldAlert } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

const cards = [
  {
    title: "Polymarketとは",
    icon: Landmark,
    body: "将来の出来事について、市場参加者がYES/NOの価格を通じて見方を表す予測市場です。",
  },
  {
    title: "予測市場の見方",
    icon: ChartNoAxesCombined,
    body: "市場価格、出来高、流動性、解決条件を合わせて確認します。",
  },
  {
    title: "価格と確率の関係",
    icon: CircleDollarSign,
    body: "YES価格が0.42なら、市場価格としては約42%の見方として読めます。",
  },
  {
    title: "世界と日本を分けて確認",
    icon: BookOpen,
    body: "世界で盛り上がるテーマと、日本に関係するテーマを同じ画面で比較できます。",
  },
  {
    title: "Polymarket Watchでできること",
    icon: Info,
    body: "注目テーマの確認、関連情報の整理、価格と確率の読み取り、参考シナリオの試算ができます。",
  },
  {
    title: "注意点",
    icon: ShieldAlert,
    body: "投資助言ではありません。自動売買、注文送信、ウォレット接続は実装しません。",
  },
];

export default function OnboardingPage() {
  return (
    <AppShell>
      <section className="grid gap-8">
        <div className="grid gap-5 rounded-lg border border-border bg-white p-6 shadow-sm md:p-8">
          <p className="text-sm font-bold text-primary">情報整理に特化した予測テーマダッシュボード</p>
          <div className="grid gap-4 lg:grid-cols-[1fr_0.55fr] lg:items-end">
            <div className="grid gap-4">
              <h1 className="text-4xl font-bold tracking-tight text-slate-950 md:text-5xl">Polymarketって何？</h1>
              <p className="max-w-3xl text-base leading-8 text-muted-foreground">
                Polymarketは、将来の出来事について「起きる」「起きない」を市場価格で表す予測市場です。
                たとえば「日銀は次回会合で利上げする？」という市場があり、YESの価格が0.42なら、市場参加者はおおよそ42%程度の確率として見ている、という意味になります。
              </p>
              <p className="max-w-3xl text-base leading-8 text-muted-foreground">
                Polymarket Watchでは、世界で注目されているテーマと日本に関係するテーマを分けて確認できます。
                市場価格は参加者の見方を知るための参考情報であり、売買を推奨するものではありません。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <Button asChild size="lg">
                <Link href="/markets">
                  注目テーマを見る <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/tutorial">3分チュートリアルを開始</Link>
              </Button>
              <AskConciergeButton
                label="AIコンシェルジュに聞いてみる"
                context={{ kind: "home", title: "Polymarket Watch" }}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <Card key={card.title}>
                <CardHeader>
                  <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-accent text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <CardTitle>{card.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm leading-6 text-muted-foreground">{card.body}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}
