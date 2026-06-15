import Image from "next/image";

import { cn } from "@/lib/utils";

export function MarketImage({
  src,
  priority = false,
  className,
  aspectRatio = "4 / 3",
  sizes,
}: {
  src: string;
  priority?: boolean;
  className?: string;
  aspectRatio?: string;
  sizes: string;
}) {
  return (
    <div className={cn("relative overflow-hidden bg-slate-100", className)} style={{ aspectRatio }}>
      <Image src={src} alt="" fill sizes={sizes} className="opacity-20 blur-md scale-110" style={{ objectFit: "cover" }} />
      <Image src={src} alt="" fill priority={priority} sizes={sizes} style={{ objectFit: "contain", padding: 8 }} />
    </div>
  );
}
