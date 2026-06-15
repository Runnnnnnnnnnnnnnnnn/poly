import { z } from "zod";

import type { MarketCategory, MarketScope, MarketSummary } from "@/lib/types";

const titleTranslationSchema = z.object({
  translations: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1),
    }),
  ),
});

const titleTranslationCache = new Map<string, string>();
const titleTranslationSkipCache = new Set<string>();

export async function translateMarketTitles(markets: MarketSummary[]) {
  if (process.env.SKIP_TITLE_AI === "1" || !process.env.DEEPSEEK_API_KEY || markets.length === 0) return markets;

  const pending = markets
    .filter((market) => !titleTranslationCache.has(translationCacheKey(market)) && !titleTranslationSkipCache.has(translationCacheKey(market)))
    .slice(0, 30)
    .map((market) => ({
      id: market.id,
      title: market.originalTitle,
      currentJapaneseTitle: market.title,
      category: market.category,
      scope: market.scope === "global" ? "世界" : "日本",
    }));

  if (pending.length > 0) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
          response_format: { type: "json_object" },
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content:
                "Polymarketの市場タイトルを、上司向けダッシュボードに載せる自然な日本語タイトルへ翻訳してください。売買推奨や投資助言はしない。英語の原題は残さない。固有名詞は一般的な日本語表記にし、分からない固有名詞はカタカナまたは原語の短い固有名詞だけ残す。必ずJSONだけで返す。",
            },
            {
              role: "user",
              content: JSON.stringify({
                format: { translations: [{ id: "string", title: "自然な日本語タイトル" }] },
                rules: [
                  "疑問形の市場は日本語でも疑問形にする",
                  "タイトルは40文字以内を目安にする",
                  "「取引」「買う」「売る」は使わない",
                  "日付がある場合は日本語の日付にする",
                ],
                markets: pending,
              }),
            },
          ],
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        const parsed = titleTranslationSchema.parse(JSON.parse(extractJsonObject(String(content ?? "{}"))));
        for (const item of parsed.translations) {
          const market = markets.find((candidate) => candidate.id === item.id);
          const title = normalizeTranslatedTitle(item.title);
          if (market && !hasUntranslatedEnglish(title)) {
            titleTranslationCache.set(translationCacheKey(market), title);
          } else if (market) {
            titleTranslationSkipCache.add(translationCacheKey(market));
          }
        }
      }
    } catch {
      pending.forEach((market) => titleTranslationSkipCache.add(`${market.id}:${market.title}`));
    } finally {
      clearTimeout(timeout);
    }
  }

  return markets.map((market) => ({
    ...market,
    title: titleTranslationCache.get(translationCacheKey(market)) ?? market.title,
  }));
}

export function toJapaneseTitle(title: string, category: MarketCategory, scope: MarketScope) {
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(title)) return title;
  const normalized = title.replace(/\s+/g, " ").replace(/\?+$/, "").trim();
  const knownTitle = knownJapaneseTitle(normalized);
  if (knownTitle) return knownTitle;

  const dateMatch = normalized.match(/\bby ([A-Z][a-z]+ \d{1,2}, \d{4})$/);
  const dateText = dateMatch ? `${formatMarketDate(dateMatch[1])}までに` : "";
  const withoutDate = dateMatch ? normalized.replace(/\s+by [A-Z][a-z]+ \d{1,2}, \d{4}$/, "") : normalized;
  const phrase = translatePhrase(withoutDate)
    .replace(/^Will\s+/i, "")
    .replace(/^Who will win\s+/i, "")
    .replace(/^Which .* will win\s+/i, "")
    .trim()
    .replace(/\s+/g, " ");

  if (/^World Cup Winner/i.test(normalized)) return "2026年ワールドカップの優勝国は？";
  if (/^Who will win/i.test(normalized)) return `${translatePhrase(normalized.replace(/^Who will win\s+/i, ""))}の勝者は？`;
  if (/^Will /i.test(normalized)) return `${phrase}は${dateText}実現する？`;
  if (/price|above|below|cross/i.test(normalized)) return `${phrase}の価格水準は注目ラインを超える？`;
  if (/winner|win/i.test(normalized)) return `${phrase}の勝者は？`;

  const prefix = scope === "global" ? "世界で注目される" : "日本関連の";
  return `${prefix}${titleThemeLabel(category)}テーマ: ${phrase}`;
}

export function hasUntranslatedEnglish(value: string) {
  const allowed = /\b(AI|FRB|FOMC|NVIDIA|Tesla|S&P|NBA|NFL|FIFA|ETF|BTC|ETH|USD|JPY)\b/gi;
  return value.replace(allowed, "").split(/\s+/).some((part) => /[A-Za-z]{3,}/.test(part));
}

export function formatMarketDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function knownJapaneseTitle(title: string) {
  if (/US x Iran permanent peace deal/i.test(title)) return "米国とイランは恒久的な和平合意に至る？";
  if (/Iranian regime fall|regime fall.*Iran/i.test(title)) return "イランの政権は6月30日までに崩壊する？";

  const usIranDeal = title.match(/US announces new Iran agreement\/ceasefire extension by (.+)$/i);
  if (usIranDeal) return `米国は${translateShortDate(usIranDeal[1])}までにイランとの合意または停戦延長を発表する？`;

  const fedChange = title.match(/Fed (increase|decrease|cut)s? (?:interest )?rates by (\d+)(\+)? bps after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (fedChange) {
    const direction = fedChange[1].toLowerCase() === "increase" ? "利上げ" : "利下げ";
    return `FRBは${formatMeetingMonth(fedChange[4])}会合後に${fedChange[2]}bp${fedChange[3] ? "以上" : ""}の${direction}をする？`;
  }

  const fedNoChange = title.match(/(?:there be )?no change in Fed (?:interest )?rates after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (fedNoChange) return `FRBは${formatMeetingMonth(fedNoChange[1])}会合後に金利を据え置く？`;

  const recession = title.match(/Japan recession in (\d{4})/i);
  if (recession) return `日本は${recession[1]}年に景気後退入りする？`;

  const bojHike = title.match(/Bank of Japan increase(?:s)? (?:interest )?rates by (\d+)(\+)? bps after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (bojHike) return `日銀は${formatMeetingMonth(bojHike[3])}会合後に${bojHike[1]}bp${bojHike[2] ? "以上" : ""}の利上げをする？`;

  const bojNoChange = title.match(/(?:there be )?No change in Bank of Japan.?s (?:interest )?rates after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (bojNoChange) return `日銀は${formatMeetingMonth(bojNoChange[1])}会合後に金利を据え置く？`;

  const bojCut = title.match(/Bank of Japan (?:cuts|decreases?) (?:interest )?rates(?: by (\d+)(\+)? bps)? after (?:the )?([A-Za-z]+ \d{4}) meeting/i);
  if (bojCut) return `日銀は${formatMeetingMonth(bojCut[3])}会合後に${bojCut[1] ? `${bojCut[1]}bp${bojCut[2] ? "以上" : ""}の` : ""}利下げをする？`;

  const usdJpyHit = title.match(/Will USD\/JPY hit ([\d.]+) \((High|Low)\) in (\d{4})/i);
  if (usdJpyHit) return `USD/JPYは${usdJpyHit[3]}年に${usdJpyHit[1]}円まで${usdJpyHit[2].toLowerCase() === "high" ? "上昇" : "下落"}する？`;

  const usdJpyClose = title.match(/Will the close USD\/JPY price at the end of (\d{4}) be between ([\d.]+) and ([\d.]+)/i);
  if (usdJpyClose) return `${usdJpyClose[1]}年末のUSD/JPY終値は${usdJpyClose[2]}円から${usdJpyClose[3]}円の間になる？`;

  const nikkeiBetween = title.match(/Will the official close price for the Nikkei 225 on the final trading day of December (\d{4}) be between ([\d,]+) and ([\d,]+)/i);
  if (nikkeiBetween) return `${nikkeiBetween[1]}年12月最終取引日の日経平均終値は${nikkeiBetween[2]}円から${nikkeiBetween[3]}円の間になる？`;

  const nikkeiAtLeast = title.match(/Will the official close price for the Nikkei 225 on the final trading day of December (\d{4}) be at least ([\d,]+)/i);
  if (nikkeiAtLeast) return `${nikkeiAtLeast[1]}年12月最終取引日の日経平均終値は${nikkeiAtLeast[2]}円以上になる？`;

  const nikkeiLessThan = title.match(/Will the official close price for the Nikkei 225 on the final trading day of December (\d{4}) be less than ([\d,]+)/i);
  if (nikkeiLessThan) return `${nikkeiLessThan[1]}年12月最終取引日の日経平均終値は${nikkeiLessThan[2]}円未満になる？`;

  if (/Trump say "crypto" or "Bitcoin" during events with Xi Jinping/i.test(title)) {
    return "トランプ氏は習近平氏との会談で暗号資産に言及する？";
  }

  if (/Trump say "Japan" or "Korea" during events with Xi Jinping/i.test(title)) {
    return "トランプ氏は習近平氏との会談で日本または韓国に言及する？";
  }

  if (/Japan declassifies new UFO files in 2026/i.test(title)) {
    return "日本は2026年にUFO関連の新資料を公開する？";
  }

  const chinaJapanClash = title.match(/China x Japan military clash before (\d{4})/i);
  if (chinaJapanClash) return `中国と日本は${chinaJapanClash[1]}年までに軍事衝突する？`;

  const tennisMatch = title.match(/^(Roland Garros WTA|Madrid Open):\s*(.+?)\s+vs\s+(.+)$/i);
  if (tennisMatch) return `${translateEventName(tennisMatch[1])}: ${translatePerson(tennisMatch[2])}対${translatePerson(tennisMatch[3])}`;

  const worldCup = title.match(/Will ([A-Za-z .'-]+) win the 2026 FIFA World Cup/i);
  if (worldCup) return `${translateCountry(worldCup[1])}は2026年FIFAワールドカップで優勝する？`;

  const hormuz = title.match(/Strait of Hormuz traffic returns to normal by (.+)$/i);
  if (hormuz) return `ホルムズ海峡の船舶通行は${translateShortDate(hormuz[1])}までに正常化する？`;

  return null;
}

function normalizeTranslatedTitle(value: string) {
  return value
    .replace(/ベーシスポイント/g, "bp")
    .replace(/５０/g, "50")
    .replace(/２５/g, "25")
    .trim();
}

function translationCacheKey(market: MarketSummary) {
  return `${market.id}:${market.originalTitle}`;
}

function extractJsonObject(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) return "{}";
  return value.slice(start, end + 1);
}

function translatePhrase(value: string) {
  return Object.entries(translationGlossary)
    .reduce((text, [english, japanese]) => text.replace(glossaryRegExp(english), japanese), value)
    .replace(/\b(the|a|an)\b/gi, "")
    .replace(/\s+の\s+/g, "の")
    .replace(/\s+/g, " ")
    .trim();
}

function translateCountry(value: string) {
  return countryGlossary[value.trim()] ?? translatePhrase(value.trim());
}

function translateEventName(value: string) {
  const normalized = value.trim();
  const events: Record<string, string> = {
    "Roland Garros WTA": "全仏オープン女子",
    "Madrid Open": "マドリード・オープン",
  };
  return events[normalized] ?? translatePhrase(normalized);
}

function translatePerson(value: string) {
  const normalized = value.replace(/\?+$/, "").trim();
  const people: Record<string, string> = {
    "Aryna Sabalenka": "アリナ・サバレンカ",
    "Naomi Osaka": "大坂なおみ",
    "Iva Jovic": "イバ・ヨビッチ",
  };
  return people[normalized] ?? translatePhrase(normalized);
}

function translateShortDate(value: string) {
  const normalized = value.replace(/\?+$/, "").trim();
  if (/end of June/i.test(normalized)) return "6月末";
  const monthDay = normalized.match(/June (\d{1,2})/i);
  if (monthDay) return `6月${monthDay[1]}日`;
  return normalized;
}

function formatMeetingMonth(value: string) {
  const date = new Date(`${value} 1`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long" }).format(date);
}

function titleThemeLabel(category: MarketCategory) {
  const labels: Record<MarketCategory, string> = {
    政治: "政治・地政学",
    金融: "金融",
    規制: "規制",
    テック: "テック",
    イベント: "イベント",
    日銀: "日銀",
    為替: "為替",
    暗号資産: "暗号資産",
    選挙: "選挙",
  };
  return labels[category];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function glossaryRegExp(value: string) {
  const escaped = escapeRegExp(value);
  return /^[A-Za-z0-9 /'-]+$/.test(value) ? new RegExp(`\\b${escaped}\\b`, "gi") : new RegExp(escaped, "gi");
}

const translationGlossary: Record<string, string> = {
  "US x Iran": "米国とイランの",
  "United States": "米国",
  US: "米国",
  Iran: "イラン",
  China: "中国",
  Russia: "ロシア",
  Ukraine: "ウクライナ",
  Israel: "イスラエル",
  Japan: "日本",
  Japanese: "日本",
  "permanent peace deal": "恒久的な和平合意",
  "peace deal": "和平合意",
  ceasefire: "停戦",
  "World Cup Winner": "ワールドカップ優勝国",
  "World Cup": "ワールドカップ",
  "presidential election": "大統領選挙",
  election: "選挙",
  "rate cut": "利下げ",
  "cut interest rates": "利下げ",
  "cut rates": "利下げ",
  "rate hike": "利上げ",
  "interest rates": "金利",
  "Federal Reserve": "FRB",
  Fed: "FRB",
  "Bank of Japan": "日本銀行",
  BOJ: "日銀",
  Yen: "円",
  JPY: "円",
  Bitcoin: "ビットコイン",
  BTC: "ビットコイン",
  Ethereum: "イーサリアム",
  crypto: "暗号資産",
  "artificial intelligence": "AI",
  AI: "AI",
  Nvidia: "NVIDIA",
  Tesla: "テスラ",
  Trump: "トランプ",
  Biden: "バイデン",
  "S&P 500": "S&P 500",
  inflation: "インフレ",
  CPI: "消費者物価指数",
  oil: "原油",
  gold: "金",
  above: "上回る",
  below: "下回る",
  cross: "超える",
  by: "までに",
};

const countryGlossary: Record<string, string> = {
  Spain: "スペイン",
  Mexico: "メキシコ",
  Germany: "ドイツ",
  Turkiye: "トルコ",
  Turkey: "トルコ",
  Sweden: "スウェーデン",
  Austria: "オーストリア",
  Australia: "オーストラリア",
  Brazil: "ブラジル",
  Argentina: "アルゼンチン",
  France: "フランス",
  England: "イングランド",
  Portugal: "ポルトガル",
  "Congo DR": "コンゴ民主共和国",
  USA: "米国",
  "South Korea": "韓国",
  Japan: "日本",
};
