// ビルド時にAI予想（市場AI評価）を生成し、静的JSONとして書き出す。
// GitHub Actions 上で DEEPSEEK_API_KEY（シークレット）を使って実行するため、
// 鍵は公開サイトのバンドルに一切含まれず、結果だけが out/ に埋め込まれる。
// 失敗してもデプロイは継続（パネル側はオフライン案内にフォールバック）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getMarketAiEvaluations } from "@/src/lib/ai/market-evaluations";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "public", "ai-evaluations.json");

async function main() {
  const attempts = process.env.DEEPSEEK_API_KEY ? 3 : 1;
  let data = await getMarketAiEvaluations();
  for (let attempt = 1; attempt < attempts && data.status !== "live"; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 2_000));
    data = await getMarketAiEvaluations();
  }
  const previous = readPreviousSnapshot();
  if (data.status !== "live" && previous?.status === "live" && isRecent(previous.updatedAt)) {
    console.warn("gen-ai-snapshot: keeping the previous live snapshot after transient AI failure");
    data = previous;
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(data));
  console.log(`gen-ai-snapshot: wrote ${data.items?.length ?? 0} items (status=${data.status}) -> ${outFile}`);
}

function readPreviousSnapshot() {
  if (!existsSync(outFile)) return null;
  try { return JSON.parse(readFileSync(outFile, "utf8")) as Awaited<ReturnType<typeof getMarketAiEvaluations>>; } catch { return null; }
}

function isRecent(value: string | undefined) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= 24 * 60 * 60 * 1_000;
}

main().catch((error) => {
  console.error("gen-ai-snapshot failed (non-fatal):", error instanceof Error ? error.message : error);
  // 失敗してもビルドは止めない
  process.exit(0);
});
