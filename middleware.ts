import { NextRequest, NextResponse } from "next/server";

import { authorizeApiRequest, requiredApiAccess, resolveViewerAccessToken } from "@/src/lib/server/api-access";

const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://runnnnnnnn.github.io",
  "https://runnnnnnnnnnnnnnnnn.github.io",
];

function allowedOrigins() {
  const configured = process.env.CORS_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  return new Set([...defaultAllowedOrigins, ...configured]);
}

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && allowedOrigins().has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export async function middleware(request: NextRequest) {
  const headers = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers,
    });
  }

  const expectedToken = process.env.API_ACCESS_TOKEN?.trim();
  const viewerToken = await resolveViewerAccessToken(expectedToken ?? "", process.env.VIEWER_ACCESS_TOKEN ?? "");
  const required = requiredApiAccess(request.method, request.nextUrl.pathname);
  if (required === "admin" && !expectedToken) {
    return NextResponse.json({ error: "API_ACCESS_TOKEN is not configured" }, { status: 503, headers });
  }
  if (required === "viewer" && !expectedToken && !viewerToken) {
    return NextResponse.json({ error: "AI viewer access is not configured" }, { status: 503, headers });
  }
  const access = authorizeApiRequest({
    method: request.method,
    pathname: request.nextUrl.pathname,
    authorization: request.headers.get("authorization"),
    adminToken: expectedToken ?? "",
    viewerToken,
  });
  if (!access) {
    return NextResponse.json({ error: "API authentication required" }, { status: 401, headers });
  }

  const response = NextResponse.next();
  Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
