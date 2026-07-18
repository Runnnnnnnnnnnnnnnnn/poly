import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const reportIndexSchema = z.object({
  generatedAt: z.string(),
  reproducibility: z.object({ runId: z.string().regex(/^[a-zA-Z0-9_.-]+$/) }),
}).passthrough();

export async function GET(request: NextRequest) {
  const artifactRoot = resolve(
    (process.env.SHORT_TERM_ARTIFACT_ROOT ?? `${homedir()}/.polymarket-watch/artifacts/short-term-backtests`)
      .replace(/^~(?=\/)/, homedir()),
  );
  try {
    const reportText = await readFile(resolve(artifactRoot, "latest.json"), "utf8");
    const report = reportIndexSchema.parse(JSON.parse(reportText));
    const format = request.nextUrl.searchParams.get("format") ?? "json";
    if (format === "observations") {
      return csvResponse(
        await readFile(resolve(artifactRoot, report.reproducibility.runId, "observations.csv"), "utf8"),
        `short-term-observations-${safeFileName(report.generatedAt)}.csv`,
      );
    }
    if (format === "metrics") {
      return csvResponse(
        await readFile(resolve(artifactRoot, report.reproducibility.runId, "metrics.csv"), "utf8"),
        `short-term-metrics-${safeFileName(report.generatedAt)}.csv`,
      );
    }
    if (format === "samples") {
      return csvResponse(
        await readFile(resolve(artifactRoot, report.reproducibility.runId, "decision-samples.csv"), "utf8"),
        `short-term-decision-samples-${safeFileName(report.generatedAt)}.csv`,
      );
    }
    if (format !== "json") {
      return NextResponse.json({ error: "unsupported format" }, { status: 400 });
    }
    return new NextResponse(reportText, {
      headers: downloadHeaders(`short-term-backtest-${safeFileName(report.generatedAt)}.json`, "application/json; charset=utf-8"),
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "short-term backtest artifact is invalid" }, { status: 500 });
    }
    const code = (error as NodeJS.ErrnoException).code;
    return NextResponse.json(
      { error: code === "ENOENT" ? "short-term backtest artifact not found" : "short-term backtest artifact could not be read" },
      { status: code === "ENOENT" ? 404 : 500 },
    );
  }
}

function csvResponse(body: string, fileName: string) {
  return new NextResponse(body, { headers: downloadHeaders(fileName, "text/csv; charset=utf-8") });
}

function downloadHeaders(fileName: string, contentType: string) {
  return {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${fileName}"`,
    "content-type": contentType,
  };
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "latest";
}
