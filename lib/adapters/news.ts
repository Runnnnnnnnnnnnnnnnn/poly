import { fallbackNews } from "@/lib/sample-data";
import type { DataStatus, MarketCategory, NewsItem, SourceStatus } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/utils";

type RssFeedConfig = {
  source: string;
  url: string;
  kind: "公式情報" | "報道";
  category?: MarketCategory | "政策";
  relatedMarket?: string;
  limit?: number;
};

const TREND_FEEDS: RssFeedConfig[] = [
  googleNewsFeed("日経: 為替・日銀", "site:nikkei.com 円 為替 日銀 when:7d", "為替", "USD/JPYの水準・レンジ"),
  googleNewsFeed("日経: 日本株・半導体", "site:nikkei.com 日経平均 日本株 半導体 AI when:7d", "金融", "日経平均・日本株指数"),
  googleNewsFeed("Reuters: Japan markets", "site:reuters.com Japan yen BOJ Nikkei when:7d", "為替", "USD/JPYの水準・レンジ"),
  googleNewsFeed("Bloomberg: Japan markets", "site:bloomberg.co.jp 日銀 円 日本株 when:7d", "金融", "日経平均・日本株指数"),
  googleNewsFeed("Polymarket / prediction markets", "Polymarket 予測市場 Bloomberg Reuters CoinDesk when:30d", "金融", "Polymarket"),
  googleNewsFeed("暗号資産規制", "暗号資産 規制 日本 金融庁 CoinDesk Cointelegraph when:14d", "規制", "日本の暗号資産規制"),
  googleNewsFeed("AI・半導体", "AI 半導体 NVIDIA OpenAI 日本 日経 Reuters when:7d", "テック", "AI・半導体テーマ"),
  googleNewsFeed("政治・選挙", "日本 選挙 首相 内閣 NHK Reuters when:14d", "政治", "日本の選挙・政局"),
  googleNewsFeed("スポーツ", "2026 FIFA ワールドカップ 日本 Reuters when:30d", "イベント", "2026年FIFAワールドカップ"),
  {
    source: "日本銀行",
    url: "https://www.boj.or.jp/rss/whatsnew.xml",
    kind: "公式情報",
    category: "日銀",
    relatedMarket: "日銀の金融政策",
    limit: 5,
  },
  {
    source: "日本銀行統計",
    url: "https://www.boj.or.jp/rss/statistics.xml",
    kind: "公式情報",
    category: "為替",
    relatedMarket: "USD/JPYの水準・レンジ",
    limit: 5,
  },
];

function googleNewsFeed(
  source: string,
  query: string,
  category: MarketCategory | "政策",
  relatedMarket: string,
  limit = 8,
): RssFeedConfig {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "ja");
  url.searchParams.set("gl", "JP");
  url.searchParams.set("ceid", "JP:ja");
  return {
    source,
    url: url.toString(),
    kind: "報道",
    category,
    relatedMarket,
    limit,
  };
}

export async function fetchNewsItems(): Promise<{
  items: NewsItem[];
  status: DataStatus;
  sourceStatuses: SourceStatus[];
}> {
  const sourceStatuses: SourceStatus[] = [];
  const settled = await Promise.allSettled(TREND_FEEDS.map((feed) => fetchRssItems(feed)));

  const items = settled.flatMap((result, index) => {
    const source = TREND_FEEDS[index].source;
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
    .filter(isUsefulNewsItem)
    .sort((a, b) => newsSortScore(b) - newsSortScore(a))
    .slice(0, 48);

  if (normalized.length === 0) {
    return { items: fallbackNews, status: "fallback", sourceStatuses };
  }

  return { items: normalized, status: "live", sourceStatuses };
}

async function fetchRssItems(config: RssFeedConfig): Promise<NewsItem[]> {
  const response = await fetchWithTimeout(config.url, { cache: "no-store" }, 9000);
  if (!response.ok) throw new Error(`${config.source} RSS ${response.status}`);
  const xml = await response.text();
  return parseRss(xml, config).slice(0, config.limit ?? 8);
}

function parseRss(xml: string, config: RssFeedConfig): NewsItem[] {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return itemMatches.map((match, index) => {
    const itemXml = match[1];
    const rawTitle = decodeXml(readTag(itemXml, "title") || "Untitled");
    const titleParts = splitGoogleNewsTitle(rawTitle, config.source);
    const url = decodeXml(readTag(itemXml, "link") || "");
    const publishedAt = parseRssDate(readTag(itemXml, "pubDate") || readTag(itemXml, "dc:date"));
    const description = decodeXml(readTag(itemXml, "description") || "");
    const title = titleParts.title;
    const source = titleParts.publisher || config.source;
    const category = config.category ?? categorizeNews(`${title} ${description}`);
    return {
      id: `${source}-${index}-${title}`.replace(/\s+/g, "-").slice(0, 120),
      title,
      source,
      publishedAt,
      url: url || sourceUrl(source),
      category,
      relatedMarket: config.relatedMarket ?? relatedMarketLabel(category),
      summary: summarize(description || title),
      kind: config.kind,
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

function splitGoogleNewsTitle(rawTitle: string, fallbackSource: string) {
  const parts = rawTitle.split(" - ");
  if (parts.length < 2) return { title: rawTitle, publisher: fallbackSource };
  const publisher = parts[parts.length - 1]?.trim() || null;
  return {
    title: parts.slice(0, -1).join(" - ").trim() || rawTitle,
    publisher,
  };
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
  if (source.includes("Reuters")) return "https://jp.reuters.com/";
  if (source.includes("Bloomberg")) return "https://www.bloomberg.co.jp/";
  if (source.includes("日本経済新聞") || source.includes("日経")) return "https://www.nikkei.com/";
  if (source.includes("CoinDesk")) return "https://www.coindeskjapan.com/";
  return "https://news.google.com/";
}

function dedupeNews(items: NewsItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalizeNewsKey(item.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeNewsKey(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").replace(/[|｜].+$/u, "").trim();
}

function isUsefulNewsItem(item: NewsItem) {
  if (item.title.length < 6) return false;
  if (/Google News|ヘルプ|Google ニュース/i.test(item.title)) return false;
  if (item.source.toLowerCase() === "polymarket") return false;
  if (/国会会議録|e-Gov|パブリックコメント/.test(item.source)) return false;
  return true;
}

function newsSortScore(item: NewsItem) {
  const publishedAt = new Date(item.publishedAt ?? 0).getTime();
  return publishedAt + sourcePriority(item) * 1000 * 60 * 60 * 6;
}

function sourcePriority(item: NewsItem) {
  if (/日本経済新聞|日経/.test(item.source)) return 5;
  if (/Reuters|ロイター|Bloomberg|ブルームバーグ/.test(item.source)) return 4;
  if (/CoinDesk|Cointelegraph|コイン/.test(item.source)) return 3;
  if (item.kind === "報道") return 2;
  return 1;
}
