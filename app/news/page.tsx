import { AppShell } from "@/components/app-shell";
import { NewsDashboardClient } from "@/components/news/news-dashboard-client";
import { getMarketsDashboard, getNewsDashboard } from "@/lib/server/dashboard";

export default async function NewsPage() {
  const [data, markets] = await Promise.all([getNewsDashboard(), getMarketsDashboard()]);
  return (
    <AppShell>
      <NewsDashboardClient initialData={data} initialMarkets={markets.markets} />
    </AppShell>
  );
}
