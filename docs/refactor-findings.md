# Refactor Findings

2026-06-15 のリファクタリング中に確認した問題と改善状況です。

## 対応済み

- `lib/adapters/polymarket.ts` に取得、正規化、分類、日本語タイトル変換、表示補助が集まりすぎていた。
  - 対応: 日本語タイトル変換を `lib/adapters/polymarket/titles.ts`、分類・重複排除・テーマ表示補助を `lib/adapters/polymarket/market-utils.ts` に分離。
- 市場取得関数名が `fetchJapanMarkets` のままで、世界テーマも扱う現在の役割とずれていた。
  - 対応: 新しい主APIを `fetchMarkets` に変更し、既存参照向けに `fetchJapanMarkets` エイリアスを残した。
- グローバル市場の詳細取得に失敗した場合、フォールバックが日本テーマだけから選ばれていた。
  - 対応: `fallbackGlobalMarkets` と `fallbackMarkets` の両方から詳細フォールバックを選ぶようにした。
- AIツールとシステムプロンプトに「日本関連」だけを前提にした説明が残っていた。
  - 対応: 世界テーマと日本関連テーマの両方を扱う説明に更新。
- GitHub Actions に Node.js 20 非推奨警告が出ていた。
  - 対応: CI と Pages の Node.js を 24 に更新し、Action runtime も Node 24 を使う環境変数を追加。
- `build:pages` と開発サーバーを同時に動かすと、静的ビルド用の一時退避と `.next` が混ざり、ローカル表示が不安定になることがあった。
  - 対応: ローカルで 3000 番のサーバーが動いている場合は `build:pages` を止めるガードを追加。

## 継続改善候補

- Polymarket API のスキーマ定義はまだ取得アダプタ内に残っている。
  - 次の候補: `schemas.ts` に分離すると、外部API変更時の確認箇所がさらに明確になる。
- 日本語タイトルの定型パターンは追加しやすくなったが、まだ単一ファイル内の配列/関数で管理している。
  - 次の候補: パターンをテーブル化し、入力例と期待タイトルのテストを追加する。
- `build:pages` は静的エクスポート向けに一時的にAPI/middlewareを退避する。
  - 次の候補: 長期的には静的ビルド専用の構成を分離し、一時退避そのものをなくす。
