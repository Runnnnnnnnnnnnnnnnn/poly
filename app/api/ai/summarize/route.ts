import { NextResponse } from "next/server";
import { z } from "zod";

import { answerWithDeepSeek } from "@/src/lib/ai/deepseek";

const summarizeRequestSchema = z.object({
  text: z.string().min(1).max(6000),
  marketId: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = summarizeRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ status: "error", error: parsed.error.flatten() }, { status: 400 });
  }

  const payload = await answerWithDeepSeek({
    marketId: parsed.data.marketId,
    messages: [
      {
        role: "user",
        content: `次の情報を初心者向けに短く要約してください。投資助言は禁止です。\n\n${parsed.data.text}`,
      },
    ],
  });
  return NextResponse.json(payload);
}
