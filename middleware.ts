import { NextRequest, NextResponse } from "next/server";

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

export function middleware(request: NextRequest) {
  const headers = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers,
    });
  }

  const publicReadOnlyPath = request.method === "GET"
    && (request.nextUrl.pathname === "/api/health" || request.nextUrl.pathname === "/api/public-dashboard");
  if (publicReadOnlyPath) {
    const response = NextResponse.next();
    Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
    return response;
  }

  const expectedToken = process.env.API_ACCESS_TOKEN?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const suppliedToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!expectedToken) {
    return NextResponse.json({ error: "API_ACCESS_TOKEN is not configured" }, { status: 503, headers });
  }
  if (!suppliedToken || suppliedToken !== expectedToken) {
    return NextResponse.json({ error: "API authentication required" }, { status: 401, headers });
  }

  const response = NextResponse.next();
  Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
