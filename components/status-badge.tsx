import { Badge } from "@/components/ui/badge";
import type { DataStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: DataStatus }) {
  if (status === "live") return <Badge variant="live">リアルタイム</Badge>;
  if (status === "error") return <Badge variant="error">更新未確認</Badge>;
  return <Badge variant="fallback">参考データ</Badge>;
}
