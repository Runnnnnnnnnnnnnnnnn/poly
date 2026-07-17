# ペーパートレード設計

## 目的

この機能は実注文を送信せず、Polymarket の公開市場データだけで仮想残高・仮想注文・仮想約定・ポジション・満期決済を再現する。

実注文 API、秘密鍵、署名、ウォレット接続は使用しない。Polymarket の CLOB は注文を署名して送信する仕組みなので、ペーパートレードは完全に別のDB内シミュレーションとして扱う。

## 公式仕様に合わせた仮定

- Gamma API: 市場の発見、タイトル、終了日、結果、token ID
- CLOB REST API: 板、best bid / ask、価格履歴
- CLOB Market WebSocket: 15分Up/Down市場のUp/Down両板を5秒ごとに同期保存する
- Polymarket RTDS: Binance・Chainlinkの参照価格を同じtickへ保存する
- Hyperliquid WebSocket: L2板、mark、oracle、fundingを同じtickへ保存する
- YES / NO の価格は0〜1の暗黙確率
- 表示される midpoint と、実際に買える ask / 売れる bid は異なる
- 現在のペーパー注文は FAK 相当の即時注文。板の ask を上から消費し、板が足りなければ部分約定として保存する
- 歴史データの板は通常取得できないため、履歴バックテストでは midpoint に合成スプレッドとスリッページを加える
- crypto taker fee の初期値は 0.07。市場の `feesEnabled` が false の場合は0として扱う
- 解決時は勝ちトークン1枚につき1ドル、負けトークンは0ドル

公式ドキュメント:

- [Prices & Orderbook](https://docs.polymarket.com/concepts/prices-orderbook)
- [Order types](https://docs.polymarket.com/trading/orders/overview)
- [Fees](https://docs.polymarket.com/trading/fees)
- [Resolution](https://docs.polymarket.com/concepts/resolution)
- [Market WebSocket](https://docs.polymarket.com/market-data/websocket/market-channel)

## 初期戦略: calibrated_consensus

市場価格をそのまま買うのではなく、過去に解決済みの市場の最終確率を10%刻みで集計する。

```text
fair = (過去同一ビンの勝利数 + prior × 現在確率)
       / (過去同一ビンの件数 + prior)
```

買い条件は次の通り。

```text
fair_probability - effective_buy_price - fee_per_share > entry_edge
```

履歴バックテストでは、観測時点より前に解決済みだった市場だけを訓練に使う。これにより、未来の解決結果を使う look-ahead bias を避ける。

初期実装では1市場につき最大1ポジションを持ち、満期まで保有する。複数回の売買、GTC / GTD の注文待ち、キャンセル、maker rebate は次の拡張対象である。

## DB

- `PaperAccount`: 仮想口座と仮想現金
- `PaperTradingRun`: 履歴バックテストまたは live paper run
- `PaperOrder`: 注文要求と注文状態
- `PaperFill`: 実際に仮想約定した数量、価格、手数料
- `PaperPosition`: YES / NO ポジションと決済損益
- `PaperEquitySnapshot`: キャッシュ、ポジション評価額、資産曲線
- `RealtimeMarketTick`: Up/Down両板、Hyperliquid板、Chainlink・Binance参照価格を5秒単位で同期した前向きデータ

本番では履歴データの取得時刻・API応答・データ品質も別途保存することを推奨する。現在の実装は正規化済みの市場、価格、約定を保存する。

## API

```text
GET  /api/paper-trading/accounts
POST /api/paper-trading/accounts

GET  /api/paper-trading/runs?accountId=...
POST /api/paper-trading/runs
GET  /api/paper-trading/runs/{id}
POST /api/paper-trading/runs/{id}       # live run を1 tick進める
PATCH /api/paper-trading/runs/{id}      # {"action":"stop"}
```

履歴ペーパーバックテスト:

```sh
MARKET_LIMIT=30 npm run paper:backtest
```

live paper run:

```sh
ASSET=BTC MARKET_LIMIT=20 npm run paper:trade
```

画面とworkerをまとめて起動する場合:

```sh
npm run dev:paper
```

画面は `http://localhost:3000/paper-trading` で確認できる。workerは `.paper-run-id` を使って同じlive runを再利用する。

本番では `npm run paper:trade` をWebサーバーのプロセス内タイマーにせず、常駐worker、cron、またはジョブ実行基盤から起動する。複数workerが同じrunをtickしないよう、将来はDBロックまたは分散ロックを加える。

## 検証上の注意

- 的中率だけでなく、Brier score、log loss、手数料後の損益、最大ドローダウンを確認する
- 同一市場の価格点を独立サンプルとして数えない。主指標は市場単位、補助指標は時系列単位にする
- 価格履歴の `fidelity`、取得時刻、満期日のタイムゾーンを固定する
- `closed` と `resolved` は同じではない。決済は最終結果とresolution sourceを確認して行う
- 市場ごとの手数料、tick size、minimum order size、neg riskを市場オブジェクトから読む
- 欠損、API障害、異常な板、薄い流動性、極端なスリッページは別ステータスとして記録する
- 収益の良いrunだけを採用せず、複数期間のwalk-forward検証と手数料・スリッページ感度分析を行う

## 公開運用

1. SQLiteからPostgreSQLへ移行する
2. Prisma schema の datasource provider を本番DBに合わせ、production用 migration を作成する
3. APIをHTTPSのサーバー環境に配置する
4. worker / scheduler を分離して live paper tick を実行する
5. account、run、tick APIに認証・権限・レート制限を付ける
6. 監査ログ、バックアップ、エラー通知、外部APIのレート制限を設定する
7. APIキーをコードやクライアントに含めず、環境変数またはsecret managerで管理する

GitHub Pages は静的ホスティングなので、これらのruntime APIやworkerは実行できない。UIだけをPagesに置く場合も、APIは別のサーバー環境で公開する。

## 組み合わせ仮想売買

`run-combined-shadow.mts`は、Polymarketの同一イベント内にある複数の価格しきい値を束ね、終了約24時間前の暗黙終値を推定する。その価格とHyperliquid現値の差を24時間実現ボラティリティで標準化し、基準を超えた場合だけロングまたはショートを仮想発注する。

- 初期仮想資金: $10,000
- 1取引: 資産の10%、最大$1,000
- 同時保有: 1件
- 日次損失上限: 2%
- 最大ドローダウン: 5%
- 手数料、スリッページ、資金調達コストを控除
- 同一イベントの再取引を禁止
- `COMBINED_KILL_SWITCH=1`で新規取引停止と保有決済

テストネット連動はHyperliquid公式Python SDKを使う。新規注文には、接続設定に加えて最新の未使用期間テストが`promising`、選定戦略が`no-trade guard`以外、95%信頼区間がプラスという全条件を要求する。1倍の分離証拠金、最大$25、dead-man's switchを使用する。メインネット注文経路は実装しない。
