export type ReferenceLink = {
  title: string;
  source: string;
  url: string;
  kind: "公式" | "解説" | "法規制" | "市場規模" | "論考";
  note: string;
};

export const officialPolymarketLinks: ReferenceLink[] = [
  {
    title: "Polymarket 日本語公式ページ",
    source: "Polymarket",
    url: "https://polymarket.com/ja",
    kind: "公式",
    note: "実際の市場ページ、カテゴリ、イベントごとの価格表示を確認できます。",
  },
  {
    title: "Polymarket US Documentation",
    source: "Polymarket US",
    url: "https://docs.polymarket.us/getting-started/welcome",
    kind: "公式",
    note: "市場、注文、ポジションなどの基本概念を公式ドキュメントで確認できます。",
  },
];

export const polymarketReferenceLinks: ReferenceLink[] = [
  {
    title: "Polymarket(ポリマーケット)とは？将来性や注意点、リスクを徹底解説！",
    source: "CRYPTO INSIGHT powered by ダイヤモンド・ザイ",
    url: "https://diamond.jp/crypto/defi/polymarket/",
    kind: "解説",
    note: "予測市場の仕組み、USDCを使う点、国内利用時の法的注意点を整理しています。",
  },
  {
    title: "Polymarketは「賭博」か「未来予測インフラ」か",
    source: "So & Sato",
    url: "https://innovationlaw.jp/prediction-market-japan-law/",
    kind: "法規制",
    note: "日本法上の賭博罪、金融商品、情報インフラとしての位置づけを弁護士目線で整理しています。",
  },
  {
    title: "予測市場Polymarketの成長と日本市場への示唆",
    source: "Coincheck Onchain Report",
    url: "https://coincheck.com/ja/article/684",
    kind: "市場規模",
    note: "オンチェーンデータを使い、月間取引高、アクティブユーザー、成長フェーズをまとめています。",
  },
  {
    title: "Polymarketは2030年までに日本での予測市場の承認を目指す",
    source: "CoinDesk JAPAN",
    url: "https://www.coindesk.com/ja/policy/2026/05/22/polymarket-aims-for-prediction-market-approval-in-japan-by-2030",
    kind: "法規制",
    note: "日本での許認可を目指す動きと、国内の賭博規制の厳しさを報じています。",
  },
  {
    title: "日本の予測市場が取るべき「ランキング勝負」の戦略案",
    source: "HashHub Research",
    url: "https://hashhub-research.com/articles/2026-04-06-japan-prediction-market-ranking-strategy",
    kind: "論考",
    note: "日本で予測市場を扱う場合、金銭参加よりも競技・ランキング化が現実的ではないかという論点を提示しています。",
  },
  {
    title: "予測市場がグローバル金融の新たなフロンティアに",
    source: "Yahoo!ファイナンス / NADA NEWS",
    url: "https://finance.yahoo.co.jp/news/detail/3d0cba6cd9871fef3e716cd0df4ba4dacde3a2da",
    kind: "市場規模",
    note: "予測市場全体の月間取引高や、各国の規制整備の動きを市場規模の文脈で紹介しています。",
  },
];

export const marketScaleNotes = [
  "Coincheck Onchain Reportは、2026年3月のPolymarket月間取引高を約95億ドル、月間アクティブユーザーを約78万ウォレットと整理しています。",
  "Yahoo!ファイナンス掲載のNADA NEWS記事は、予測市場全体の月間取引高が2026年4月に約298億ドル規模だったと伝えています。",
];
