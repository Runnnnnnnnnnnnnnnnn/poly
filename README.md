# Japan Market Watch

日本関連の Polymarket 予測市場と、日本語の一次情報を並べて確認する社内デモ用ダッシュボードです。読み取り専用で、自動売買、注文送信、ウォレット接続、秘密鍵入力、署名処理は実装していません。

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

The app includes `Japan Market Concierge`, a read-only research assistant. It can explain Polymarket, summarize selected markets, organize official sources, explain price/probability, and draft a short boss-facing summary.

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
- API failures fall back to sample data and display `Live`, `Fallback`, or `取得失敗` in the UI.

## Future Extensions

- Login
- Persistent watchlists
- Slack notifications
- Email notifications
- Admin screen
- Backtesting
- Static snapshot export for GitHub Pages

Automatic trading is not part of the initial version.
