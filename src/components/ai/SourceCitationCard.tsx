import type { SourceCard } from "@/src/lib/ai/compressSource";
import { formatDateTime } from "@/lib/utils";

export function SourceCitationCard({ source }: { source: SourceCard }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="grid gap-1 rounded-md border border-border bg-slate-50 p-3 text-xs hover:bg-slate-100"
    >
      <span className="font-semibold text-slate-800">{source.title}</span>
      <span className="text-muted-foreground">
        {source.source} / {formatDateTime(source.publishedAt)} / 信頼度 {source.reliability}
      </span>
    </a>
  );
}
