import { RealtimeMarketDataCollector } from "../src/lib/realtime-market-data/collector";

const intervalMs = Number(process.env.REALTIME_TICK_INTERVAL_MS ?? 5_000);
const retentionDays = Number(process.env.REALTIME_TICK_RETENTION_DAYS ?? 14);
const collector = new RealtimeMarketDataCollector({ intervalMs, retentionDays });

const status = await collector.start();
console.log(`realtime market data collector started: ${status.intervalMs}ms / ${status.markets} markets / ${status.desiredTokens} tokens`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await collector.stop();
}

process.on("SIGINT", () => void stop().finally(() => process.exit(0)));
process.on("SIGTERM", () => void stop().finally(() => process.exit(0)));

if (process.env.ONCE === "1") {
  await new Promise((resolve) => setTimeout(resolve, Math.max(12_000, intervalMs * 3)));
  console.log(JSON.stringify({ type: "realtime-market-data", ...collector.status() }));
  await stop();
}
