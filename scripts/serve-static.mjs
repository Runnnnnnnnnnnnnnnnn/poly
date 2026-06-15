// 公開ビルド(out/)を basePath "/poly" 付きでローカル配信して目視確認するための簡易サーバー。
// 本番デプロイには使わない（GitHub Pages が out/ を配信する）。
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
const port = Number(process.env.PORT || 4321);
const basePath = "/poly";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function resolveFile(urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p.startsWith(basePath)) p = p.slice(basePath.length);
  if (!p || p === "/") p = "/index.html";
  let candidate = join(root, p);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    candidate = join(candidate, "index.html");
  }
  if (!existsSync(candidate) && existsSync(`${candidate}.html`)) {
    candidate = `${candidate}.html`;
  }
  return candidate;
}

createServer((req, res) => {
  let file = resolveFile(req.url || "/");
  if (!existsSync(file)) {
    file = join(root, "404.html");
    res.statusCode = 200; // SPA的に index を返すより 404.html を表示
  }
  try {
    const body = readFileSync(file);
    res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 500;
    res.end("error");
  }
}).listen(port, () => {
  console.log(`static preview on http://localhost:${port}${basePath}/`);
});
