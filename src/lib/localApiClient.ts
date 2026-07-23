"use client";

const LOCAL_API_STORAGE_KEY = "jmw.localApiBase";
const LOCAL_API_TOKEN_STORAGE_KEY = "jmw.localApiToken";
const VIEWER_API_TOKEN_STORAGE_KEY = "jmw.viewerApiToken";
const DEFAULT_STATIC_LOCAL_API_BASE = process.env.NEXT_PUBLIC_LOCAL_API_BASE ?? "";
const STATIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const LIVE_REGISTRY_BASE = "https://raw.githubusercontent.com/Runnnnnnnnnnnnnnnnn/poly/live";
const LIVE_CONNECTION_URL = process.env.NEXT_PUBLIC_LIVE_CONNECTION_URL
  ?? (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"
    ? `${LIVE_REGISTRY_BASE}/connection.json`
    : `${STATIC_BASE_PATH}/live-connection.json`);
const LIVE_DASHBOARD_URL = process.env.NEXT_PUBLIC_LIVE_DASHBOARD_URL
  ?? (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1"
    ? `${LIVE_REGISTRY_BASE}/dashboard.json`
    : `${STATIC_BASE_PATH}/live-dashboard.json`);
const LIVE_CONNECTION_REFRESH_MS = 120_000;

let liveConnectionPromise: Promise<string> | null = null;
let liveConnectionCheckedAt = 0;

export function initializeLocalApiBaseFromUrl() {
  if (typeof window === "undefined") return "";
  const apiBase = getUrlApiBase();
  initializeApiAccessFromUrl();
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
    .catch(() => {
      liveConnectionPromise = null;
      return getLocalApiBase();
    });

  return liveConnectionPromise;
}

export async function fetchLiveDashboardSnapshot<T>() {
  const separator = LIVE_DASHBOARD_URL.includes("?") ? "&" : "?";
  const response = await fetch(`${LIVE_DASHBOARD_URL}${separator}v=${Date.now()}`, {
    cache: "no-store",
    headers: { accept: "application/vnd.github.raw+json" },
  });
  if (!response.ok) throw new Error(`live dashboard registry returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function initializeApiAccessFromUrl() {
  if (typeof window === "undefined") return "";
  const adminToken = getUrlAdminToken();
  const viewerToken = getHashViewerToken();
  if (isLocalAdminHost() && adminToken) setLocalApiToken(adminToken);
  if (!isLocalAdminHost()) setLocalApiToken("");
  if (viewerToken) setViewerApiToken(viewerToken);
  scrubAccessTokensFromUrl();
  return viewerToken || adminToken;
}

export function getLocalApiToken() {
  if (typeof window === "undefined") return "";
  if (!isLocalAdminHost()) return "";
  return window.localStorage.getItem(LOCAL_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

export function setLocalApiToken(value: string) {
  const normalized = value.trim();
  if (normalized) window.localStorage.setItem(LOCAL_API_TOKEN_STORAGE_KEY, normalized);
  else window.localStorage.removeItem(LOCAL_API_TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event("local-api-token-changed"));
}

export function getViewerApiToken() {
  if (typeof window === "undefined") return "";
  const fromHash = getHashViewerToken();
  if (fromHash) {
    const saved = window.localStorage.getItem(VIEWER_API_TOKEN_STORAGE_KEY);
    if (saved !== fromHash) window.localStorage.setItem(VIEWER_API_TOKEN_STORAGE_KEY, fromHash);
    return fromHash;
  }
  return window.localStorage.getItem(VIEWER_API_TOKEN_STORAGE_KEY)?.trim() ?? "";
}

export function setViewerApiToken(value: string) {
  const normalized = value.trim();
  if (normalized) window.localStorage.setItem(VIEWER_API_TOKEN_STORAGE_KEY, normalized);
  else window.localStorage.removeItem(VIEWER_API_TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event("viewer-api-token-changed"));
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
  if (aiApiBase() !== "") return true;
  if (typeof window === "undefined") return false;
  if (process.env.NEXT_PUBLIC_STATIC_EXPORT === "1") {
    return Boolean(getViewerApiToken() || getLocalApiToken());
  }
  return true;
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
  const token = getViewerApiToken() || getLocalApiToken();
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

function getUrlAdminToken() {
  if (typeof window === "undefined") return "";
  if (!isLocalAdminHost()) return "";
  const params = new URLSearchParams(window.location.search);
  return (params.get("adminToken") || params.get("apiToken") || params.get("token") || "").trim();
}

function getHashViewerToken() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return (params.get("viewerToken") || params.get("accessToken") || "").trim();
}

function scrubAccessTokensFromUrl() {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["adminToken", "apiToken", "token"]) {
    if (!url.searchParams.has(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  for (const key of ["viewerToken", "accessToken"]) {
    if (!hashParams.has(key)) continue;
    hashParams.delete(key);
    changed = true;
  }
  if (!changed) return;
  const nextHash = hashParams.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`);
}

function isLocalAdminHost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}
