import { NextResponse } from "next/server";

import { getNewsDashboard } from "@/lib/server/dashboard";

export async function GET() {
  const payload = await getNewsDashboard();
  return NextResponse.json(payload);
}
