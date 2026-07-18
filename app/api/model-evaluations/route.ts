import { NextRequest, NextResponse } from "next/server";

import { modelEvaluationSummariesCsv } from "@/src/lib/model-evaluation/report";
import { listModelEvaluationSummaries, runModelEvaluation } from "@/src/lib/model-evaluation/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 12);
  const items = await listModelEvaluationSummaries(limit);
  if (request.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(modelEvaluationSummariesCsv(items), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="model-evaluation-history.csv"',
        "content-type": "text/csv; charset=utf-8",
      },
    });
  }
  return NextResponse.json({ items }, { headers: { "cache-control": "no-store" } });
}

export async function POST() {
  const result = await runModelEvaluation();
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 201 });
}
