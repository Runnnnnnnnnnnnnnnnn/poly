# API Research

調査日: 2026-06-15

## Polymarket

- 公式ドキュメントでは API は主に Gamma API、Data API、CLOB API に分かれる。
- Gamma API: `https://gamma-api.polymarket.com`。市場、イベント、タグ、シリーズ、検索などの discovery に使う。公開 API。
- Data API: `https://data-api.polymarket.com`。ポジション、取引、activity、holder、open interest など。公開 API だが、この初期版ではユーザー/ウォレット系は使わない。
- CLOB API: `https://clob.polymarket.com`。`/book`、`/spread`、`/prices-history` などの読み取り endpoint のみ使う。注文作成、注文取消、署名、API key 発行は実装しない。
- 価格は `outcomes` と `outcomePrices` が対応し、YES価格を確率として扱える。
- Geographic Restrictions では JP が frontend UI restricted と明記されている。地理制限回避、VPN回避、注文送信は扱わない。

採用:

- 市場検索: `GET https://gamma-api.polymarket.com/public-search?q={keyword}&limit={n}`
- 市場詳細: `GET https://gamma-api.polymarket.com/markets/{id}`
- スプレッド: `GET https://clob.polymarket.com/spread?token_id={yesTokenId}`
- 板情報: `GET https://clob.polymarket.com/book?token_id={yesTokenId}`
- 価格履歴: `GET https://clob.polymarket.com/prices-history?market={yesTokenId}&interval=1w&fidelity=60`

## 日本の一次情報

- 国会会議録 API: `https://kokkai.ndl.go.jp/api/speech?...&recordPacking=json`
  - JSON で取得可能。最大件数制限あり。短時間の大量アクセスを避ける。
- e-Gov パブリックコメント:
  - 一覧: `https://public-comment.e-gov.go.jp/pcm/list`
  - RSS: `https://public-comment.e-gov.go.jp/rss/pcm_list.xml`
- e-Gov 法令 API v2:
  - Swagger / Redoc は公開されているが、初期版では adapter 境界のみ用意し、無理に画面へ混ぜない。
- e-Stat API:
  - 利用にはユーザー登録/appId が必要。`E_STAT_APP_ID` 未設定時は無効化する。
- 日本銀行:
  - RSSページから `https://www.boj.or.jp/rss/whatsnew.xml` と `https://www.boj.or.jp/rss/statistics.xml` を確認。
- 為替:
  - Frankfurter v2 は `https://api.frankfurter.dev` で API key 不要。
  - USD/JPY は `GET https://api.frankfurter.dev/v2/rate/USD/JPY` を使う。

## 実装方針

- 外部 API 取得は `lib/adapters/*` と Next.js route handler に閉じ込める。
- 画面側は直接外部 API を叩かない。
- 失敗時は `lib/sample-data.ts` の fallback を返し、画面に `Live`、`Fallback`、`取得失敗` を表示する。
- 取引、注文、ウォレット接続、秘密鍵入力、署名、地理制限回避は実装対象外。
- GitHub Pages は runtime server route を実行できない。GitHub Pages で公開する場合は静的 export 用のデータ生成に切り替える必要がある。

## DeepSeek

- 公式 Quick Start では OpenAI/Anthropic 互換 API として利用できる。
- OpenAI互換の base URL は `https://api.deepseek.com`。
- 2026-06-15時点のモデル一覧は `deepseek-v4-flash` と `deepseek-v4-pro`。
- `deepseek-chat` と `deepseek-reasoner` は 2026-07-24 15:59 UTC に非推奨予定。互換名として `deepseek-v4-flash` の非thinking/thinking mode に対応する。
- Tool Calls と JSON Output は `deepseek-v4-flash` / `deepseek-v4-pro` ともに対応。

採用:

- Base URL: `DEEPSEEK_BASE_URL=https://api.deepseek.com`
- Default model: `DEEPSEEK_MODEL=deepseek-v4-flash`
- Chat endpoint: `POST /chat/completions`
- API key はサーバー側環境変数 `DEEPSEEK_API_KEY` のみで扱い、クライアントへ返さない。
- モデルへRaw HTMLや長文本文を渡さず、Source Card / Market Brief に圧縮して渡す。
- AI回答にはガードレールをかけ、投資助言、注文、ウォレット、秘密鍵、VPN/地理制限回避の案内を拒否する。
