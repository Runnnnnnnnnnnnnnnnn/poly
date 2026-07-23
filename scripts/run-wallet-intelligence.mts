import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { prisma } from "../src/lib/server/prisma";
import { collectWalletIntelligence } from "../src/lib/wallet-intelligence/service";

const root = process.env.POLYMARKET_PROJECT_ROOT ?? resolve(import.meta.dirname, "..");
const intervalMs = boundedNumber(process.env.WALLET_INTELLIGENCE_INTERVAL_MS, 5 * 60_000, 60_000, 60 * 60_000);
const once = process.env.WALLET_INTELLIGENCE_ONCE === "1" || process.argv.includes("--once");
let timer: NodeJS.Timeout | null = null;
let closing = false;

async function cycle() {
  try {
    console.log(JSON.stringify({ type: "wallet-intelligence", ...(await collectWalletIntelligence()) }));
    execFileSync(process.execPath, [
      resolve(root, "node_modules/tsx/dist/cli.mjs"),
      resolve(root, "scripts/backtest-wallet-copy.mts"),
    ], { cwd: root, env: process.env, stdio: "inherit" });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  if (once) {
    closing = true;
    await prisma.$disconnect();
    return;
  }
  if (!closing) timer = setTimeout(() => void cycle(), intervalMs);
}

async function shutdown() {
  closing = true;
  if (timer) clearTimeout(timer);
  await prisma.$disconnect();
}

void cycle();
console.log(once ? "wallet intelligence: one cycle" : `wallet intelligence worker: every ${intervalMs}ms`);
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
