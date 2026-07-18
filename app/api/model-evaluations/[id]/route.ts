import { NextRequest, NextResponse } from "next/server";

import { modelEvaluationSummariesCsv } from "@/src/lib/model-evaluation/report";
import { getModelEvaluationExport } from "@/src/lib/model-evaluation/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const report = await getModelEvaluationExport(id);
  if (!report) return NextResponse.json({ error: "model evaluation not found" }, { status: 404 });

  if (request.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(modelEvaluationSummariesCsv([report.summary]), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="model-evaluation-${safeFileName(id)}.csv"`,
        "content-type": "text/csv; charset=utf-8",
      },
    });
  }

  return NextResponse.json(report, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="model-evaluation-${safeFileName(id)}.json"`,
    },
  });
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "report";
}
