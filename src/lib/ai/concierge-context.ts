export const OPEN_CONCIERGE_EVENT = "open-concierge";

export const CONCIERGE_CONTEXT_KINDS = ["home", "markets", "market-detail", "tutorial", "news", "calculator"] as const;

export type ConciergeContextKind = (typeof CONCIERGE_CONTEXT_KINDS)[number];

export type ConciergeOpenContext = {
  kind?: ConciergeContextKind;
  marketId?: string;
  title?: string;
  subtitle?: string;
};

export function inferConciergeContextFromPath(pathname: string, override: ConciergeOpenContext = {}): ConciergeOpenContext {
  const base = contextFromPath(pathname);
  return {
    ...base,
    ...override,
    marketId: override.marketId ?? base.marketId,
    title: override.title ?? base.title,
  };
}

export function conciergeOpeningMessage(context: ConciergeOpenContext) {
  if (context.kind === "home") {
    return "Polymarket Watchの使い方、予測市場の基本、関連リンクの読み方を整理できます。まずは市場価格と倍率の見方から確認しましょう。";
  }
  if (context.kind === "markets") {
    return "テーマ一覧に合わせて、国内外の注目テーマ、タグ別の見方、出来高や流動性から見る優先順位を整理できます。";
  }
  if (context.kind === "market-detail") {
    return `「${context.title ?? "このテーマ"}」について、解決条件、確率、倍率、関連リンクを整理できます。`;
  }
  if (context.kind === "tutorial") {
    return "読み方ガイドの流れに沿って、最初に見るリンク、注意点、確認ポイントを整理できます。";
  }
  if (context.kind === "news") {
    return "公式情報やニュースを、市場価格とは分けて整理できます。出典と日付を確認しながら見ていきます。";
  }
  if (context.kind === "calculator") {
    return "収益計算の入力値や、価格・為替・手数料の読み方を確認できます。これは投資助言ではありません。";
  }
  return "Polymarket Watchについて、テーマの見方、関連情報、確率の読み方を分かりやすく整理します。";
}

export function conciergeSuggestedQuestions(context: ConciergeOpenContext) {
  if (context.kind === "home") {
    return [
      "Polymarketの基本を短く説明して",
      "このダッシュボードでは何を見るべき？",
      "市場価格と確率の関係を短く教えて",
      "日本テーマを見る順番を教えて",
    ];
  }
  if (context.kind === "markets") {
    return [
      "今日の注目テーマを分類して",
      "日本国内と国外の見方の違いを整理して",
      "出来高と流動性から優先順位を付けて",
      "1分で読める見どころを作って",
    ];
  }
  if (context.kind === "market-detail") {
    return [
      "このテーマを初心者向けに説明して",
      "解決条件を短く要約して",
      "価格が示す見方を教えて",
      "確認すべきリンクとニュースを整理して",
    ];
  }
  if (context.kind === "tutorial") {
    return [
      "初めての人に説明する順番を作って",
      "3分で話す要点にまとめて",
      "注意点だけ先に整理して",
      "市場を見るチェックリストを作って",
    ];
  }
  return [
    "Polymarketって何？",
    "42%という確率はどういう意味？",
    "関連ニュースを3行でまとめて",
    "これは投資助言ではない形で説明して",
  ];
}

export function conciergeInputPlaceholder(context: ConciergeOpenContext) {
  if (context.kind === "market-detail") return "このテーマについて質問";
  if (context.kind === "markets") return "テーマ一覧について質問";
  if (context.kind === "home") return "使い方や基本について質問";
  return "市場や確率について質問";
}

function contextFromPath(pathname: string): ConciergeOpenContext {
  const detailMatch = pathname.match(/^\/markets\/([^/]+)/);
  if (detailMatch) {
    return { kind: "market-detail", marketId: decodeURIComponent(detailMatch[1]) };
  }
  if (pathname.startsWith("/markets")) return { kind: "markets", title: "予測市場一覧" };
  if (pathname.startsWith("/onboarding") || pathname === "/") return { kind: "home", title: "Polymarket Watch" };
  if (pathname.startsWith("/tutorial")) return { kind: "tutorial", title: "読み方ガイド" };
  if (pathname.startsWith("/news")) return { kind: "news", title: "ニュース" };
  if (pathname.startsWith("/calculator")) return { kind: "calculator", title: "収益計算" };
  return {};
}
