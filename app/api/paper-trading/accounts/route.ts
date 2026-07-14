import { NextResponse } from "next/server";
import { z } from "zod";

import { createPaperAccount, listPaperAccounts } from "@/src/lib/paper-trading/service";

const schema = z.object({ name: z.string().trim().min(1).max(80).default("default"), initialCash: z.number().positive().default(10_000) });

export async function GET() {
  return NextResponse.json({ items: await listPaperAccounts() }, { headers: noStore() });
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json().catch(() => ({})));
    return NextResponse.json(await createPaperAccount(input.name, input.initialCash), { headers: noStore() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "invalid request" }, { status: 400, headers: noStore() });
  }
}

function noStore() { return { "cache-control": "no-store" }; }
