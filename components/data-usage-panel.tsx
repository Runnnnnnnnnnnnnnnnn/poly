import { Activity, Bot, Database, LineChart, Newspaper, WalletCards } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import type { DataStatus, SourceStatus } from "@/lib/types";

type DataUsagePanelProps = {
  mode: "markets" | "detail" | "news" | "model";
  sourceStatuses?: SourceStatus[];
  compact?: boolean;
};

const DATA_USAGE = {
  markets: [
    {
      icon: Activity,
      label: "市場データ",
      body: "確率、倍率、出来高、流動性を使って、注目テーマの順番と見やすさを決めています。",
    },
    {
      icon: Newspaper,
      label: "ニュース・公式情報",
      body: "価格を動かしそうな背景情報として扱い、テーマとの関連度が低い記事は表示しません。",
    },
    {
      icon: Bot,
      label: "AI予想",
      body: "国内と国外から盛り上がっているテーマを1件ずつ選び、市場価格から大きく外れすぎない保守的な参考確率を出します。",
    },
    {
      icon: Database,
      label: "評価履歴",
      body: "AI予想を保存し、あとで結果が確定した市場と比べてモデル改善に使います。",
    },
  ],
  detail: [
    {
      icon: Activity,
      label: "市場データ",
      body: "現在確率、スプレッド、出来高、流動性を、このテーマの読みやすさの判断材料にしています。",
    },
    {
      icon: LineChart,
      label: "履歴データ",
      body: "確率推移と出来高推移を見て、急な変化や注目度の変化を確認します。",
    },
    {
      icon: Newspaper,
      label: "関連情報",
      body: "ニュースと公式情報は、判定条件や背景確認のためにまとめています。",
    },
    {
      icon: WalletCards,
      label: "収益計算",
      body: "現在価格、想定売却価格、投資額、USD/JPY、手数料から参考損益を計算します。",
    },
  ],
  news: [
    {
      icon: Newspaper,
      label: "ニュース",
      body: "広く読まれている報道やトレンド記事を背景情報として並べています。",
    },
    {
      icon: Database,
      label: "関連テーマ",
      body: "記事のカテゴリ、関連市場名、重要語句を見て、近いテーマだけを表示します。",
    },
    {
      icon: Bot,
      label: "AI相談",
      body: "相談時は、表示中のニュースと関連テーマを要約の材料にします。",
    },
  ],
  model: [
    {
      icon: Database,
      label: "保存データ",
      body: "市場価格のスナップショット、AI予想、検証結果を蓄積します。",
    },
    {
      icon: LineChart,
      label: "成績評価",
      body: "予測誤差、的中率、損益を見て、モデルが改善しているか確認します。",
    },
    {
      icon: Activity,
      label: "仮想運用",
      body: "注文送信はせず、過去データと仮想の売買記録で仮説を検証します。",
    },
  ],
} as const;

export function DataUsagePanel({ mode, sourceStatuses = [], compact = false }: DataUsagePanelProps) {
  const items = DATA_USAGE[mode];

  return (
    <section className="rounded-lg border border-border bg-white p-3 shadow-sm sm:p-4" aria-label="データの使い道">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Database className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-950">データの使い道</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                売買注文は行わず、見る・比べる・検証するために使います。
              </p>
            </div>
          </div>
          {sourceStatuses.length ? <Badge variant="outline">{sourceStatuses.length}系統</Badge> : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <span key={item.label} className="inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-700">
                <Icon className="h-3.5 w-3.5 text-primary" />
                {item.label}
              </span>
            );
          })}
        </div>

        <details className="rounded-md border border-border bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-bold text-slate-800">詳しい使い道を見る</summary>
          <div className={compact ? "mt-3 grid gap-2 md:grid-cols-2" : "mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"}>
            {items.map((item) => (
              <div key={item.label} className="rounded-md bg-white p-3">
                <p className="text-sm font-bold text-slate-950">{item.label}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </details>

        {sourceStatuses.length ? (
          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">データ元ごとの取得状況を見る</summary>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {sourceStatuses.map((source) => (
                <div key={`${source.source}-${source.message ?? ""}`} className="flex items-center justify-between gap-3 rounded-md bg-white p-2.5">
                  <span className="min-w-0 truncate text-xs font-semibold text-slate-700">{sourceLabel(source.source)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusBadge status={source.status as DataStatus} />
                    {source.message ? <span className="hidden text-xs text-muted-foreground sm:inline">{source.message}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function sourceLabel(source: string) {
  if (/Gamma|Polymarket API|markets/i.test(source)) return "市場テーマ・基本情報";
  if (/CLOB|book|spread/i.test(source)) return "価格差・板情報";
  if (/BOJ|日本銀行/.test(source)) return "日本銀行の公式情報";
  if (/Reuters|Bloomberg|日経|Google|CoinDesk|news/i.test(source)) return "ニュース・報道";
  if (/DeepSeek|AI/i.test(source)) return "AI評価";
  return source;
}
