import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Bot,
  CalendarClock,
  ExternalLink,
  Flag,
  Globe2,
  Layers3,
  Link2,
  Newspaper,
  Scale,
  Search,
  TrendingUp,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  marketScaleNotes,
  officialPolymarketLinks,
  polymarketReferenceLinks,
  type ReferenceLink,
} from "@/lib/polymarket-reference-links";
import { AskConciergeButton } from "@/src/components/ai/AskConciergeButton";

const allReferenceLinks = [...officialPolymarketLinks, ...polymarketReferenceLinks];

function findRef(urlPart: string): ReferenceLink | undefined {
  return allReferenceLinks.find((link) => link.url.includes(urlPart));
}

// セクションごとに、本文で触れた内容の参照元をひも付ける
const basicsRefs = [
  findRef("polymarket.com/ja"),
  findRef("docs.polymarket.us"),
  findRef("diamond.jp/crypto"),
  findRef("coincheck.com"),
  findRef("innovationlaw.jp"),
].filter(Boolean) as ReferenceLink[];

const outlookRefs = [
  findRef("coindesk.com"),
  findRef("hashhub-research.com"),
  findRef("finance.yahoo.co.jp"),
  findRef("coincheck.com"),
].filter(Boolean) as ReferenceLink[];

const tocItems = [
  { id: "basics", label: "Polymarketとは", icon: BookOpen },
  { id: "how-to-use", label: "このサイトの使い方", icon: Layers3 },
  { id: "outlook", label: "これからの展望", icon: TrendingUp },
];

const basicsPoints = [
  {
    icon: TrendingUp,
    title: "予測市場という仕組み",
    body: "Polymarketは、選挙・経済・スポーツ・テックなど将来の出来事について「起きる(YES) / 起きない(NO)」を売買できる予測市場です。参加者の売買によって価格が動き、その価格が市場全体の見立てを表します。",
  },
  {
    icon: BarChart3,
    title: "価格 ≒ 予想確率",
    body: "YESの価格が0.42（42セント）付近なら、市場はその出来事をおおむね42%程度の見方として扱っている、と読みます。決済にはステーブルコイン(USDC)が使われ、価格は0〜1ドルの範囲で推移します。",
  },
  {
    icon: Scale,
    title: "判定とデータの透明性",
    body: "市場はブロックチェーン上で運営され、結果は決められた解決条件とオラクル（外部情報）にもとづいて判定されます。価格・出来高・取引履歴が公開され、第三者が検証しやすい点が特徴です。",
  },
];

const usageSteps = [
  {
    icon: Search,
    title: "予測市場一覧でテーマを探す",
    body: "「予測市場一覧」では、テーマを国内・国外に分けて表示します。各カードで確率レンジ・YES倍率・出来高をひと目で確認でき、関連する個別市場もまとめて見られます。",
  },
  {
    icon: BarChart3,
    title: "詳細ページで深掘りする",
    body: "テーマを開くと、現在確率・倍率・Best Bid/Ask・スプレッド・出来高・流動性を一覧表示。確率推移と出来高のチャート、解決条件、確認ポイント、収益計算まで1ページで把握できます。",
  },
  {
    icon: Newspaper,
    title: "ニュースで背景を確認する",
    body: "「ニュース」では報道と公式情報を並べ、それぞれに関連するテーマを自動でひも付けます。価格の動きとニュースを分けて読み、背景情報として整理できます。",
  },
  {
    icon: Bot,
    title: "AIリサーチアシスタントに相談する",
    body: "画面右下の「リサーチ相談」から、用語の意味や読み方、確認ポイントを質問できます。表示中のテーマに沿って要点を整理します（投資助言や自動売買は行いません）。",
  },
];

const roadmap = [
  {
    period: "現在 — 2026年",
    title: "予測市場が世界的に拡大",
    body: "2024年の米大統領選をきっかけに注目が広がり、政治・地政学・暗号資産・スポーツへテーマが拡大しています。Coincheckのオンチェーン分析では、2026年3月のPolymarket月間取引高は約95億ドル、月間アクティブユーザーは約78万ウォレット規模と整理されています。",
    icon: Globe2,
    accent: true,
  },
  {
    period: "短期",
    title: "日本では「情報用途」が現実的な入口",
    body: "日本国内から金銭を賭ける利用には賭博規制などの法的リスクがあります。当面は価格やニュースを情報として読む用途や、限定的な実証・ランキング型の設計が現実的な入口として議論されています。",
    icon: Search,
  },
  {
    period: "中期",
    title: "規制整備と設計の議論",
    body: "予測市場を「賭博」と見るか「未来予測のインフラ」と見るかは論点が分かれます。金融商品としての扱いや、金銭参加によらない競技・ランキング化など、日本に合わせた設計案が提案されています。",
    icon: Scale,
  },
  {
    period: "2030年（目標）",
    title: "Polymarketが日本での承認を目指す",
    body: "報道によれば、Polymarketは2030年までに日本での予測市場の承認獲得を目指す方針を示しています。実現には国内の厳しい規制との整合が前提で、段階的な制度整備が鍵になります。",
    icon: Flag,
    accent: true,
  },
];

export default function OnboardingPage() {
  return (
    <AppShell>
      <article className="grid gap-8">
        {/* ヒーロー */}
        <header className="grid gap-5 rounded-lg border border-border bg-white p-5 shadow-sm sm:p-6 md:p-8">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="grid gap-3">
              <p className="text-sm font-bold text-primary">Polymarket Watch</p>
              <h1 className="text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl md:text-5xl">Polymarketとは</h1>
              <p className="max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base sm:leading-8">
                Polymarketは、ニュースで話題になる出来事の「起きやすさ」を価格として読み取れる予測市場です。このページでは、①Polymarketの基本、②このサイトの使い方、③これからの展望を、複数の公式・解説記事を引用しながら一通り理解できるように整理しています。
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
              <AskConciergeButton label="AIリサーチアシスタントに相談" context={{ kind: "home", title: "Polymarketとは" }} />
            </div>
          </div>

          {/* 目次 */}
          <nav aria-label="このページの目次" className="grid gap-2 border-t border-border pt-4 sm:grid-cols-3">
            {tocItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-primary/40 hover:bg-accent"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="text-[11px] font-bold text-muted-foreground">0{index + 1}</span>
                    <span className="block leading-tight">{item.label}</span>
                  </span>
                </a>
              );
            })}
          </nav>
        </header>

        {/* 01 基本解説 */}
        <section id="basics" className="grid scroll-mt-24 gap-4">
          <SectionHeading step="01" title="Polymarketとは" lead="複数の公式・解説記事をもとに、仕組みと現状を整理します。" />

          <Card>
            <CardContent className="grid gap-4 p-5 sm:p-6">
              <p className="text-sm leading-7 text-slate-700 sm:text-base sm:leading-8">
                Polymarketは、将来の出来事について市場参加者の見方を価格として集約する「予測市場(Prediction Market)」です。世論調査や専門家コメントと違い、参加者が自分の資金で売買しながら価格を更新していくため、ニュースへの反応や関心の高さが数字に表れやすいのが特徴だと、ダイヤモンド・ザイ系のCRYPTO INSIGHTやCoincheckのレポートは説明しています。決済にはステーブルコイン(USDC)が使われ、取引や価格はブロックチェーン上に公開されます。
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                {basicsPoints.map((point) => {
                  const Icon = point.icon;
                  return (
                    <div key={point.title} className="grid content-start gap-2 rounded-lg border border-border bg-slate-50 p-4">
                      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-white text-primary">
                        <Icon className="h-5 w-5" />
                      </span>
                      <p className="text-sm font-bold text-slate-950">{point.title}</p>
                      <p className="text-sm leading-6 text-muted-foreground">{point.body}</p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BarChart3 className="h-5 w-5 text-primary" />
                市場規模で見る現在地
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ul className="grid gap-2">
                {marketScaleNotes.map((note) => (
                  <li key={note} className="flex gap-2 rounded-md bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                    <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm leading-7 text-muted-foreground">
                これらの数字は出典記事の集計時点のものです。市場規模は短期間で大きく変動するため、最新の傾向は出典元や「予測市場一覧」の出来高でご確認ください。
              </p>
            </CardContent>
          </Card>

          <CitationList title="このセクションの引用・参照元" links={basicsRefs} />
        </section>

        {/* 02 使い方 */}
        <section id="how-to-use" className="grid scroll-mt-24 gap-4">
          <SectionHeading step="02" title="このサイトの使い方" lead="情報整理に特化したダッシュボードです。売買・注文・ウォレット接続は行いません。" />

          <div className="grid gap-3 md:grid-cols-2">
            {usageSteps.map((step, index) => {
              const Icon = step.icon;
              return (
                <Card key={step.title}>
                  <CardContent className="grid gap-2 p-5">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-primary">
                        <Icon className="h-5 w-5" />
                      </span>
                      <span className="text-xs font-bold text-muted-foreground">STEP {index + 1}</span>
                    </div>
                    <p className="text-base font-bold text-slate-950">{step.title}</p>
                    <p className="text-sm leading-6 text-muted-foreground">{step.body}</p>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm leading-6 text-muted-foreground">
                数字の読み方をもっと詳しく知りたいときは「読み方ガイド」、用語をすぐ確認したいときは右下のAIリサーチアシスタントが便利です。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/tutorial">
                    読み方ガイド <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button asChild size="sm">
                  <Link href="/markets">
                    予測市場一覧へ <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* 03 展望・ロードマップ */}
        <section id="outlook" className="grid scroll-mt-24 gap-4">
          <SectionHeading step="03" title="これからの展望" lead="グローバルの成長と、日本での見通し・ロードマップを整理します。" />

          <Card>
            <CardContent className="grid gap-5 p-5 sm:p-6">
              <ol className="grid gap-0">
                {roadmap.map((item, index) => {
                  const Icon = item.icon;
                  const isLast = index === roadmap.length - 1;
                  return (
                    <li key={item.title} className="grid grid-cols-[auto_1fr] gap-x-4">
                      {/* タイムライン軸 */}
                      <div className="flex flex-col items-center">
                        <span
                          className={
                            item.accent
                              ? "flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground"
                              : "flex h-10 w-10 items-center justify-center rounded-full border border-border bg-white text-primary"
                          }
                        >
                          <Icon className="h-5 w-5" />
                        </span>
                        {!isLast ? <span className="my-1 w-px flex-1 bg-border" /> : null}
                      </div>
                      <div className={isLast ? "pb-0" : "pb-6"}>
                        <p className="flex items-center gap-1 text-xs font-bold text-primary">
                          <CalendarClock className="h-3.5 w-3.5" />
                          {item.period}
                        </p>
                        <p className="mt-1 text-base font-bold text-slate-950">{item.title}</p>
                        <p className="mt-1 text-sm leading-7 text-muted-foreground">{item.body}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          <CitationList title="このセクションの引用・参照元" links={outlookRefs} />
        </section>

        {/* 注意点 */}
        <section className="grid gap-3 rounded-lg border border-border bg-white p-5 shadow-sm sm:p-6">
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-slate-950">
            <Scale className="h-5 w-5 text-primary" />
            数字を見るときの注意点
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <p className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
              日本国内から金銭を賭ける利用には法的リスクがあります。このダッシュボードは市場データを情報として読むことに限定し、投資助言・注文送信・自動売買・ウォレット接続は行いません。
            </p>
            <p className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
              市場価格は将来を保証するものではありません。出来高、流動性、スプレッド、解決条件、関連ニュースを合わせて確認してください。
            </p>
          </div>
        </section>
      </article>
    </AppShell>
  );
}

function SectionHeading({ step, title, lead }: { step: string; title: string; lead: string }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">{step}</span>
        <h2 className="text-xl font-bold tracking-tight text-slate-950 md:text-2xl">{title}</h2>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{lead}</p>
    </div>
  );
}

function CitationList({ title, links }: { title: string; links: ReferenceLink[] }) {
  return (
    <div className="grid gap-3 rounded-lg border border-dashed border-border bg-white p-4 sm:p-5">
      <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
        <Link2 className="h-4 w-4 text-primary" />
        {title}
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.url}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="grid h-full gap-1 rounded-md border border-border p-3 transition-colors hover:border-primary/40 hover:bg-slate-50"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-primary">{link.kind}</span>
                <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
              </span>
              <span className="text-sm font-bold leading-snug text-slate-950">{link.title}</span>
              <span className="text-xs text-muted-foreground">{link.source}</span>
              <span className="text-xs leading-5 text-muted-foreground">{link.note}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
