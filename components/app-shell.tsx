import Link from "next/link";
import type React from "react";
import { BarChart3, BookOpen, Calculator, Newspaper, Search } from "lucide-react";

import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";
import { ConciergeDrawer } from "@/src/components/ai/ConciergeDrawer";

const navItems = [
  { href: "/onboarding", label: "概要", icon: BookOpen },
  { href: "/markets", label: "テーマ", icon: Search },
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
            <BrandLogo />
          </Link>
          <nav className="flex gap-1 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible md:pb-0" aria-label="メインナビゲーション">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="inline-flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
