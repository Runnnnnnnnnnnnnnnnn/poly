import { z } from "zod";

import { fetchNewsItems } from "@/lib/adapters/news";
import { fetchMarketDetail, fetchMarkets } from "@/lib/adapters/polymarket";
import {
  filterMarketGroups,
  groupMarkets,
  MARKET_THEME_TABS,
  type MarketThemeGroup,
  type MarketThemeTabId,
} from "@/lib/market-groups";
import type {
  DataStatus,
  MarketAiEvaluation,
  MarketAiEvaluationsResponse,
  MarketDetail,
  MarketSummary,
  NewsItem,
  SourceStatus,
} from "@/lib/types";
import { clamp, fetchWithTimeout, formatPercent, formatUsd } from "@/lib/utils";
import { getDeepSeekModel } from "@/src/lib/ai/deepseek";

const EVALUATION_TABS: MarketThemeTabId[] = ["featured", "japan", "finance", "politics", "crypto", "tech", "sports", "global"];

const deepSeekEvaluationResponseSchema = z.object({
  items: z.array(
    z.object({
      marketId: z.string(),
      aiProbability: z.number().min(0).max(1),
      rating: z.enum(["YES寄り", "NO寄り", "様子見"]),
      confidence: z.enum(["高", "中", "低"]),
      reasons: z.array(z.string()).max(3).default([]),
      evidence: z.array(z.string()).max(3).default([]),
    }),
  ),
});

type Candidate = {
  tabId: MarketThemeTabId;
  tabLabel: string;
  group: MarketThemeGroup;
  marketSummary: MarketSummary;
  market: MarketDetail;
  relatedNews: NewsItem[];
};

export async function getMarketAiEvaluations(): Promise<MarketAiEvaluationsResponse> {
  const sourceStatuses: SourceStatus[] = [];
  const [marketsResult, newsResult] = await Promise.all([fetchMarkets(), fetchNewsItems()]);
  sourceStatuses.push(...marketsResult.sourceStatuses, ...newsResult.sourceStatuses);

  const candidates = await buildCandidates(marketsResult.markets, newsResult.items);
  const baseline = candidates.map((candidate) => buildBaselineEvaluation(candidate, newsResult.items));
  const refined = await refineWithDeepSeek(baseline, candidates, newsResult.items).catch(() => null);
  const items = mergeEvaluations(baseline, refined);
  const status: DataStatus = refined ? "live" : process.env.DEEPSEEK_API_KEY ? "error" : "fallback";

  return {
    status,
    updatedAt: new Date().toISOString(),
    model: getDeepSeekModel(),
    items,
    sourceStatuses,
  };
}

async function buildCandidates(markets: MarketSummary[], newsItems: NewsItem[]) {
  const groups = groupMarkets(markets);
  const selected: Array<{ tabId: MarketThemeTabId; tabLabel: string; group: MarketThemeGroup; marketSummary: MarketSummary }> = [];
  const seenGroups = new Set<string>();
  const seenLabels = new Set<string>();

  for (const tabId of EVALUATION_TABS) {
    const tab = MARKET_THEME_TABS.find((item) => item.id === tabId);
    if (!tab) continue;
    const tabGroups = filterMarketGroups(groups, tabId);
    const group =
      tabGroups.find((candidate) => !seenGroups.has(candidate.id) && !seenLabels.has(candidate.label) && isForecastable(selectRepresentativeMarket(candidate))) ??
      tabGroups.find((candidate) => !seenGroups.has(candidate.id) && !seenLabels.has(candidate.label)) ??
      tabGroups[0];
    if (!group) continue;
    selected.push({ tabId, tabLabel: tab.label, group, marketSummary: selectRepresentativeMarket(group) });
    seenGroups.add(group.id);
    seenLabels.add(group.label);
  }

  const detailResults = await Promise.allSettled(selected.map((candidate) => fetchMarketDetail(candidate.marketSummary.id, newsItems)));
  return detailResults.flatMap((result, index): Candidate[] => {
    if (result.status !== "fulfilled") return [];
    const selectedCandidate = selected[index];
    return [
      {
        ...selectedCandidate,
        market: result.value.market,
        relatedNews: result.value.market.relatedNews,
      },
    ];
  });
}

function selectRepresentativeMarket(group: MarketThemeGroup) {
  const sorted = [...group.markets].sort((a, b) => b.volume + b.liquidity - (a.volume + a.liquidity));
  return sorted.find((market) => market.probability >= 0.05 && market.probability <= 0.95) ?? sorted.find((market) => market.probability > 0 && market.probability < 1) ?? group.primaryMarket;
}

function isForecastable(market: MarketSummary) {
  return market.probability >= 0.03 && market.probability <= 0.97 && market.volume + market.liquidity > 0;
}

function buildBaselineEvaluation(candidate: Candidate, allNews: NewsItem[]): MarketAiEvaluation {
  const { market, group } = candidate;
  const signals = historySignals(market);
  const momentum = signals.change7d ?? 0;
  const liquidityScore = clamp(Math.log10(Math.max(1, market.liquidity)) / 7, 0, 1);
  const newsScore = clamp(candidate.relatedNews.length / 8, 0, 1);
  const spreadPenalty = clamp((market.spread ?? 0.02) * 5, 0, 0.35);
  const adjustment = clamp(momentum * 0.45 + (liquidityScore - 0.5) * 0.04 + (newsScore - 0.25) * 0.035 - spreadPenalty * 0.08, -0.12, 0.12);
  const aiProbability = conservativeProbability(market.probability, market.probability + adjustment);
  const yesMultiplier = market.yesPrice > 0 ? 1 / market.yesPrice : null;
  const noMultiplier = market.noPrice > 0 ? 1 / market.noPrice : null;
  const expectedReturnYes = market.yesPrice > 0 ? aiProbability / market.yesPrice - 1 : null;
  const expectedReturnNo = market.noPrice > 0 ? (1 - aiProbability) / market.noPrice - 1 : null;
  const confidence = chooseConfidence(liquidityScore, spreadPenalty, signals.points, market.probability);
  const rating = chooseRating(expectedReturnYes, expectedReturnNo, confidence, market.probability);
  const topNews = relatedNewsForMarket(market, allNews).slice(0, 2);

  return {
    id: `${candidate.tabId}:${market.id}`,
    tabId: candidate.tabId,
    tabLabel: candidate.tabLabel,
    marketId: market.id,
    title: group.label || market.title,
    category: market.category,
    themeLabel: market.themeLabel,
    marketProbability: market.probability,
    aiProbability,
    yesMultiplier,
    noMultiplier,
    expectedReturnYes,
    expectedReturnNo,
    rating,
    confidence,
    reasons: [
      `現在の市場確率は${formatPercent(market.probability)}です。`,
      momentum === 0 ? "直近の価格推移は横ばいです。" : `直近の価格変化は${formatSignedPercent(momentum)}です。`,
      `出来高は${formatUsd(market.volume)}、流動性は${formatUsd(market.liquidity)}です。`,
    ],
    evidence: [
      `${signals.points}点の価格履歴を確認`,
      ...topNews.map((item) => `${item.source}: ${item.title}`),
    ].slice(0, 3),
    historySignals: signals,
    scoreBreakdown: {
      liquidity: roundScore(liquidityScore),
      momentum: roundScore(clamp((momentum + 0.2) / 0.4, 0, 1)),
      news: roundScore(newsScore),
      spreadPenalty: roundScore(spreadPenalty),
    },
    evaluatedAt: new Date().toISOString(),
    model: getDeepSeekModel(),
    status: "fallback",
  };
}

async function refineWithDeepSeek(
  baseline: MarketAiEvaluation[],
  candidates: Candidate[],
  newsItems: NewsItem[],
) {
  if (!process.env.DEEPSEEK_API_KEY || baseline.length === 0) return null;

  const compactPayload = baseline.map((item) => {
    const candidate = candidates.find((entry) => entry.market.id === item.marketId);
    return {
      marketId: item.marketId,
      tab: item.tabLabel,
      title: item.title,
      category: item.category,
      marketProbability: item.marketProbability,
      baselineAiProbability: item.aiProbability,
      yesPrice: candidate?.market.yesPrice,
      noPrice: candidate?.market.noPrice,
      volume: candidate?.market.volume,
      liquidity: candidate?.market.liquidity,
      spread: candidate?.market.spread,
      historySignals: item.historySignals,
      relatedNews: relatedNewsForMarket(candidate?.market ?? item, newsItems).slice(0, 4).map((news) => ({
        title: news.title,
        source: news.source,
        category: news.category,
        publishedAt: news.publishedAt,
        summary: news.summary,
      })),
    };
  });

  const response = await fetchWithTimeout(
    `${getDeepSeekBaseUrl()}/chat/completions`,
    {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: getDeepSeekModel(),
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "あなたは予測市場の保守的な評価エンジンです。売買推奨ではなく、公開市場データ、価格推移、出来高、関連ニュースだけで参考評価を返します。誇張せず、確率は市場価格から大きく外しすぎないでください。",
          },
          {
            role: "user",
            content: `以下の各カテゴリで最も注目度が高いPolymarketテーマについて、AI参考確率、評価、理由、根拠をJSONで返してください。返す形式は {"items":[{"marketId":"...","aiProbability":0.42,"rating":"YES寄り|NO寄り|様子見","confidence":"高|中|低","reasons":["..."],"evidence":["..."]}]} のみです。\n${JSON.stringify(compactPayload).slice(0, 14000)}`,
          },
        ],
      }),
    },
    20000,
  );

  if (!response.ok) return null;
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  return deepSeekEvaluationResponseSchema.parse(JSON.parse(content)).items;
}

function mergeEvaluations(
  baseline: MarketAiEvaluation[],
  refined: z.infer<typeof deepSeekEvaluationResponseSchema>["items"] | null,
) {
  if (!refined) return baseline;
  const refinedByMarket = new Map(refined.map((item) => [item.marketId, item]));
  return baseline.map((item) => {
    const update = refinedByMarket.get(item.marketId);
    if (!update) return item;
    const aiProbability = conservativeProbability(item.marketProbability, update.aiProbability);
    const expectedReturnYes = item.yesMultiplier ? aiProbability * item.yesMultiplier - 1 : item.expectedReturnYes;
    const expectedReturnNo = item.noMultiplier ? (1 - aiProbability) * item.noMultiplier - 1 : item.expectedReturnNo;
    const confidence = extremeProbability(item.marketProbability) ? "低" : update.confidence;
    return {
      ...item,
      aiProbability,
      expectedReturnYes,
      expectedReturnNo,
      rating: chooseRating(expectedReturnYes, expectedReturnNo, confidence, item.marketProbability),
      confidence,
      reasons: update.reasons.length ? update.reasons : item.reasons,
      evidence: update.evidence.length ? update.evidence : item.evidence,
      status: "live" as DataStatus,
      evaluatedAt: new Date().toISOString(),
    };
  });
}

function historySignals(market: MarketDetail) {
  const values = market.priceHistory.map((point) => point.value).filter(Number.isFinite);
  const first = values[0] ?? null;
  const latest = values[values.length - 1] ?? null;
  const high = values.length ? Math.max(...values) : null;
  const low = values.length ? Math.min(...values) : null;
  return {
    points: values.length,
    firstProbability: first,
    latestProbability: latest,
    change7d: first !== null && latest !== null ? latest - first : null,
    high7d: high,
    low7d: low,
  };
}

function relatedNewsForMarket(market: Pick<MarketSummary, "category" | "title" | "themeLabel">, items: NewsItem[]) {
  const marketText = [market.title, market.themeLabel, market.category].join(" ").toLowerCase();
  return items
    .map((item) => {
      const text = [item.title, item.summary, item.relatedMarket ?? "", item.category].join(" ").toLowerCase();
      let score = item.category === market.category ? 4 : 0;
      for (const token of importantTokens(text)) {
        if (marketText.includes(token)) score += 1;
      }
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

function importantTokens(text: string) {
  return Array.from(new Set(text.split(/[^a-z0-9ぁ-んァ-ヶ一-龠ー/]+/u)))
    .filter((token) => token.length >= 2)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !["ニュース", "市場", "日本", "関連", "速報", "について"].includes(token))
    .slice(0, 20);
}

function chooseRating(
  expectedReturnYes: number | null,
  expectedReturnNo: number | null,
  confidence: "高" | "中" | "低",
  marketProbability: number,
): MarketAiEvaluation["rating"] {
  if (confidence === "低" || marketProbability < 0.03 || marketProbability > 0.97) return "様子見";
  if ((expectedReturnYes ?? 0) > 0.18 && (expectedReturnYes ?? 0) > (expectedReturnNo ?? 0)) return "YES寄り";
  if ((expectedReturnNo ?? 0) > 0.18 && (expectedReturnNo ?? 0) > (expectedReturnYes ?? 0)) return "NO寄り";
  return "様子見";
}

function conservativeProbability(marketProbability: number, proposedProbability: number) {
  const maxMove = marketProbability < 0.01 || marketProbability > 0.99 ? 0.008 : marketProbability < 0.05 || marketProbability > 0.95 ? 0.015 : 0.08;
  return clamp(proposedProbability, Math.max(0.001, marketProbability - maxMove), Math.min(0.999, marketProbability + maxMove));
}

function chooseConfidence(liquidityScore: number, spreadPenalty: number, historyPoints: number, marketProbability: number): MarketAiEvaluation["confidence"] {
  if (extremeProbability(marketProbability)) return "低";
  if (liquidityScore > 0.72 && spreadPenalty < 0.12 && historyPoints >= 8) return "高";
  if (liquidityScore > 0.45 && spreadPenalty < 0.24 && historyPoints >= 4) return "中";
  return "低";
}

function extremeProbability(marketProbability: number) {
  return marketProbability < 0.03 || marketProbability > 0.97;
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function formatSignedPercent(value: number) {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function getDeepSeekBaseUrl() {
  return (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
}
