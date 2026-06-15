"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";

export function WatchButton({ marketId }: { marketId: string }) {
  const [watched, setWatched] = useState(false);

  useEffect(() => {
    const items = JSON.parse(localStorage.getItem("jmw-watchlist") ?? "[]") as string[];
    setWatched(items.includes(marketId));
  }, [marketId]);

  function toggle() {
    const items = JSON.parse(localStorage.getItem("jmw-watchlist") ?? "[]") as string[];
    const next = watched ? items.filter((item) => item !== marketId) : [...new Set([...items, marketId])];
    localStorage.setItem("jmw-watchlist", JSON.stringify(next));
    setWatched(!watched);
  }

  return (
    <Button type="button" variant={watched ? "secondary" : "default"} onClick={toggle}>
      {watched ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      {watched ? "ウォッチ解除" : "ウォッチする"}
    </Button>
  );
}
