import { z } from "zod";

import { getCalculatorDefaults, getMarketDetailDashboard, getMarketsDashboard, getNewsDashboard } from "@/lib/server/dashboard";

export const aiToolDefinitions = [
  {
    type: "function",
    function: {
      name: "search_markets",
      description: "Search global and Japan-related prediction markets by query and category.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword." },
          category: { type: "string", description: "Optional dashboard category such as 金融, 為替, 政治, イベント." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_detail",
      description: "Get a normalized market detail by marketId.",
      parameters: {
        type: "object",
        properties: { marketId: { type: "string" } },
        required: ["marketId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_related_news",
      description: "Get related news or official source cards for a market.",
      parameters: {
        type: "object",
        properties: { marketId: { type: "string" } },
        required: ["marketId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_official_sources",
      description: "Search official source cards by query and category.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          category: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fx_rate",
      description: "Get an FX rate such as USD/JPY.",
      parameters: {
        type: "object",
        properties: { pair: { type: "string" } },
        required: ["pair"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate_return",
      description: "Calculate a simple reference return scenario.",
      parameters: {
        type: "object",
        properties: {
          buyPrice: { type: "number" },
          sellPrice: { type: "number" },
          investmentUsd: { type: "number" },
          feeRate: { type: "number" },
          usdJpy: { type: "number" },
        },
        required: ["buyPrice", "sellPrice", "investmentUsd", "feeRate", "usdJpy"],
        additionalProperties: false,
      },
    },
  },
];

const toolCallSchema = z.object({
  name: z.string(),
  arguments: z.string().default("{}"),
});

const toolResultSchema = z.object({ ok: z.boolean() }).passthrough();

export async function executeAiTool(name: string, rawArgs: unknown) {
  try {
    const args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : rawArgs;
    const result =
      name === "search_markets"
        ? await searchMarkets(args)
        : name === "get_market_detail"
          ? await getMarketDetail(args)
          : name === "get_related_news"
            ? await getRelatedNews(args)
            : name === "search_official_sources"
              ? await searchOfficialSources(args)
              : name === "get_fx_rate"
                ? await getFxRate(args)
                : name === "calculate_return"
                  ? calculateReturn(args)
                  : { ok: false, error: `Unknown tool: ${name}` };
    return toolResultSchema.parse(result);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "tool execution failed",
    };
  }
}

export function parseToolCall(functionPayload: unknown) {
  return toolCallSchema.parse(functionPayload);
}

async function searchMarkets(args: unknown) {
  const parsed = z.object({ query: z.string(), category: z.string().optional() }).parse(args);
  const data = await getMarketsDashboard();
  const query = parsed.query.toLowerCase();
  const markets = data.markets.filter((market) => {
    const matchesQuery = [market.title, market.originalTitle, market.summaryJa].join(" ").toLowerCase().includes(query);
    const matchesCategory = !parsed.category || market.category === parsed.category;
    return matchesQuery && matchesCategory;
  });
  return { ok: true, status: data.status, markets: markets.slice(0, 8) };
}

async function getMarketDetail(args: unknown) {
  const parsed = z.object({ marketId: z.string() }).parse(args);
  const data = await getMarketDetailDashboard(parsed.marketId);
  return { ok: true, status: data.status, market: data.market };
}

async function getRelatedNews(args: unknown) {
  const parsed = z.object({ marketId: z.string() }).parse(args);
  const detail = await getMarketDetailDashboard(parsed.marketId);
  return { ok: true, status: detail.status, news: detail.market.relatedNews };
}

async function searchOfficialSources(args: unknown) {
  const parsed = z.object({ query: z.string(), category: z.string().optional() }).parse(args);
  const data = await getNewsDashboard();
  const query = parsed.query.toLowerCase();
  const items = data.items.filter((item) => {
    const matchesQuery = [item.title, item.summary, item.source].join(" ").toLowerCase().includes(query);
    const matchesCategory = !parsed.category || item.category === parsed.category;
    return matchesQuery && matchesCategory;
  });
  return { ok: true, status: data.status, items: items.slice(0, 8) };
}

async function getFxRate(args: unknown) {
  z.object({ pair: z.string() }).parse(args);
  const rate = await getCalculatorDefaults();
  return { ok: true, rate };
}

function calculateReturn(args: unknown) {
  const parsed = z
    .object({
      buyPrice: z.number().positive(),
      sellPrice: z.number().positive(),
      investmentUsd: z.number().positive(),
      feeRate: z.number().min(0),
      usdJpy: z.number().positive(),
    })
    .parse(args);
  const shares = parsed.investmentUsd / parsed.buyPrice;
  const grossProfitUsd = shares * (parsed.sellPrice - parsed.buyPrice);
  const feeUsd = parsed.investmentUsd * parsed.feeRate;
  const netProfitUsd = grossProfitUsd - feeUsd;
  const profitJpy = netProfitUsd * parsed.usdJpy;
  const returnPct = (netProfitUsd / parsed.investmentUsd) * 100;
  const breakEvenSellPrice = parsed.buyPrice + feeUsd / shares;
  return {
    ok: true,
    shares,
    grossProfitUsd,
    feeUsd,
    netProfitUsd,
    profitJpy,
    returnPct,
    breakEvenSellPrice,
    note: "この計算は参考値であり、実際の損益を保証するものではありません。",
  };
}
