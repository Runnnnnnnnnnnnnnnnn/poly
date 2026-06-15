import { AppShell } from "@/components/app-shell";
import { CalculatorClient } from "@/components/calculator-client";
import { getCalculatorDefaults } from "@/lib/server/dashboard";

export default async function CalculatorPage() {
  const rate = await getCalculatorDefaults();
  return (
    <AppShell>
      <section className="grid gap-6">
        <div className="grid gap-2">
          <p className="text-sm font-bold text-primary">Profit calculator</p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">収益計算</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            YES/NOの価格、投資額、USD/JPY、手数料から参考損益を計算します。
          </p>
        </div>
        <CalculatorClient initialUsdJpy={rate.usdJpy} rateStatus={rate.status} />
      </section>
    </AppShell>
  );
}
