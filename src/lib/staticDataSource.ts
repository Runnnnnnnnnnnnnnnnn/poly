"use client";

// 公開（静的エクスポート）版でも市場データをライブ表示するためのクライアント側データ取得。
// Polymarket の公開API（Gamma / CLOB）と Frankfurter は CORS 許可(*)のため、
// ブラウザから直接取得できる。サーバー用アダプタはNode専用依存・秘密鍵依存が無く、
// 鍵が未設定なら日本語タイトル変換も自動スキップされるため、そのまま再利用する。
import { fetchMarkets } from "@/lib/adapters/polymarket";
import { fetchUsdJpy } from "@/lib/adapters/rates";
import type { MarketsResponse, RateResponse } from "@/lib/types";

export async function loadMarketsClient(): Promise<MarketsResponse> {
  const result = await fetchMarkets();
  return { ...result, updatedAt: new Date().toISOString() };
}

export async function loadUsdJpyClient(): Promise<RateResponse> {
  return fetchUsdJpy();
}
