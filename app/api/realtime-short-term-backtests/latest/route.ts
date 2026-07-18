import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const reportSchema = z.object({
  generatedAt: z.string(),
  reproducibility: z.object({ runId: z.string().regex(/^[a-zA-Z0-9_.-]+$/) }),
}).passthrough();

export async function GET(request: NextRequest) {
  const artifactRoot = resolve(
    (process.env.REALTIME_SHORT_TERM_ARTIFACT_ROOT ?? `${homedir()}/.polymarket-watch/artifacts/realtime-short-term-backtests`)
      .replace(/^~(?=\/)/, homedir()),
  );
  try {
    const reportText = await readFile(resolve(artifactRoot, "latest.json"), "utf8");
    const report = reportSchema.parse(JSON.parse(reportText));
    const format = request.nextUrl.searchParams.get("format") ?? "json";
    if (format === "trades") {
      return new NextResponse(await readFile(resolve(artifactRoot, report.reproducibility.runId, "trades.csv"), "utf8"), {
        headers: downloadHeaders(`realtime-short-term-trades-${safeFileName(report.generatedAt)}.csv`, "text/csv; charset=utf-8"),
      });
    }
    if (format === "opportunities") {
      return new NextResponse(await readFile(resolve(artifactRoot, report.reproducibility.runId, "opportunities.csv"), "utf8"), {
        headers: downloadHeaders(`realtime-short-term-opportunities-${safeFileName(report.generatedAt)}.csv`, "text/csv; charset=utf-8"),
      });
    }
    if (format !== "json") return NextResponse.json({ error: "unsupported format" }, { status: 400 });
    return new NextResponse(reportText, {
      headers: downloadHeaders(`realtime-short-term-backtest-${safeFileName(report.generatedAt)}.json`, "application/json; charset=utf-8"),
    });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "realtime short-term backtest artifact is invalid" }, { status: 500 });
    }
    const code = (error as NodeJS.ErrnoException).code;
    return NextResponse.json(
      { error: code === "ENOENT" ? "realtime short-term backtest artifact not found" : "realtime short-term backtest artifact could not be read" },
      { status: code === "ENOENT" ? 404 : 500 },
    );
  }
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
