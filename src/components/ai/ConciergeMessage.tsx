import { StatusBadge } from "@/components/status-badge";
import type { DataStatus } from "@/lib/types";

export type ConciergeChatMessage = {
  role: "user" | "assistant";
  content: string;
  status?: DataStatus | "guarded";
  model?: string;
};

export function ConciergeMessage({ message }: { message: ConciergeChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={[
          "max-w-[86%] rounded-lg px-4 py-3 text-sm leading-6",
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-white text-slate-800",
        ].join(" ")}
      >
        <div className="whitespace-pre-line">{message.content}</div>
        {!isUser && message.status ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            {message.status === "guarded" ? <span className="rounded-md bg-slate-100 px-2 py-1 font-semibold">Guarded</span> : <StatusBadge status={message.status} />}
            {message.model ? <span>{message.model}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
