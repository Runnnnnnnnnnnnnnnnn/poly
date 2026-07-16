import { NextRequest, NextResponse } from "next/server";

import { listModelEvaluations, runModelEvaluation } from "@/src/lib/model-evaluation/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 12);
  return NextResponse.json({ items: await listModelEvaluations(limit) });
}

export async function POST() {
  const result = await runModelEvaluation();
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 201 });
}
