"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";

const WATCHLIST_KEY = "polymarket-watch.watchlist";

export function WatchButton({ marketId }: { marketId: string }) {
  const [watched, setWatched] = useState(false);

  useEffect(() => {
    const items = readWatchlist();
    setWatched(items.includes(marketId));
  }, [marketId]);

  function toggle() {
    const items = readWatchlist();
    const next = watched ? items.filter((item) => item !== marketId) : [...new Set([...items, marketId])];
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
    setWatched(!watched);
  }

  return (
    <Button type="button" variant={watched ? "secondary" : "default"} onClick={toggle}>
      {watched ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      {watched ? "ウォッチ解除" : "ウォッチする"}
    </Button>
  );
}

function readWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY) ?? localStorage.getItem("jmw-watchlist") ?? "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    localStorage.removeItem(WATCHLIST_KEY);
    localStorage.removeItem("jmw-watchlist");
    return [];
  }
}
