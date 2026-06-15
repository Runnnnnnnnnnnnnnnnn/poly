"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, MessageSquare, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConciergeMessage, type ConciergeChatMessage } from "@/src/components/ai/ConciergeMessage";
import { SourceCitationCard } from "@/src/components/ai/SourceCitationCard";
import { SuggestedQuestions } from "@/src/components/ai/SuggestedQuestions";
import type { SourceCard } from "@/src/lib/ai/compressSource";
import { localApiUrl } from "@/src/lib/localApiClient";

type ChatResponse = {
  status: "live" | "fallback" | "error" | "guarded";
  model: string;
  answer: string;
  sources: SourceCard[];
};

export function ConciergeDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ConciergeChatMessage[]>([
    {
      role: "assistant",
      content:
        "Polymarket Conciergeです。世界と日本の注目テーマ、確率の見方、関連情報、参考試算を分かりやすく説明します。",
      status: "fallback",
    },
  ]);
  const [sources, setSources] = useState<SourceCard[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const marketId = useMemo(() => {
    const match = pathname.match(/^\/markets\/([^/]+)/);
    return match?.[1];
  }, [pathname]);

  useEffect(() => {
    if (window.location.search.includes("consult=1")) {
      setOpen(true);
    }
    function openConcierge() {
      setOpen(true);
    }
    window.addEventListener("open-concierge", openConcierge);
    return () => window.removeEventListener("open-concierge", openConcierge);
  }, []);

  useEffect(() => {
    panelRef.current?.scrollTo({ top: panelRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  async function sendMessage(question = input) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;
    const nextMessages: ConciergeChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(nextMessages);
    setInput("");
    setOpen(true);

    setLoading(true);

    try {
      const response = await fetch(localApiUrl("/api/ai/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          marketId,
          page: pathname,
          messages: nextMessages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .slice(-8)
            .map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      const payload = (await response.json()) as ChatResponse;
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: payload.answer || "回答を取得できませんでした。",
          status: payload.status,
          model: payload.model,
        },
      ]);
      setSources(payload.sources ?? []);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `AIコンシェルジュの取得に失敗しました。${error instanceof Error ? error.message : ""}`,
          status: "error",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 inline-flex h-12 items-center gap-2 rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground shadow-soft hover:bg-primary/90"
      >
        <MessageSquare className="h-4 w-4" />
        リサーチ相談
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 bg-slate-950/20">
          <aside className="absolute bottom-0 right-0 top-0 flex w-full max-w-[460px] flex-col border-l border-border bg-background shadow-soft">
            <header className="flex items-center justify-between border-b border-border bg-white px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Bot className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-bold">Polymarket Concierge</h2>
                  <p className="text-xs text-muted-foreground">投資助言ではありません / 自動売買機能はありません</p>
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-md p-2 hover:bg-accent" aria-label="閉じる">
                <X className="h-5 w-5" />
              </button>
            </header>

            <div ref={panelRef} className="flex-1 overflow-y-auto px-5 py-4">
              <div className="grid gap-4">
                {messages.map((message, index) => (
                  <ConciergeMessage key={`${message.role}-${index}`} message={message} />
                ))}
                {loading ? <ConciergeMessage message={{ role: "assistant", content: "確認しています...", status: "fallback" }} /> : null}
                {sources.length > 0 ? (
                  <div className="grid gap-2">
                    <p className="text-xs font-bold text-muted-foreground">参照情報</p>
                    {sources.map((source) => (
                      <SourceCitationCard key={`${source.source}-${source.title}`} source={source} />
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="border-t border-border bg-white p-4">
              <SuggestedQuestions onSelect={(question) => void sendMessage(question)} />
              <form onSubmit={onSubmit} className="mt-3 flex gap-2">
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="市場や確率について質問"
                  className="h-10 min-w-0 flex-1 rounded-md border border-input px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <Button type="submit" size="icon" disabled={loading || !input.trim()} aria-label="送信">
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
