# Polymarket Watch

Polymarketの予測をシグナルに変換し、Hyperliquidの価格でバックテストと仮想売買を継続監視するダッシュボードです。実資金を使うメインネット注文は実装していません。任意のHyperliquidテストネット接続だけを、サーバー側の品質・損失制限の内側で利用できます。

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
- Hyperliquid public Info API
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

Send the generated URL. Public market, news, FX, and monitoring data use read-only GET routes. When AI access is configured, the URL fragment contains a viewer-only token that can call AI routes but cannot run backtests, stop workers, or submit testnet orders. `API_ACCESS_TOKEN` is never included in the shared URL.

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
API_ACCESS_TOKEN="generate-a-long-random-token"
VIEWER_ACCESS_TOKEN=""
HYPERLIQUID_TESTNET_ENABLED="0"
HYPERLIQUID_TESTNET_AUTO_MIRROR="0"
CLOUDFLARED_TUNNEL_TOKEN=""
CLOUDFLARED_PUBLIC_URL=""
POLYMARKET_ALERT_WEBHOOK_URL=""
```

`API_ACCESS_TOKEN` protects management and write routes. It is accepted from URL parameters only on localhost and must never be shared. Public data routes allow GET requests only. AI routes accept a separate viewer-only token; when `VIEWER_ACCESS_TOKEN` is empty, one is derived from `API_ACCESS_TOKEN` without exposing the admin token. The generated viewer token is placed after `#` and removed from the address bar after the browser stores it. If an older link containing `apiToken=` was shared, rotate `API_ACCESS_TOKEN` after deploying this version.

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

For GitHub Pages, `npm run build:pages` generates a static UI snapshot in `out/`. The macOS service publishes its verified tunnel URL and a recent public dashboard snapshot to the repository's `live` branch. While the tunnel remains healthy, material trade-state changes refresh that fallback snapshot after a five-minute minimum interval; timer-only and raw record-count changes do not create deployments. A `live` branch update redeploys those registry files onto the same GitHub Pages origin, so the UI does not depend on GitHub Raw's mutable-branch cache. During a new Quick Tunnel's DNS propagation, the recent live snapshot is shown instead of falling back immediately to an old build-time value. Service updates preserve a healthy tunnel unless tunnel code or configuration changed. A named Cloudflare Tunnel can be enabled with `CLOUDFLARED_TUNNEL_TOKEN` and `CLOUDFLARED_PUBLIC_URL`; without them, a checked Quick Tunnel is used and its rotating URL is republished automatically.

## Compliance Notes

- This is not investment advice.
- Mainnet order placement is disabled. Hyperliquid testnet orders remain disabled until the dedicated testnet credentials and both enable flags are configured.
- No wallet connection or signature flow is implemented.
- No VPN or geographic restriction bypass is implemented.
- API failures fall back to sample data and display natural Japanese status labels in the UI.

## Future Extensions

- Login
- Persistent watchlists
- Slack notifications
- Email notifications
- Admin screen
- Static snapshot export for GitHub Pages
- Five-second WebSocket capture of Polymarket Up/Down books, Hyperliquid books, and Chainlink/Binance references

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

List runs with `GET /api/backtests`, inspect one with `GET /api/backtests/{id}`, and collect a live snapshot with `POST /api/backtests/collect`. For continuous local collection, run `npm run collect:crypto`; the default interval is one minute and can be changed with `COLLECT_INTERVAL_MS`.

`GET /api/backtests/forecast?asset=BTC` also converts a common Polymarket threshold ladder into a market-implied median and p10/p25/p75/p90 price range. It is intentionally an implied range, not an independent price model; markets with different target dates are not mixed.

## Paper trading

実注文を出さないペーパートレード機能を追加しました。注文、約定、手数料、ポジション、満期決済、資産推移をDBに保存します。詳細な設計、仮定、公式仕様との対応は [docs/paper-trading.md](./docs/paper-trading.md) を参照してください。

```sh
npx prisma db push
npm run paper:backtest
ASSET=BTC npm run paper:trade
```

`paper:trade` は live paper run を作成して5分ごとに公開データを評価します。これは実注文ではありません。runtime APIは `API_ACCESS_TOKEN` で保護されます。

## Polymarket → Hyperliquid 組み合わせ検証

常駐workerは、終了6・12・24・48時間前のPolymarket価格帯を一つのテーマに束ね、暗黙の将来価格とHyperliquid現値の差からロング・ショート・見送りを判定します。仮想残高、手数料、スリッページ、資金調達コスト、最大下落、日次損失、注文判断をSQLiteへ保存します。

15分Up/Downの固定モデルは別の前向き実験として、直近終了時刻順に市場を開始前から発見し、PolymarketのUp/Down両板、Hyperliquid L2板、Binance・Chainlink参照価格を5秒単位で同期保存します。売買判断も保存済みの同一同期板だけから作り、公式決着と発注後のエントリー・終了用実板が揃った取引だけを完全監査へ含めます。Chainlinkの開始値・終了値から方向を再計算して正式決着とも照合し、50件到達後に純損益、最良対照との差、95%信頼区間、Deflated Sharpe、最大下落、決着整合の9条件を判定します。過去足やシャドー記録だけではテストネット・実取引へ昇格しません。

正式なバックテストは`ModelEvaluationRun`へ保存し、6時間ごとに自動実行します。各実行はID、データ・設定・コードの指紋、未使用期間の成績、6/12/24/48時間別結果を持ち、JSON/CSV/Markdown成果物として`~/.polymarket-watch/artifacts/model-evaluations/`にも保存します。画面は最新結果と履歴の参照に絞り、詳しい比較は任意のローカルMLflowへ取り込めます。運用手順は [docs/backtest-management.md](./docs/backtest-management.md) を参照してください。

現行の15分固定モデルも別系統で6時間ごとに過去72時間を再検証します。実運用と同じ1取引5%・同時3件までの配分、Polymarket方向のみの同時対照、15分枠単位の信頼区間で評価し、最新結果と24回分の履歴をダッシュボードへ表示します。履歴足による結果は一次選別に限定し、実取引の許可には前向き5秒板監査50枠が必要です。

Hyperliquid公式Python SDKをテストネット専用環境へ導入する場合:

```sh
python3 -m venv ~/.polymarket-watch/hyperliquid-venv
~/.polymarket-watch/hyperliquid-venv/bin/pip install -r requirements-hyperliquid.txt
```

テストネット連動には、`.env`の`HYPERLIQUID_ACCOUNT_ADDRESS`と専用APIウォレットの`HYPERLIQUID_API_WALLET_PRIVATE_KEY`を設定します。さらに`HYPERLIQUID_TESTNET_ENABLED=1`と`HYPERLIQUID_TESTNET_AUTO_MIRROR=1`が必要です。バックテストの品質判定が合格していない場合は、これらを設定しても新規注文は出ません。メインネット接続はコード上で無効です。

テストネットの模擬USDCを取得するには、[公式faucetの条件](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet)により、同じマスターアドレスでメインネット入金済みである必要があります。秘密鍵にはメインウォレットではなく、Hyperliquidで承認した[専用APIウォレット](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)だけを使用してください。現在のテストネット対象は`HYPERLIQUID_TESTNET_ASSETS=BTC,ETH,SOL`で、XRPはテストネットの取引ユニバースにないため送信しません。接続確認中は`HYPERLIQUID_TESTNET_AUTO_MIRROR=0`を維持します。

照合処理はCLOIDから注文状態を取得し、取引所注文ID、部分約定数量、平均約定価格、手数料、取消状態をDBへ保存します。25件ずつ未照合時間の古い順に巡回し、一時的な読取失敗は再接続します。DBと取引所の未約定注文をCLOIDまたは注文IDで突き合わせ、取引所だけにある孤立注文とDBだけに残った注文のどちらも異常として通知します。緊急停止時はモデルを先に停止し、専用テストネット口座に実在する全未約定注文を取り消したあと、全残存ポジションをreduce-only IOC注文で解消します。最後の再照合で注文または保有が1件でも残れば、停止完了として扱いません。

固定公開URLを使う場合は、CloudflareでNamed Tunnelを作成し、`http://127.0.0.1:3001`へ向けた公開ホスト名を登録してから、`.env`へ`CLOUDFLARED_TUNNEL_TOKEN`と`CLOUDFLARED_PUBLIC_URL`を設定します。外部ヘルスチェックが失敗した場合はQuick Tunnelへ自動退避します。

日次バックアップはSQLiteのオンラインバックアップを作成し、AES-256で暗号化したあと、同じ鍵で別ファイルへ復号して`PRAGMA integrity_check`が`ok`になることまで確認します。復元確認に失敗した世代は保存せず、確認記録の期限切れも異常として扱います。

常駐監視は、データ停止、パイプラインエラー、最大下落、正式決着との不一致、境界価格の欠測、緊急停止、バックアップ復元失敗、HyperliquidとDBの注文・ポジション不一致を検知します。Mac通知は既定で有効です。`POLYMARKET_ALERT_WEBHOOK_URL`へHTTPS Webhookを設定すると、同じ通知をリモートにも送信します。通知は新規・6時間ごとの再通知・復旧に分かれ、連投を抑制します。

## 統合起動

画面、Polymarket・Hyperliquidの5分間隔データ収集、6時間間隔の自動バックテスト、Polymarket単体の仮想運用、組み合わせ仮想売買、異常通知、暗号化バックアップを一つのコマンドで起動できます。二重起動はロックファイルで防止されます。

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

macOSへのログイン後もバックエンドを自動起動し、停止時に再起動する場合:

```sh
npm run build
npm run service:install
```

インストーラはGitHub Pages用の静的ビルドを常駐APIへ誤配備しないよう、APIルートを含む通常ビルドを作成・確認してからコピーします。

監視画面はPolymarketの保存件数、市場数、バックテスト観測数、予測誤差の前回比、仮想損益、各workerの最終成功時刻を表示します。HyperliquidのBTC/ETH/SOL/XRP/HYPEは相場環境の補助データとして保存し、モデル本体へ投入する前は「モデル入力候補」と明示します。

For durable history, move `DATABASE_URL` from SQLite to a managed PostgreSQL database, run the collector as a scheduled worker, and keep raw API responses plus request timestamps in object storage or a warehouse. Do not rely on an in-process timer on serverless hosting because it may be stopped between requests. For public deployment, use a server-capable host such as Render, Fly.io, Railway, or a VPS, put the database and worker in the same deployment environment, add authentication/rate limiting to the backtest and collection routes, and expose only HTTPS. GitHub Pages can host the UI snapshot but cannot execute these runtime API routes.

Mainnet automatic trading is not supported. Testnet mirroring is optional, capped, and qualification-gated.
