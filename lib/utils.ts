import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function formatPayoutMultiplier(price: number | null | undefined) {
  if (!price || price <= 0) return "-";
  const multiplier = 1 / price;
  return `${multiplier >= 10 ? multiplier.toFixed(0) : multiplier.toFixed(1)}倍`;
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

export function formatJpy(value: number) {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDate(value: string | null) {
  if (!value) return "未定";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function formatDateTime(value: string | null) {
  if (!value) return "未定";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function toNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function safeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cacheOptions =
    process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"
      ? ({ cache: "force-cache" } as RequestInit)
      : ({ next: { revalidate: 300 } } as RequestInit);
  try {
    return await fetch(url, {
      ...init,
      ...cacheOptions,
      signal: controller.signal,
      headers: {
        "user-agent": "PolymarketWatch/0.1 readonly research dashboard",
        accept: "application/json, application/xml, text/xml, text/html;q=0.8",
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}
