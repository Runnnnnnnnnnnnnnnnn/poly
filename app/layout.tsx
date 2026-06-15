import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Japan Market Watch",
  description: "日本関連の予測市場と一次情報を読むための社内デモ用ダッシュボード",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
