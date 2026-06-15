import Link from "next/link";
import type React from "react";
import { BookOpen, HelpCircle, Newspaper, Search } from "lucide-react";

import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";
import { ConciergeDrawer } from "@/src/components/ai/ConciergeDrawer";

const navItems = [
  { href: "/onboarding", label: "Polymarketとは", icon: BookOpen },
  { href: "/markets", label: "予測市場一覧", icon: Search },
  { href: "/news", label: "ニュース", icon: Newspaper },
  { href: "/tutorial", label: "読み方ガイド", icon: HelpCircle },
];

export function AppShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <Link href="/markets" className="flex items-center gap-3">
            <BrandLogo />
          </Link>
          <nav className="grid grid-cols-2 gap-2 md:flex md:flex-wrap" aria-label="メインナビゲーション">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-md border border-border bg-white px-3 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-accent-foreground md:border-transparent md:bg-transparent"
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
          <span>本サービスは情報提供を目的としたダッシュボードです。投資助言、自動売買、注文送信、ウォレット接続は行いません。</span>
          <span>Polymarket Watch</span>
        </div>
      </footer>
      <ConciergeDrawer />
    </div>
  );
}
