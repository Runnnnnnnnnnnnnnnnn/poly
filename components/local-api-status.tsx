"use client";

import { FormEvent, useEffect, useState } from "react";
import { Activity, PlugZap } from "lucide-react";

import { getLocalApiBase, setLocalApiBase, fetchLocalApi, initializeLocalApiBaseFromUrl } from "@/src/lib/localApiClient";

type HealthResponse = {
  ok: boolean;
  deepSeekConfigured: boolean;
  deepSeekModel: string;
  timestamp: string;
};

export function LocalApiStatus() {
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"checking" | "live" | "offline">("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    function syncBase() {
      const current = getLocalApiBase();
      setBase(current || "same-origin");
      setDraft(current);
    }

    initializeLocalApiBaseFromUrl();
    syncBase();
    window.addEventListener("local-api-base-changed", syncBase);
    return () => window.removeEventListener("local-api-base-changed", syncBase);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const payload = await fetchLocalApi<HealthResponse>("/api/health");
        if (!cancelled) {
          setHealth(payload);
          setState(payload.ok ? "live" : "offline");
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setState("offline");
        }
      }
    }

    void check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalApiBase(draft);
  }

  return (
    <div className="border-t border-border bg-slate-50">
      <div className="mx-auto grid max-w-7xl gap-3 px-5 py-3 text-xs text-muted-foreground md:flex md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 font-semibold text-slate-700">
            {state === "live" ? <Activity className="h-4 w-4 text-emerald-600" /> : <PlugZap className="h-4 w-4 text-slate-500" />}
            ローカルAPI {state === "live" ? "Live" : state === "checking" ? "確認中" : "未接続"}
          </span>
          <span>{base}</span>
          {health ? <span>DeepSeek {health.deepSeekConfigured ? health.deepSeekModel : "未設定"}</span> : null}
        </div>
        <form onSubmit={onSubmit} className="flex min-w-0 gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="http://127.0.0.1:3000"
            className="h-8 w-56 rounded-md border border-input bg-white px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <button type="submit" className="h-8 rounded-md border border-border bg-white px-3 font-semibold hover:bg-accent">
            接続
          </button>
        </form>
      </div>
    </div>
  );
}
