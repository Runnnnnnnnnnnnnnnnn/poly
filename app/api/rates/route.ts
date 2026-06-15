import { NextResponse } from "next/server";

import { getCalculatorDefaults } from "@/lib/server/dashboard";

export async function GET() {
  const payload = await getCalculatorDefaults();
  return NextResponse.json(payload);
}
