import Link from "next/link";
import { CheckCircle2, ExternalLink } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { officialPolymarketLinks, polymarketReferenceLinks } from "@/lib/polymarket-reference-links";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

const steps = [
  "Polymarketの仕組みを確認する",
  "法規制と注意点を先に読む",
  "予測市場一覧でテーマを選ぶ",
  "確率・倍率・出来高を見る",
  "解決条件と公式ページを確認する",
  "ニュース・公式情報で背景を見る",
  "必要ならAI相談で要点を整理する",
];

export default function TutorialPage() {
  return (
    <AppShell>
      <section className="grid gap-6">
        <div className="grid gap-2">
          <p className="text-sm font-bold text-primary">Guide</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">読み方ガイド</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Polymarketの仕組み、法規制、テーマの見方を順番に確認します。
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {steps.map((step, index) => (
            <Card key={step}>
              <CardHeader>
                <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-accent text-primary">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <CardTitle>
                  {index + 1}. {step}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-6 text-muted-foreground">{copyForStep(index)}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>先に読むリンク</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {[officialPolymarketLinks[0], polymarketReferenceLinks[0], polymarketReferenceLinks[1], polymarketReferenceLinks[2]].map((item) => (
              <a key={item.url} href={item.url} target="_blank" rel="noreferrer" className="grid gap-1 rounded-md border border-border p-4 hover:bg-slate-50">
                <span className="text-xs font-semibold text-muted-foreground">{item.source}</span>
                <span className="text-sm font-bold text-slate-950">{item.title}</span>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                  開く <ExternalLink className="h-3.5 w-3.5" />
                </span>
              </a>
            ))}
          </CardContent>
        </Card>

        <div className="rounded-lg border border-border bg-white p-6 shadow-sm">
          <p className="mb-4 text-sm leading-6 text-muted-foreground">
            この画面は情報整理用です。注文、ウォレット接続、自動売買は行いません。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/markets">予測市場一覧へ</Link>
            </Button>
            <AskConciergeButton label="読み方を相談" context={{ kind: "tutorial", title: "読み方ガイド" }} />
          </div>
        </div>
      </section>
    </AppShell>
  );
}

function copyForStep(index: number) {
  const copy = [
    "まず公式ページと日本語の解説記事で、予測市場の基本を確認します。",
    "日本国内から金銭を賭ける利用には法的リスクがあります。参照記事を先に確認します。",
    "日本国内、国外、スポーツ、金融・為替などの分類からテーマを探します。",
    "確率は市場価格から読む見方、倍率は当たった場合の参考倍率として見ます。",
    "詳細画面からPolymarketの公式市場ページを開き、判定条件を確認します。",
    "ニュース・公式情報は価格と分けて読み、背景情報として整理します。",
    "不明点はAI相談で要点、確認ポイント、関連リンクを整理します。",
  ];
  return copy[index];
}
