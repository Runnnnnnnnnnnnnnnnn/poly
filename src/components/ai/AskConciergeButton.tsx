"use client";

import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";

export function AskConciergeButton({ label = "AIコンシェルジュに質問する" }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" onClick={() => window.dispatchEvent(new Event("open-concierge"))}>
      <Bot className="h-4 w-4" />
      {label}
    </Button>
  );
}
