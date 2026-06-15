import { StatusBadge } from "@/components/status-badge";
import type { SourceStatus } from "@/lib/types";

export function SourceStatusList({ items }: { items: SourceStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <div key={`${item.source}-${item.status}`} className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-3 py-2 text-xs">
          <span className="font-semibold text-slate-700">{item.source}</span>
          <StatusBadge status={item.status} />
        </div>
      ))}
    </div>
  );
}
