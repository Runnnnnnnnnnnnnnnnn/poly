import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  getCombinedShadowStatus,
  setCombinedShadowEmergencyStop,
  tickActiveForwardRuns,
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
  if (action === "start" || action === "tick") return NextResponse.json(await tickActiveForwardRuns(), { status: action === "start" ? 201 : 200 });
  if (action === "emergency-stop") return NextResponse.json(await setCombinedShadowEmergencyStop(true));
  return NextResponse.json(await setCombinedShadowEmergencyStop(false));
}
