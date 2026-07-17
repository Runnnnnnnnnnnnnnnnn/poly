"use client";

const LOCAL_API_STORAGE_KEY = "jmw.localApiBase";
const LOCAL_API_TOKEN_STORAGE_KEY = "jmw.localApiToken";
const DEFAULT_STATIC_LOCAL_API_BASE = process.env.NEXT_PUBLIC_LOCAL_API_BASE ?? "";
const LIVE_CONNECTION_URL = process.env.NEXT_PUBLIC_LIVE_CONNECTION_URL
  ?? "https://api.github.com/repos/Runnnnnnnnnnnnnnnnn/poly/contents/connection.json?ref=live";
const LIVE_CONNECTION_REFRESH_MS = 120_000;

let liveConnectionPromise: Promise<string> | null = null;
let liveConnectionCheckedAt = 0;

export function initializeLocalApiBaseFromUrl() {
  if (typeof window === "undefined") return "";
  const apiBase = getUrlApiBase();
  initializeLocalApiTokenFromUrl();
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

export async function discoverLiveApiBase() {
  if (typeof window === "undefined") return "";
  const explicit = getUrlApiBase();
  if (explicit || process.env.NEXT_PUBLIC_STATIC_EXPORT !== "1") return getLocalApiBase();

  if (liveConnectionPromise && Date.now() - liveConnectionCheckedAt < LIVE_CONNECTION_REFRESH_MS) {
    return liveConnectionPromise;
  }

  liveConnectionCheckedAt = Date.now();
  const separator = LIVE_CONNECTION_URL.includes("?") ? "&" : "?";
  liveConnectionPromise = fetch(`${LIVE_CONNECTION_URL}${separator}v=${liveConnectionCheckedAt}`, {
    cache: "no-store",
    headers: { accept: "application/vnd.github.raw+json" },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`connection registry returned ${response.status}`);
      const payload = await response.json() as { apiBase?: unknown };
      if (typeof payload.apiBase !== "string") throw new Error("connection registry is invalid");
      const url = new URL(payload.apiBase);
      if (url.protocol !== "https:") throw new Error("connection registry must use HTTPS");
      const normalized = url.toString().replace(/\/$/, "");
      if (getLocalApiBase() !== normalized) setLocalApiBase(normalized);
      return normalized;
    })
    .catch(() => getLocalApiBase());

  return liveConnectionPromise;
}

export function initializeLocalApiTokenFromUrl() {
  if (typeof window === "undefined") return "";
  const token = getUrlApiToken();
  if (token) setLocalApiToken(token);
  return getLocalApiToken();
}

export function getLocalApiToken() {
  if (typeof window === "undefined") return "";
  const fromUrl = getUrlApiToken();
  if (fromUrl) {
    const saved = window.localStorage.getItem(LOCAL_API_TOKEN_STORAGE_KEY);
    if (saved !== fromUrl) window.localStorage.setItem(LOCAL_API_TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return window.localStorage.getItem(LOCAL_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

export function setLocalApiToken(value: string) {
  const normalized = value.trim();
  if (normalized) window.localStorage.setItem(LOCAL_API_TOKEN_STORAGE_KEY, normalized);
  else window.localStorage.removeItem(LOCAL_API_TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event("local-api-token-changed"));
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

/**
 * AI（チャット/評価）専用の接続先。
 * 鍵を持つ別ホスト（このアプリをデプロイしたバックエンド）のURLを
 * NEXT_PUBLIC_AI_API_BASE に設定すると、公開（静的）版でも鍵を露出せずにAIを利用できる。
 * `?aiApi=` パラメータでも上書きできる（検証用）。未設定なら "".
 */
export function aiApiBase() {
  const fromEnv = (process.env.NEXT_PUBLIC_AI_API_BASE ?? "").trim().replace(/\/$/, "");
  if (typeof window === "undefined") return fromEnv;
  const param = new URLSearchParams(window.location.search).get("aiApi");
  if (param) return param.trim().replace(/\/$/, "");
  return fromEnv;
}

/** AIエンドポイントのURL。AI専用ベースがあればそれを、無ければローカル /api を使う。 */
export function aiEndpoint(path: string) {
  const base = aiApiBase();
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${suffix}` : localApiUrl(path);
}

/**
 * AIが実際に呼び出せるか。
 * - AI専用ベースが設定されていれば常に利用可能（公開版でもプロキシ経由で動作）。
 * - そうでなければ、ローカル /api がある（=スナップショットでない）場合のみ利用可能。
 */
export function isAiAvailable() {
  return aiApiBase() !== "" || !isSnapshotMode();
}

export async function fetchLocalApi<T>(path: string, init: RequestInit = {}) {
  const token = getLocalApiToken();
  const response = await fetch(localApiUrl(path), {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
  }

  return (await response.json()) as T;
}

/** AIエンドポイント（aiApiBase 優先）に対する GET。 */
export async function fetchAi<T>(path: string, init: RequestInit = {}) {
  const token = getLocalApiToken();
  const response = await fetch(aiEndpoint(path), {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

function getUrlApiToken() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return (params.get("apiToken") || params.get("token") || "").trim();
}
