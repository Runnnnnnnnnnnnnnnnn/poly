import { NextResponse } from "next/server";

import { answerWithDeepSeek, chatRequestSchema } from "@/src/lib/ai/deepseek";

export async function POST(request: Request) {
  const parsed = chatRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ status: "error", error: parsed.error.flatten() }, { status: 400 });
  }

  const payload = await answerWithDeepSeek(parsed.data);
  return NextResponse.json(payload);
}
