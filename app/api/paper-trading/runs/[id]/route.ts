import { NextResponse } from "next/server";

import { getPaperRun, stopPaperRun, tickPaperRun } from "@/src/lib/paper-trading/service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await getPaperRun(id);
  if (!result) return NextResponse.json({ error: "paper run not found" }, { status: 404 });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await tickPaperRun(id);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "paper tick failed" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    if (body.action !== "stop") return NextResponse.json({ error: "only action=stop is supported" }, { status: 400 });
    return NextResponse.json(await stopPaperRun(id), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "stop failed" }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
