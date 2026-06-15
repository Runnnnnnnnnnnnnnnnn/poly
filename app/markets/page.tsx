import { AppShell } from "@/components/app-shell";
import { MarketsDashboardClient } from "@/components/markets/markets-dashboard-client";
import { getMarketsDashboard } from "@/lib/server/dashboard";

export default async function MarketsPage() {
  const data = await getMarketsDashboard();

  return (
    <AppShell>
      <MarketsDashboardClient initialData={data} />
    </AppShell>
  );
}
