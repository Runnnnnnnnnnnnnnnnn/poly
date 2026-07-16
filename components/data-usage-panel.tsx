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
      body: "Brier score、的中率、損益を見て、モデルが改善しているか確認します。",
    },
    {
      icon: Activity,
      label: "売買シミュレーション",
      body: "注文送信はせず、過去データとペーパートレードで仮説を検証します。",
    },
  ],
} as const;

export function DataUsagePanel({ mode, sourceStatuses = [], compact = false }: DataUsagePanelProps) {
  const items = DATA_USAGE[mode];

  return (
    <section className="rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5" aria-label="データの使い道">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-slate-950">データの使い道</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              この画面では、データを表示・背景確認・AI評価・モデル検証に分けて使います。
            </p>
          </div>
          {sourceStatuses.length ? <Badge variant="outline">{sourceStatuses.length}系統</Badge> : null}
        </div>

        <div className={compact ? "grid gap-2 md:grid-cols-2" : "grid gap-2 sm:grid-cols-2 xl:grid-cols-4"}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="grid gap-2 rounded-md bg-slate-50 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-primary">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="text-sm font-bold text-slate-950">{item.label}</span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{item.body}</p>
              </div>
            );
          })}
        </div>

        {sourceStatuses.length ? (
          <details className="rounded-md border border-border bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-slate-800">取得状況を表示</summary>
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
