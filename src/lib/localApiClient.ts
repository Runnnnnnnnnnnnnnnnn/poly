"use client";

const LOCAL_API_STORAGE_KEY = "jmw.localApiBase";
const DEFAULT_STATIC_LOCAL_API_BASE = process.env.NEXT_PUBLIC_LOCAL_API_BASE ?? "";

export function initializeLocalApiBaseFromUrl() {
  if (typeof window === "undefined") return "";
  const apiBase = getUrlApiBase();
  if (!apiBase) return getLocalApiBase();
  setLocalApiBase(apiBase);
  return apiBase;
}

export function getLocalApiBase() {
  if (typeof window === "undefined") return "";
  const apiBase = getUrlApiBase();
  if (apiBase) {
    const saved = window.localStorage.getItem(LOCAL_API_STORAGE_KEY)?.trim().replace(/\/$/, "");
    if (saved !== apiBase) {
      window.localStorage.setItem(LOCAL_API_STORAGE_KEY, apiBase);
      window.dispatchEvent(new Event("local-api-base-changed"));
    }
    return apiBase;
  }
  const saved = window.localStorage.getItem(LOCAL_API_STORAGE_KEY)?.trim();
  if (saved) return saved.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1") return DEFAULT_STATIC_LOCAL_API_BASE;
  return "";
}

export function setLocalApiBase(value: string) {
  const normalized = value.trim().replace(/\/$/, "");
  if (normalized) {
    window.localStorage.setItem(LOCAL_API_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(LOCAL_API_STORAGE_KEY);
  }
  window.dispatchEvent(new Event("local-api-base-changed"));
}

export function localApiUrl(path: string) {
  const base = getLocalApiBase();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * 静的エクスポート（GitHub Pages など）で、接続先のAPIが設定されていない状態。
 * このとき `/api/*` は存在しないため、自動更新やAI機能を呼び出さず、
 * ビルド時点のスナップショットをそのまま表示する。
 * `?api=` パラメータや NEXT_PUBLIC_LOCAL_API_BASE でAPIを指定した場合は false。
 */
export function isSnapshotMode() {
  if (typeof window === "undefined") return false;
  return process.env.NEXT_PUBLIC_STATIC_EXPORT === "1" && getLocalApiBase() === "";
}

export async function fetchLocalApi<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(localApiUrl(path), {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
  }

  return (await response.json()) as T;
}

function getUrlApiBase() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return (params.get("api") || params.get("apiBase") || "").trim().replace(/\/$/, "");
}
