import { z } from "zod";

import type { RateResponse } from "@/lib/types";
import { fetchWithTimeout } from "@/lib/utils";

const frankfurterRateSchema = z.object({
  date: z.string(),
  base: z.string(),
  quote: z.string(),
  rate: z.number(),
});

export async function fetchUsdJpy(): Promise<RateResponse> {
  try {
    const response = await fetchWithTimeout("https://api.frankfurter.dev/v2/rate/USD/JPY", {}, 8000);
    if (!response.ok) throw new Error(`Frankfurter ${response.status}`);
    const parsed = frankfurterRateSchema.parse(await response.json());
    return {
      status: "live",
      updatedAt: `${parsed.date}T00:00:00.000Z`,
      usdJpy: parsed.rate,
      source: "Frankfurter",
    };
  } catch {
    return {
      status: "fallback",
      updatedAt: new Date().toISOString(),
      usdJpy: 160.33,
      source: "Fallback rate",
    };
  }
}
