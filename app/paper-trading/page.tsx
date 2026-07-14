import { AppShell } from "@/components/app-shell";
import { PaperTradingDashboardClient } from "@/components/paper-trading/paper-trading-dashboard-client";

export default function PaperTradingPage() {
  return (
    <AppShell>
      <PaperTradingDashboardClient />
    </AppShell>
  );
}
