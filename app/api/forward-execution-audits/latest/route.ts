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
    (process.env.FORWARD_EXECUTION_AUDIT_ARTIFACT_ROOT
      ?? `${homedir()}/.polymarket-watch/artifacts/forward-execution-audits`)
      .replace(/^~(?=\/)/, homedir()),
  );
  try {
    const format = request.nextUrl.searchParams.get("format") ?? "json";
    if (format === "history") {
      return fileResponse(
        await readFile(resolve(artifactRoot, "history.json"), "utf8"),
        "forward-execution-audit-history.json",
        "application/json; charset=utf-8",
      );
    }
    const reportText = await readFile(resolve(artifactRoot, "latest.json"), "utf8");
    const report = reportSchema.parse(JSON.parse(reportText));
    if (format === "metrics") {
      return fileResponse(
        await readFile(resolve(artifactRoot, report.reproducibility.runId, "metrics.csv"), "utf8"),
        `forward-execution-audit-metrics-${safeFileName(report.generatedAt)}.csv`,
        "text/csv; charset=utf-8",
      );
    }
    if (format !== "json") return NextResponse.json({ error: "unsupported format" }, { status: 400 });
    return fileResponse(
      reportText,
      `forward-execution-audit-${safeFileName(report.generatedAt)}.json`,
      "application/json; charset=utf-8",
    );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "forward execution audit artifact is invalid" }, { status: 500 });
    }
    const code = (error as NodeJS.ErrnoException).code;
    return NextResponse.json(
      { error: code === "ENOENT" ? "forward execution audit artifact not found" : "forward execution audit artifact could not be read" },
      { status: code === "ENOENT" ? 404 : 500 },
    );
  }
}

function fileResponse(body: string, fileName: string, contentType: string) {
  return new NextResponse(body, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${fileName}"`,
      "content-type": contentType,
    },
  });
}

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "latest";
}
