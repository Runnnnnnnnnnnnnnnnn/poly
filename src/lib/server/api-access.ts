export type ApiAccessScope = "public" | "viewer" | "admin";

export const VIEWER_TOKEN_DERIVATION_CONTEXT = "polymarket-watch-viewer:v1:";

export function requiredApiAccess(method: string, pathname: string): ApiAccessScope {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" && isPublicReadPath(pathname)) return "public";
  if (pathname.startsWith("/api/ai/")) return "viewer";
  return "admin";
}

export function authorizeApiRequest(input: {
  method: string;
  pathname: string;
  authorization: string | null;
  adminToken: string;
  viewerToken: string;
}): ApiAccessScope | null {
  const required = requiredApiAccess(input.method, input.pathname);
  if (required === "public") return "public";

  const supplied = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (input.adminToken && supplied === input.adminToken) return "admin";
  if (required === "viewer" && input.viewerToken && supplied === input.viewerToken) return "viewer";
  return null;
}

export async function resolveViewerAccessToken(adminToken: string, explicitViewerToken: string) {
  const explicit = explicitViewerToken.trim();
  if (explicit) return explicit;
  const admin = adminToken.trim();
  if (!admin) return "";
  const bytes = new TextEncoder().encode(`${VIEWER_TOKEN_DERIVATION_CONTEXT}${admin}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function isPublicReadPath(pathname: string) {
  return pathname === "/api/health"
    || pathname === "/api/public-dashboard"
    || pathname === "/api/model-evaluations"
    || pathname.startsWith("/api/model-evaluations/")
    || pathname.startsWith("/api/short-term-backtests/")
    || pathname.startsWith("/api/realtime-short-term-backtests/")
    || pathname === "/api/markets"
    || pathname.startsWith("/api/markets/")
    || pathname === "/api/news"
    || pathname === "/api/fx"
    || pathname === "/api/rates";
}
