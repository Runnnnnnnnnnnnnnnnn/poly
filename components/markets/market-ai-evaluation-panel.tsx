"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, History, RefreshCcw } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MarketAiEvaluation, MarketAiEvaluationsResponse } from "@/lib/types";
import { cn, formatDateTime, formatPercent } from "@/lib/utils";
import { fetchAi, isAiAvailable } from "@/src/lib/localApiClient";

const HISTORY_KEY = "polymarket-watch.ai-evaluation-history";
const HISTORY_LIMIT = 40;

type HistoryEntry = Pick<
  MarketAiEvaluation,
  "id" | "tabLabel" | "marketId" | "title" | "marketProbability" | "aiProbability" | "expectedReturnYes" | "expectedReturnNo" | "rating" | "confidence" | "evaluatedAt" | "model"
> & {
  recordedAt: string;
};

export function MarketAiEvaluationPanel() {
  const [data, setData] = useState<MarketAiEvaluationsResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState(false);
  const [liveBackend, setLiveBackend] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (silent = true) => {
    if (!silent) setLoading(true);
    try {
      const payload = await fetchAi<MarketAiEvaluationsResponse>("/api/ai/evaluations");
      if (!mountedRef.current) return;
      setData(payload);
      setError("");
      setHistory((current) => saveHistory(payload.items, current));
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "AI評価を取得できませんでした。");
    } finally {
      if (!silent && mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    setHistory(readHistory());
    const backendAvailable = isAiAvailable();
    setLiveBackend(backendAvailable);

    if (!backendAvailable) {
      // 公開（静的）版: ビルド時に鍵を使って生成したAI予想JSONを読み込む（鍵は埋め込まれない）。
      const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      void (async () => {
        try {
          const res = await fetch(`${base}/ai-evaluations.json`, { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const payload = (await res.json()) as MarketAiEvaluationsResponse;
          if (!mountedRef.current) return;
          if (payload.items?.length) {
            setData(payload);
            setHistory((current) => saveHistory(payload.items, current));
          } else {
            setSnapshot(true);
          }
        } catch {
          if (mountedRef.current) setSnapshot(true);
        }
      })();
      return () => {
        mountedRef.current = false;
      };
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const latestHistory = useMemo(() => history.slice(0, 6), [history]);

  return (
    <section className="grid gap-4" aria-labelledby="ai-evaluation-title">
      <div className="grid gap-3 rounded-lg border border-border bg-white p-4 shadow-sm sm:p-5 md:p-6">
        <div className="grid gap-3 md:flex md:items-start md:justify-between">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Bot className="h-5 w-5" />
              </span>
              <div>
                <h2 id="ai-evaluation-title" className="text-2xl font-bold tracking-tight text-slate-950">
                  AI予想
                </h2>
                <p className="text-sm leading-6 text-muted-foreground">
                  国内と国外から注目度が高いテーマを1件ずつ選び、市場データと関連情報から参考評価します。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={snapshot ? "fallback" : error ? "error" : data?.status ?? "fallback"} />
              <span className="text-xs font-semibold text-muted-foreground">
                {snapshot
                  ? "公開版では準備中"
                  : data
                    ? `${liveBackend ? "最終評価" : "公開版のAI予想"} ${formatDateTime(data.updatedAt)}`
                    : "評価を取得中"}
              </span>
              {liveBackend && error ? <span className="text-xs text-muted-foreground">更新できませんでした</span> : null}
            </div>
          </div>
          {liveBackend ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh(false)} disabled={loading}>
              <RefreshCcw className={cn("h-4 w-4", loading ? "animate-spin" : "")} />
              再評価
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {(data?.items ?? []).map((item) => (
            <EvaluationCard key={item.id} item={item} previous={previousForItem(item, history)} />
          ))}
          {!data?.items?.length ? (
            <div className="rounded-md border border-dashed border-border p-5 text-sm leading-6 text-muted-foreground lg:col-span-2">
              {snapshot
                ? "AI予想を準備しています。最新データに接続できる環境で表示されます。"
                : "AI評価を準備しています。リアルタイム接続時は自動で更新されます。"}
            </div>
          ) : null}
        </div>

        <details className="rounded-md border border-border bg-slate-50 p-3">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold text-slate-800">
            <History className="h-4 w-4 text-primary" />
            AI評価の履歴
          </summary>
          {latestHistory.length ? (
            <div className="mt-3 grid gap-2">
              {latestHistory.map((item) => (
                <div key={`${item.id}-${item.recordedAt}`} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="line-clamp-1 text-sm font-semibold text-slate-950">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.tabLabel} / AI {formatPercent(item.aiProbability)} / 市場 {formatPercent(item.marketProbability)} / {formatDateTime(item.recordedAt)}
                    </p>
                  </div>
                  <Badge variant="outline">検証待ち</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              評価履歴はこのブラウザに保存されます。解決済み判定が取得できるまでは「検証待ち」として蓄積します。
            </p>
          )}
        </details>
      </div>
    </section>
  );
}

function EvaluationCard({ item, previous }: { item: MarketAiEvaluation; previous?: HistoryEntry }) {
  return (
    <article className="grid gap-4 rounded-lg border border-border bg-slate-50 p-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{item.tabLabel}</Badge>
          <Badge variant={item.rating === "様子見" ? "outline" : "live"}>{item.rating}</Badge>
          <span className="text-xs font-semibold text-muted-foreground">信頼度 {item.confidence}</span>
        </div>
        <h3 className="text-lg font-bold leading-snug text-slate-950">{item.title}</h3>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <SmallMetric label="AI確率" value={formatPercent(item.aiProbability)} emphasis />
        <SmallMetric label="市場確率" value={formatPercent(item.marketProbability)} />
        <SmallMetric label="YES期待" value={formatReturn(item.expectedReturnYes)} />
      </div>

      {previous ? (
        <p className="rounded-md bg-white p-2 text-xs font-semibold text-muted-foreground">
          前回比: AI確率 {formatSignedPercent(item.aiProbability - previous.aiProbability)} / 市場確率 {formatSignedPercent(item.marketProbability - previous.marketProbability)}
        </p>
      ) : null}

      <details className="rounded-md border border-border bg-white p-3">
        <summary className="cursor-pointer text-sm font-bold text-slate-800">評価理由と根拠を表示</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="grid gap-2">
            <p className="text-xs font-bold text-muted-foreground">評価理由</p>
            <ul className="grid gap-1 text-sm leading-6 text-muted-foreground">
              {item.reasons.slice(0, 3).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-bold text-muted-foreground">根拠データ</p>
            <ul className="grid gap-1 text-sm leading-6 text-muted-foreground">
              {item.evidence.slice(0, 3).map((evidence) => (
                <li key={evidence}>{evidence}</li>
              ))}
              <li>NO期待 {formatReturn(item.expectedReturnNo)}</li>
            </ul>
          </div>
        </div>
      </details>
    </article>
  );
}

function SmallMetric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="grid min-h-[58px] gap-1 rounded-md bg-white p-2.5 sm:min-h-[64px] sm:p-3">
      <span className="text-[11px] font-semibold leading-tight text-slate-500">{label}</span>
      <span className={cn("break-words font-bold", emphasis ? "text-base text-primary sm:text-xl" : "text-sm text-slate-950")}>{value}</span>
    </div>
  );
}

function readHistory() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: MarketAiEvaluation[], current: HistoryEntry[]) {
  const nextEntries = items.map((item) => ({
    id: item.id,
    tabLabel: item.tabLabel,
    marketId: item.marketId,
    title: item.title,
    marketProbability: item.marketProbability,
    aiProbability: item.aiProbability,
    expectedReturnYes: item.expectedReturnYes,
    expectedReturnNo: item.expectedReturnNo,
    rating: item.rating,
    confidence: item.confidence,
    evaluatedAt: item.evaluatedAt,
    model: item.model,
    recordedAt: new Date().toISOString(),
  }));
  const seen = new Set<string>();
  const merged = [...nextEntries, ...current].filter((entry) => {
    const key = `${entry.id}:${entry.evaluatedAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, HISTORY_LIMIT);
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(merged));
  return merged;
}

function previousForItem(item: MarketAiEvaluation, history: HistoryEntry[]) {
  return history.find((entry) => entry.id === item.id && entry.evaluatedAt !== item.evaluatedAt);
}

function formatReturn(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
}

function formatSignedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
}
