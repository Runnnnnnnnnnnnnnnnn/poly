import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  ensureCombinedShadowRun,
  getCombinedShadowStatus,
  setCombinedShadowEmergencyStop,
  tickCombinedShadowRun,
} from "@/src/lib/combined-trading/service";

export const dynamic = "force-dynamic";

const actionSchema = z.object({
  action: z.enum(["start", "tick", "emergency-stop", "resume"]),
});

export async function GET() {
  return NextResponse.json(await getCombinedShadowStatus());
}

export async function POST(request: NextRequest) {
  const { action } = actionSchema.parse(await request.json());
  if (action === "start") {
    const run = await ensureCombinedShadowRun();
    return NextResponse.json(await tickCombinedShadowRun(run.id), { status: 201 });
  }
  if (action === "tick") return NextResponse.json(await tickCombinedShadowRun());
  if (action === "emergency-stop") return NextResponse.json(await setCombinedShadowEmergencyStop(true));
  return NextResponse.json(await setCombinedShadowEmergencyStop(false));
}
