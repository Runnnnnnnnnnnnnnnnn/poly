import { spawn } from "node:child_process";

const production = process.env.PAPER_PRODUCTION === "1";
const env = { ...process.env };
const children = [
  spawn(process.execPath, ["node_modules/next/dist/bin/next", production ? "start" : "dev"], { env, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/run-paper-trading.mts"], { env, stdio: "inherit" }),
];

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250);
}

for (const child of children) child.on("exit", (code) => {
  if (!closing && code && code !== 0) shutdown(code);
});
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(production ? "paper app + worker started in production mode" : "paper app + worker started in development mode");
