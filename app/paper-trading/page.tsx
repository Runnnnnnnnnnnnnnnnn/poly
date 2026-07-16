import { AppShell } from "@/components/app-shell";
import { DataUsagePanel } from "@/components/data-usage-panel";
import { PaperTradingDashboardClient } from "@/components/paper-trading/paper-trading-dashboard-client";

export default function PaperTradingPage() {
  return (
    <AppShell>
      <div className="grid gap-6">
        <DataUsagePanel mode="model" compact />
        <PaperTradingDashboardClient />
      </div>
    </AppShell>
  );
}
