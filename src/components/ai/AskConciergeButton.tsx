"use client";

import { Bot } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { OPEN_CONCIERGE_EVENT, type ConciergeOpenContext } from "@/src/lib/ai/concierge-context";

export function AskConciergeButton({
  label = "AIコンシェルジュに質問する",
  context,
  variant = "secondary",
}: {
  label?: string;
  context?: ConciergeOpenContext;
  variant?: ButtonProps["variant"];
}) {
  return (
    <Button
      type="button"
      variant={variant}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CONCIERGE_EVENT, { detail: context }))}
    >
      <Bot className="h-4 w-4" />
      {label}
    </Button>
  );
}
