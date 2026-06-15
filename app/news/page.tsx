import { AppShell } from "@/components/app-shell";
import { NewsDashboardClient } from "@/components/news/news-dashboard-client";
import { getNewsDashboard } from "@/lib/server/dashboard";

export default async function NewsPage() {
  const data = await getNewsDashboard();
  return (
    <AppShell>
      <NewsDashboardClient initialData={data} />
    </AppShell>
  );
}
