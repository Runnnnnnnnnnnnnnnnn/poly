import { runBacktest } from "../src/lib/backtest/service";

const asset = (process.env.ASSET ?? "BTC") as "BTC" | "ETH" | "SOL" | "XRP" | "OTHER";
const result = await runBacktest({
  asset,
  threshold: Number(process.env.THRESHOLD ?? 0.55),
  initialCapital: Number(process.env.INITIAL_CAPITAL ?? 1000),
  limit: Number(process.env.MARKET_LIMIT ?? 40),
});
console.log(JSON.stringify(result, null, 2));
