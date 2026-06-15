// ビルド時にAI予想（市場AI評価）を生成し、静的JSONとして書き出す。
// GitHub Actions 上で DEEPSEEK_API_KEY（シークレット）を使って実行するため、
// 鍵は公開サイトのバンドルに一切含まれず、結果だけが out/ に埋め込まれる。
// 失敗してもデプロイは継続（パネル側はオフライン案内にフォールバック）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getMarketAiEvaluations } from "@/src/lib/ai/market-evaluations";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "public", "ai-evaluations.json");

async function main() {
  const data = await getMarketAiEvaluations();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(data));
  console.log(`gen-ai-snapshot: wrote ${data.items?.length ?? 0} items (status=${data.status}) -> ${outFile}`);
}

main().catch((error) => {
  console.error("gen-ai-snapshot failed (non-fatal):", error instanceof Error ? error.message : error);
  // 失敗してもビルドは止めない
  process.exit(0);
});
