import { Badge } from "@/components/ui/badge";
import type { DataStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: DataStatus }) {
  if (status === "live") return <Badge variant="live">Live</Badge>;
  if (status === "error") return <Badge variant="error">取得失敗</Badge>;
  return <Badge variant="fallback">Fallback</Badge>;
}
