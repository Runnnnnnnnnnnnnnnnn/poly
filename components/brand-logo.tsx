import { Activity } from "lucide-react";

export function BrandLogo() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-white shadow-sm">
        <span className="absolute inset-x-2 top-2 h-1 rounded-full bg-primary" />
        <Activity className="h-5 w-5 text-primary" />
        <span className="absolute bottom-2 right-2 h-2 w-2 rounded-full bg-emerald-500" />
      </div>
      <span>
        <span className="block text-base font-bold leading-tight text-slate-950">Polymarket Watch</span>
        <span className="block text-xs font-medium text-muted-foreground">予測市場とモデル検証</span>
      </span>
    </div>
  );
}
