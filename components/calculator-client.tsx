"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DataStatus, RateResponse } from "@/lib/types";
import { formatJpy, formatUsd } from "@/lib/utils";
import { fetchLocalApi } from "@/src/lib/localApiClient";

export function CalculatorClient({ initialUsdJpy, rateStatus }: { initialUsdJpy: number; rateStatus: DataStatus }) {
  const [buyPrice, setBuyPrice] = useState(0.42);
  const [sellPrice, setSellPrice] = useState(0.55);
  const [investmentUsd, setInvestmentUsd] = useState(1000);
  const [usdJpy, setUsdJpy] = useState(initialUsdJpy);
  const [currentRateStatus, setCurrentRateStatus] = useState(rateStatus);
  const [feeRate, setFeeRate] = useState(1);
  const [side, setSide] = useState<"YES" | "NO">("YES");

  useEffect(() => {
    let cancelled = false;
    async function refreshRate() {
      try {
        const payload = await fetchLocalApi<RateResponse>("/api/fx");
        if (!cancelled) {
          setUsdJpy(payload.usdJpy);
          setCurrentRateStatus(payload.status);
        }
      } catch {
        if (!cancelled) setCurrentRateStatus("fallback");
      }
    }

    void refreshRate();
    const timer = window.setInterval(refreshRate, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const result = useMemo(() => {
    const normalizedBuy = Math.max(0.01, buyPrice);
    const shares = investmentUsd / normalizedBuy;
    const grossProfitUsd = shares * (sellPrice - normalizedBuy);
    const feeUsd = investmentUsd * (feeRate / 100);
    const netProfitUsd = grossProfitUsd - feeUsd;
    const profitJpy = netProfitUsd * usdJpy;
    const returnPct = investmentUsd > 0 ? (netProfitUsd / investmentUsd) * 100 : 0;
    const breakEvenSellPrice = normalizedBuy + feeUsd / shares;
    return {
      shares,
      grossProfitUsd,
      feeUsd,
      netProfitUsd,
      profitJpy,
      returnPct,
      breakEvenSellPrice,
      maxLoss: investmentUsd + feeUsd,
    };
  }, [buyPrice, feeRate, investmentUsd, sellPrice, usdJpy]);

  return (
    <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
      <Card>
        <CardHeader>
          <CardTitle>入力</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <SegmentedSide value={side} onChange={setSide} />
          <NumberField label="購入価格 USD" value={buyPrice} min={0.01} max={0.99} step={0.01} onChange={setBuyPrice} />
          <NumberField label="想定売却価格 USD" value={sellPrice} min={0.01} max={0.99} step={0.01} onChange={setSellPrice} />
          <NumberField label="投資額 USD" value={investmentUsd} min={1} step={50} onChange={setInvestmentUsd} />
          <NumberField label="USD/JPY" value={usdJpy} min={1} step={0.01} onChange={setUsdJpy} />
          <NumberField label="手数料 %" value={feeRate} min={0} step={0.1} onChange={setFeeRate} />
          <div className="text-sm text-muted-foreground">
            為替レート:{" "}
            <Badge variant={currentRateStatus === "live" ? "live" : "fallback"}>
              {currentRateStatus === "live" ? "リアルタイム" : "参考レート"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>試算結果</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ResultRow label="選択" value={side} />
          <ResultRow label="想定利益 USD" value={formatUsd(result.netProfitUsd)} emphasize />
          <ResultRow label="想定利益 JPY" value={formatJpy(result.profitJpy)} emphasize />
          <ResultRow label="想定リターン" value={`${result.returnPct.toFixed(2)}%`} />
          <ResultRow label="損益分岐価格" value={`$${result.breakEvenSellPrice.toFixed(4)}`} />
          <ResultRow label="最大損失" value={formatUsd(result.maxLoss)} />
          <ResultRow label="推定シェア数" value={result.shares.toFixed(2)} />
          <p className="rounded-md bg-slate-50 p-3 text-sm leading-6 text-muted-foreground">
            この計算は参考値です。市場価格、約定可否、手数料、為替、流動性によって結果は変わります。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-10 rounded-md border border-input bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

function SegmentedSide({
  value,
  onChange,
}: {
  value: "YES" | "NO";
  onChange: (value: "YES" | "NO") => void;
}) {
  return (
    <div className="grid grid-cols-2 rounded-md border border-border bg-slate-50 p-1">
      {(["YES", "NO"] as const).map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onChange(item)}
          className={[
            "h-9 rounded-md text-sm font-bold",
            value === item ? "bg-white text-primary shadow-sm" : "text-muted-foreground",
          ].join(" ")}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

function ResultRow({ label, value, emphasize = false }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border pb-3 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={emphasize ? "text-xl font-bold text-primary" : "font-semibold"}>{value}</span>
    </div>
  );
}
