# Polymarket Watch

世界で注目されている Polymarket テーマと、日本に関係するテーマを見やすく整理するダッシュボードです。情報提供に特化しており、自動売買、注文送信、ウォレット接続、秘密鍵入力、署名処理は実装していません。

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- shadcn/ui style components
- Recharts
- Zod
- Prisma + SQLite
- Server-side source adapters
- DeepSeek AI concierge

## Data Sources

- Polymarket Gamma API
- Polymarket CLOB public read endpoints
- 国会会議録 API
- e-Gov パブリックコメント RSS
- 日本銀行 RSS
- Frankfurter USD/JPY
- DeepSeek API

API 調査メモは [docs/api-research.md](./docs/api-research.md) を参照してください。

## Local Setup

```sh
cp .env.example .env
npm install
npm run dev
```

Open:

```text
http://localhost:3000/onboarding
```

For remote demos where the viewer is not on your machine:

```sh
npm run dev:remote
```

Expose `http://localhost:3000` with an HTTPS tunnel such as Cloudflare Tunnel or ngrok, then create a shareable GitHub Pages link:

```sh
node scripts/demo-link.mjs https://your-tunnel-url.trycloudflare.com
```

Send the generated URL. It includes `?api=...`, so the GitHub Pages UI stores the tunnel URL and then reads markets, news, FX, and DeepSeek chat from your local server. The API key stays only in your `.env` on your machine.

## Validation

```sh
npm run lint
npm run typecheck
npm run build
```

## Environment Variables

```text
DATABASE_URL="file:./dev.db"
E_STAT_APP_ID=""
DEEPSEEK_API_KEY=""
DEEPSEEK_BASE_URL="https://api.deepseek.com"
DEEPSEEK_MODEL="deepseek-v4-flash"
```

`DEEPSEEK_MODEL` is configurable. The default is `deepseek-v4-flash`, based on the current DeepSeek official docs. The older `deepseek-chat` and `deepseek-reasoner` names are not used as defaults.

## DeepSeek AI Concierge

The app includes `Polymarket Concierge`, a read-only research assistant. It can explain Polymarket, summarize selected themes, organize official sources, explain price/probability, and draft a short executive-facing summary.

It cannot provide investment advice, order instructions, wallet connection guidance, secret-key handling, automatic trading, VPN bypass, or geographic restriction bypass.

## Important Hosting Note

The original repository target is:

```text
Runnnnnnnnnnnnnnnnn/poly
```

GitHub Pages is a static host and cannot run Next.js route handlers at runtime. This app currently uses server route handlers and server-side adapters so it can fetch live data safely without client-side direct API calls.

For GitHub Pages, `npm run build:pages` generates a static UI snapshot in `out/`. For real-time remote demos, keep the local Next.js API server running on your PC and connect Pages to it through an HTTPS tunnel using the `?api=` bridge described above.

## Compliance Notes

- This is not investment advice.
- No order placement endpoints are used.
- No wallet connection or signature flow is implemented.
- No VPN or geographic restriction bypass is implemented.
- API failures fall back to sample data and display natural Japanese status labels in the UI.

## Future Extensions

- Login
- Persistent watchlists
- Slack notifications
- Email notifications
- Admin screen
- Backtesting
- Static snapshot export for GitHub Pages

## Crypto prediction backtest API

The backend includes a read-only crypto prediction backtest. It treats Polymarket's YES price as the market-implied probability, stores live snapshots in SQLite, and evaluates resolved BTC/ETH/SOL/XRP markets with accuracy, Brier score, log loss, calibration, and a simple threshold strategy PnL. This is a measurement baseline, not a guarantee of future returns.

Initialize the database and start the app:

```sh
npm run db:push
npm run dev
```

Run a backtest:

```sh
curl -X POST http://localhost:3000/api/backtests \
  -H 'content-type: application/json' \
  -d '{"asset":"BTC","threshold":0.55,"initialCapital":1000,"limit":40}'
```

List runs with `GET /api/backtests`, inspect one with `GET /api/backtests/{id}`, and collect a live snapshot with `POST /api/backtests/collect`. For continuous local collection, run `npm run collect:crypto`; the default interval is five minutes and can be changed with `COLLECT_INTERVAL_MS`.

`GET /api/backtests/forecast?asset=BTC` also converts a common Polymarket threshold ladder into a market-implied median and p10/p25/p75/p90 price range. It is intentionally an implied range, not an independent price model; markets with different target dates are not mixed.

## Paper trading

実注文を出さないペーパートレード機能を追加しました。注文、約定、手数料、ポジション、満期決済、資産推移をDBに保存します。詳細な設計、仮定、公式仕様との対応は [docs/paper-trading.md](./docs/paper-trading.md) を参照してください。

```sh
npx prisma db push
npm run paper:backtest
ASSET=BTC npm run paper:trade
```

`paper:trade` は live paper run を作成して5分ごとに公開データを評価します。これは実注文ではありませんが、公開する場合はrun APIに認証を追加してください。

## 統合起動

画面とバックグラウンドworkerを一つのコマンドで起動できます。

```sh
npm run db:push
npm run dev:paper
```

ブラウザでは [http://localhost:3000/paper-trading](http://localhost:3000/paper-trading) を開いてください。トップURLの [http://localhost:3000](http://localhost:3000) も同じ統合画面へ移動します。`dev:paper` はNext.jsとpaper workerを同時起動し、`.paper-run-id` にlive run IDを保存して再起動時も同じrunを継続します。

本番ビルド後は以下です。

```sh
npm run build
npm run start:paper
```

For durable history, move `DATABASE_URL` from SQLite to a managed PostgreSQL database, run the collector as a scheduled worker, and keep raw API responses plus request timestamps in object storage or a warehouse. Do not rely on an in-process timer on serverless hosting because it may be stopped between requests. For public deployment, use a server-capable host such as Render, Fly.io, Railway, or a VPS, put the database and worker in the same deployment environment, add authentication/rate limiting to the backtest and collection routes, and expose only HTTPS. GitHub Pages can host the UI snapshot but cannot execute these runtime API routes.

Automatic trading is not part of the initial version.
