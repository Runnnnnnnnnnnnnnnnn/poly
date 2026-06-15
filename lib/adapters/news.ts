import { z } from "zod";

import { fallbackNews } from "@/lib/sample-data";
import type { DataStatus, MarketCategory, NewsItem, SourceStatus } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/utils";

const kokkaiSchema = z
  .object({
    speechRecord: z
      .array(
        z
          .object({
            speechID: z.string(),
            nameOfHouse: z.string().nullable().optional(),
            nameOfMeeting: z.string().nullable().optional(),
            date: z.string().nullable().optional(),
            speaker: z.string().nullable().optional(),
            speech: z.string().nullable().optional(),
            speechURL: z.string().nullable().optional(),
            meetingURL: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export async function fetchNewsItems(): Promise<{
  items: NewsItem[];
  status: DataStatus;
  sourceStatuses: SourceStatus[];
}> {
  const sourceStatuses: SourceStatus[] = [];
  const settled = await Promise.allSettled([
    fetchKokkaiItems(),
    fetchRssItems("日本銀行", "https://www.boj.or.jp/rss/whatsnew.xml"),
    fetchRssItems("日本銀行統計", "https://www.boj.or.jp/rss/statistics.xml"),
    fetchRssItems("e-Gov", "https://public-comment.e-gov.go.jp/rss/pcm_list.xml"),
    fetchRssItems("Google News: Polymarket", "https://news.google.com/rss/search?q=Polymarket%20prediction%20market&hl=ja&gl=JP&ceid=JP:ja", "報道"),
    fetchRssItems("Google News: Japan markets", "https://news.google.com/rss/search?q=Japan%20markets%20yen%20Nikkei&hl=ja&gl=JP&ceid=JP:ja", "報道"),
    fetchRssItems("Google News: crypto regulation", "https://news.google.com/rss/search?q=crypto%20regulation%20Japan&hl=ja&gl=JP&ceid=JP:ja", "報道"),
  ]);

  const items = settled.flatMap((result, index) => {
    const source = ["国会会議録", "日本銀行", "日本銀行統計", "e-Gov", "Google News: Polymarket", "Google News: Japan markets", "Google News: crypto regulation"][index];
    if (result.status === "fulfilled") {
      sourceStatuses.push({
        source,
        status: result.value.length > 0 ? "live" : "fallback",
        message: `${result.value.length} items`,
      });
      return result.value;
    }

    sourceStatuses.push({
      source,
      status: "error",
      message: result.reason instanceof Error ? result.reason.message : "unknown error",
    });
    return [];
  });

  const normalized = dedupeNews(items)
    .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime())
    .slice(0, 48);

  if (normalized.length === 0) {
    return { items: fallbackNews, status: "fallback", sourceStatuses };
  }

  return { items: normalized, status: "live", sourceStatuses };
}

async function fetchKokkaiItems(): Promise<NewsItem[]> {
  const queries = ["日銀", "暗号資産", "金融庁", "予測市場", "為替", "半導体", "選挙"];
  const responses = await Promise.allSettled(
    queries.map(async (query) => {
      const url = new URL("https://kokkai.ndl.go.jp/api/speech");
      url.searchParams.set("any", query);
      url.searchParams.set("maximumRecords", "4");
      url.searchParams.set("recordPacking", "json");
      const response = await fetchWithTimeout(url.toString(), {}, 9000);
      if (!response.ok) throw new Error(`Kokkai ${response.status}`);
      return kokkaiSchema.parse(await response.json()).speechRecord ?? [];
    }),
  );

  return responses.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    return result.value.map((record) => {
      const title = `${record.nameOfHouse ?? "国会"} ${record.nameOfMeeting ?? ""} ${record.speaker ?? ""}`.trim();
      const speech = record.speech ?? "";
      const category = categorizeNews(`${title} ${speech}`);
      return {
        id: `kokkai-${record.speechID}`,
        title,
        source: "国会会議録",
        publishedAt: record.date ? `${record.date}T00:00:00.000Z` : null,
        url: record.speechURL ?? record.meetingURL ?? "https://kokkai.ndl.go.jp/",
        category,
        relatedMarket: relatedMarketLabel(category),
        summary: summarize(speech),
        kind: "公式情報" as const,
        status: "live" as const,
      };
    });
  });
}

async function fetchRssItems(source: string, url: string, kind: "公式情報" | "報道" = "公式情報"): Promise<NewsItem[]> {
  const response = await fetchWithTimeout(url, {}, 9000);
  if (!response.ok) throw new Error(`${source} RSS ${response.status}`);
  const xml = await response.text();
  return parseRss(xml, source, kind).slice(0, 8);
}

function parseRss(xml: string, source: string, kind: "公式情報" | "報道"): NewsItem[] {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return itemMatches.map((match, index) => {
    const itemXml = match[1];
    const title = decodeXml(readTag(itemXml, "title") || "Untitled");
    const url = decodeXml(readTag(itemXml, "link") || "");
    const publishedAt = parseRssDate(readTag(itemXml, "pubDate") || readTag(itemXml, "dc:date"));
    const description = decodeXml(readTag(itemXml, "description") || "");
    const category = categorizeNews(`${title} ${description}`);
    return {
      id: `${source}-${index}-${title}`.replace(/\s+/g, "-").slice(0, 120),
      title,
      source,
      publishedAt,
      url: url || sourceUrl(source),
      category,
      relatedMarket: relatedMarketLabel(category),
      summary: summarize(description || title),
      kind,
      status: "live",
    };
  });
}

function readTag(xml: string, tag: string) {
  const escaped = tag.replace(":", "\\:");
  const match = xml.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`));
  return match?.[1]?.trim() ?? null;
}

function parseRssDate(value: string | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function summarize(value: string) {
  const text = decodeXml(value).replace(/\s+/g, " ").trim();
  if (!text) return "公式ソースから取得した項目です。関連市場の一次情報として確認します。";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function categorizeNews(text: string): MarketCategory | "政策" {
  if (/日銀|金融政策|金利|物価|Bank of Japan|BOJ/i.test(text)) return "日銀";
  if (/為替|円|外為|USD\/JPY|JPY|Yen/i.test(text)) return "為替";
  if (/暗号資産|ステーブルコイン|金融庁|税制|規制|法令|パブリックコメント/i.test(text)) return "規制";
  if (/選挙|内閣|首相|国会|参院|衆院/i.test(text)) return "政治";
  if (/デジタル|AI|半導体|通信|サイバー/i.test(text)) return "テック";
  if (/Polymarket|prediction market|market|Nikkei|株|市場/i.test(text)) return "金融";
  return "政策";
}

function relatedMarketLabel(category: MarketCategory | "政策") {
  const labels: Record<MarketCategory | "政策", string> = {
    政治: "日本政治関連市場",
    金融: "日本金融関連市場",
    規制: "日本規制関連市場",
    テック: "日本テック関連市場",
    イベント: "日本イベント関連市場",
    日銀: "日銀関連市場",
    為替: "円・為替関連市場",
    暗号資産: "暗号資産関連市場",
    選挙: "日本選挙関連市場",
    政策: "政策関連市場",
  };
  return labels[category];
}

function sourceUrl(source: string) {
  if (source.includes("日本銀行")) return "https://www.boj.or.jp/";
  if (source === "e-Gov") return "https://public-comment.e-gov.go.jp/pcm/list";
  return "https://kokkai.ndl.go.jp/";
}

function dedupeNews(items: NewsItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
