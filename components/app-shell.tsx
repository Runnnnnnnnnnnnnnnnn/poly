import Link from "next/link";
import type React from "react";
import { BarChart3, BookOpen, Calculator, Newspaper, Search } from "lucide-react";

import { LocalApiStatus } from "@/components/local-api-status";
import { cn } from "@/lib/utils";
import { ConciergeDrawer } from "@/src/components/ai/ConciergeDrawer";

const navItems = [
  { href: "/onboarding", label: "概要", icon: BookOpen },
  { href: "/markets", label: "市場一覧", icon: Search },
  { href: "/news", label: "公式情報", icon: Newspaper },
  { href: "/calculator", label: "収益計算", icon: Calculator },
  { href: "/tutorial", label: "チュートリアル", icon: BarChart3 },
];

export function AppShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <Link href="/markets" className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              JM
            </span>
            <span>
              <span className="block text-base font-bold leading-tight">Japan Market Watch</span>
              <span className="block text-xs text-muted-foreground">Read-only prediction market research</span>
            </span>
          </Link>
          <nav className="flex flex-wrap gap-1" aria-label="メインナビゲーション">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className={cn("mx-auto max-w-7xl px-5 py-8 md:py-10", className)}>{children}</main>
      <footer className="border-t border-border bg-white">
        <div className="mx-auto grid max-w-7xl gap-2 px-5 py-6 text-sm text-muted-foreground md:flex md:items-center md:justify-between">
          <span>本サービスは投資助言ではありません。自動売買機能はありません。注文送信、ウォレット署名は実装していません。</span>
          <span>Data: Polymarket, 国会会議録, e-Gov, 日本銀行, Frankfurter</span>
        </div>
      </footer>
      <LocalApiStatus />
      <ConciergeDrawer />
    </div>
  );
}
