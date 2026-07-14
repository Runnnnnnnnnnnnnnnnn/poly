import { collectCryptoSnapshots } from "../src/lib/backtest/service";

const intervalMs = Math.max(30_000, Number(process.env.COLLECT_INTERVAL_MS ?? 300_000));

async function collect() {
  try {
    const result = await collectCryptoSnapshots();
    console.log(JSON.stringify({ type: "crypto-snapshot", ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

await collect();
if (process.env.ONCE !== "1") {
  setInterval(collect, intervalMs);
  console.log(`crypto snapshot collector running every ${intervalMs}ms`);
}
