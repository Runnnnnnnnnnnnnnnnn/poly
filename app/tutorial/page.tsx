import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

const steps = [
  "テーマを探す",
  "確率を見る",
  "ニュース・一次情報を確認する",
  "収益計算を試す",
  "ウォッチリストに追加する",
  "AIコンシェルジュに質問する",
  "投資助言ではないことを確認する",
];

export default function TutorialPage() {
  return (
    <AppShell>
      <section className="grid gap-6">
        <div className="grid gap-2">
          <p className="text-sm font-bold text-primary">3 minute tutorial</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">チュートリアル</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            初めて見る人でも流れが分かるように、確認する順番を短くまとめています。
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

        <div className="rounded-lg border border-border bg-white p-6 shadow-sm">
          <p className="mb-4 text-sm leading-6 text-muted-foreground">
            本サービスは投資助言ではありません。市場の読み取り、関連情報の整理、参考計算に用途を限定しています。
          </p>
          <Button asChild>
            <Link href="/markets">テーマ一覧へ進む</Link>
          </Button>
          <div className="mt-3">
            <AskConciergeButton label="この市場について聞く" />
          </div>
        </div>
      </section>
    </AppShell>
  );
}

function copyForStep(index: number) {
  const copy = [
    "世界で注目されているテーマと日本に関係するテーマを分けて確認します。",
    "YES価格を市場参加者の見方として読み、出来高と流動性も合わせて見ます。",
    "国会、e-Gov、日銀などの公式情報を確認し、価格だけで判断しないようにします。",
    "購入価格、想定売却価格、投資額、為替、手数料から参考損益を試算します。",
    "気になるテーマをウォッチリストに保存します。",
    "AIコンシェルジュに、確率の見方や公式情報の整理を質問します。",
    "注文ボタン、秘密鍵入力、ウォレット署名、自動売買がないことを確認します。",
  ];
  return copy[index];
}
