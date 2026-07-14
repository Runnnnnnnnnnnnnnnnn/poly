import { createPaperRun } from "../src/lib/paper-trading/service";

const asset = (process.env.ASSET ?? "BTC") as "BTC" | "ETH" | "SOL" | "XRP" | "OTHER";
const run = await createPaperRun({
  asset,
  mode: "historical",
  config: {
    initialCash: Number(process.env.INITIAL_CASH ?? 10_000),
    entryEdge: Number(process.env.ENTRY_EDGE ?? 0.03),
    minTrainingMarkets: Number(process.env.MIN_TRAINING_MARKETS ?? 5),
    maxMarkets: Number(process.env.MARKET_LIMIT ?? 30),
  },
});
console.log(JSON.stringify({ id: run?.id, status: run?.status, metrics: run?.metrics, orders: run?.orders.length, positions: run?.positions.length }, null, 2));
