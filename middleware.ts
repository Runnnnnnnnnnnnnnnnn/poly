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
  const allowOrigin = origin && allowedOrigins().has(origin) ? origin : defaultAllowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function middleware(request: NextRequest) {
  const headers = corsHeaders(request);

  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers,
    });
  }

  const response = NextResponse.next();
  Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
