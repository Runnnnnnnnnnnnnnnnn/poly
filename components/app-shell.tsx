"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type React from "react";
import { Activity, BookOpen, HelpCircle, Menu, Newspaper, Search, X } from "lucide-react";

import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";
import { ConciergeDrawer } from "@/src/components/ai/ConciergeDrawer";
import { initializeLocalApiBaseFromUrl } from "@/src/lib/localApiClient";

const navItems = [
  { href: "/paper-trading", label: "モデル検証", icon: Activity },
  { href: "/onboarding", label: "Polymarketとは", icon: BookOpen },
  { href: "/markets", label: "予測市場一覧", icon: Search },
  { href: "/news", label: "ニュース", icon: Newspaper },
  { href: "/tutorial", label: "読み方ガイド", icon: HelpCircle },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children, className }: { children: React.ReactNode; className?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // ルートが変わったらメニューを閉じる
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    initializeLocalApiBaseFromUrl();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* モバイルは固定しない（スクロールで一緒に流れる）。デスクトップのみ上部固定。 */}
      <header className="relative z-30 border-b border-border bg-background md:sticky md:top-0 md:bg-background/95 md:backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-5 md:py-4">
          <Link href="/markets" className="flex items-center gap-3" onClick={() => setOpen(false)}>
            <BrandLogo />
          </Link>

          {/* デスクトップ用ナビ */}
          <nav className="hidden md:flex md:flex-wrap md:gap-2" aria-label="メインナビゲーション">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-11 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* モバイル用ハンバーガーボタン */}
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "メニューを閉じる" : "メニューを開く"}
            className={cn(
              "inline-flex h-11 w-11 items-center justify-center rounded-md border transition-colors md:hidden",
              open
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-white text-slate-700 hover:bg-accent",
            )}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {/* モバイル用ドロップダウンメニュー */}
        <div className="md:hidden">
          {/* 背景タップで閉じる */}
          <button
            type="button"
            tabIndex={open ? 0 : -1}
            aria-hidden={!open}
            aria-label="メニューを閉じる"
            onClick={() => setOpen(false)}
            className={cn(
              "fixed inset-0 z-20 cursor-default bg-slate-950/25 transition-opacity duration-200",
              open ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          />
          <nav
            id="mobile-menu"
            aria-label="メインナビゲーション"
            className={cn(
              "absolute inset-x-3 top-full z-30 mt-1 origin-top rounded-xl border border-border bg-white p-2 shadow-lg transition duration-200 ease-out",
              open
                ? "visible translate-y-0 scale-100 opacity-100"
                : "pointer-events-none invisible -translate-y-1 scale-95 opacity-0",
            )}
          >
            <div className="grid gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-3 text-base font-semibold transition-colors",
                      active ? "bg-primary text-primary-foreground" : "text-slate-700 hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-md",
                        active ? "bg-white/20 text-primary-foreground" : "bg-accent text-primary",
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>
      </header>

      <main className={cn("mx-auto max-w-7xl px-4 py-6 pb-24 md:px-5 md:py-10 md:pb-10", className)}>{children}</main>
      <footer className="border-t border-border bg-white">
        <div className="mx-auto grid max-w-7xl gap-2 px-4 py-6 text-sm text-muted-foreground md:flex md:items-center md:justify-between md:px-5">
          <span>検証用表示・実注文なし</span>
          <span>Polymarket Watch</span>
        </div>
      </footer>
      <ConciergeDrawer />
    </div>
  );
}
