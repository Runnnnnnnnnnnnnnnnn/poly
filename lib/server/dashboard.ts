import { fetchNewsItems } from "@/lib/adapters/news";
import { fetchMarketDetail, fetchMarkets } from "@/lib/adapters/polymarket";
import { fetchUsdJpy } from "@/lib/adapters/rates";

export async function getMarketsDashboard() {
  const result = await fetchMarkets();
  return {
    ...result,
    updatedAt: new Date().toISOString(),
  };
}

export async function getNewsDashboard() {
  const result = await fetchNewsItems();
  return {
    ...result,
    updatedAt: new Date().toISOString(),
  };
}

export async function getMarketDetailDashboard(id: string) {
  const news = await fetchNewsItems();
  const result = await fetchMarketDetail(id, news.items);
  return {
    ...result,
    updatedAt: new Date().toISOString(),
    newsStatus: news.status,
  };
}

export async function getCalculatorDefaults() {
  return fetchUsdJpy();
}
