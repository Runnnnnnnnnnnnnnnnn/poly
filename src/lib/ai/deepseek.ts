import { z } from "zod";

import { JAPAN_MARKET_CONCIERGE_SYSTEM_PROMPT } from "@/src/lib/ai/prompts";
import { applyAnswerGuardrails, isUnsafeRequest, refusalForUnsafeRequest } from "@/src/lib/ai/answerGuardrails";
import { buildContextPack } from "@/src/lib/ai/buildContextPack";
import { aiToolDefinitions, executeAiTool, parseToolCall } from "@/src/lib/ai/tools";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(12),
  marketId: z.string().optional(),
  page: z.string().optional(),
});

const deepSeekResponseSchema = z
  .object({
    choices: z.array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string(),
                  type: z.string(),
                  function: z.unknown(),
                }),
              )
              .optional(),
          })
          .passthrough(),
      }),
    ),
  })
  .passthrough();

type ChatRole = "system" | "user" | "assistant" | "tool";
type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown;
};

export async function answerWithDeepSeek(input: z.infer<typeof chatRequestSchema>) {
  const latestUserText = [...input.messages].reverse().find((message) => message.role === "user")?.content ?? "";

  if (isUnsafeRequest(latestUserText)) {
    return {
      status: "guarded" as const,
      model: getDeepSeekModel(),
      answer: refusalForUnsafeRequest(),
      sources: [],
    };
  }

  const contextPack = await buildContextPack({ marketId: input.marketId, query: latestUserText });
  const fallbackSources = [
    ...(contextPack.selectedMarket?.relatedOfficialSources ?? []),
    ...contextPack.sourceCards.slice(0, 4),
  ].slice(0, 5);

  if (!process.env.DEEPSEEK_API_KEY) {
    return {
      status: "fallback" as const,
      model: getDeepSeekModel(),
      answer: fallbackAnswer(latestUserText, contextPack),
      sources: fallbackSources,
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: JAPAN_MARKET_CONCIERGE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `利用可能な圧縮済みコンテキストです。Raw HTMLは含めていません。\n${JSON.stringify(contextPack).slice(0, 12000)}`,
    },
    ...input.messages.map((message) => ({ role: message.role, content: message.content })),
  ];

  try {
    const first = await callDeepSeek(messages, true);
    const firstMessage = first.choices[0]?.message;
    const toolCalls = firstMessage?.tool_calls ?? [];

    if (toolCalls.length > 0) {
      const toolMessages = await Promise.all(
        toolCalls.slice(0, 4).map(async (toolCall) => {
          const parsed = parseToolCall(toolCall.function);
          const result = await executeAiTool(parsed.name, parsed.arguments);
          return {
            role: "tool" as const,
            tool_call_id: toolCall.id,
            content: JSON.stringify(result).slice(0, 6000),
          };
        }),
      );
      const second = await callDeepSeek(
        [
          ...messages,
          {
            role: "assistant",
            content: firstMessage?.content ?? "",
            tool_calls: toolCalls,
          },
          ...toolMessages,
        ],
        false,
      );
      return {
        status: "live" as const,
        model: getDeepSeekModel(),
        answer: applyAnswerGuardrails(second.choices[0]?.message.content ?? fallbackAnswer(latestUserText, contextPack)),
        sources: fallbackSources,
      };
    }

    return {
      status: "live" as const,
      model: getDeepSeekModel(),
      answer: applyAnswerGuardrails(firstMessage?.content ?? fallbackAnswer(latestUserText, contextPack)),
      sources: fallbackSources,
    };
  } catch (error) {
    return {
      status: "error" as const,
      model: getDeepSeekModel(),
      answer: `${fallbackAnswer(latestUserText, contextPack)}\n\nDeepSeek APIの呼び出しは失敗しました。${error instanceof Error ? error.message : "原因不明"}`,
      sources: fallbackSources,
    };
  }
}

async function callDeepSeek(messages: ChatMessage[], includeTools: boolean) {
  const response = await fetch(`${getDeepSeekBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: getDeepSeekModel(),
      messages,
      tools: includeTools ? aiToolDefinitions : undefined,
      temperature: 0.3,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 240)}`);
  }

  return deepSeekResponseSchema.parse(await response.json());
}

export function getDeepSeekModel() {
  return process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
}

function getDeepSeekBaseUrl() {
  return (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
}

function fallbackAnswer(question: string, contextPack: Awaited<ReturnType<typeof buildContextPack>>) {
  const market = contextPack.selectedMarket;
  if (market) {
    return applyAnswerGuardrails(
      `結論: ${market.titleJa} は、${market.currentProbabilityExplanation}。\n\n根拠:\n- ${market.oneLineSummary}\n- 主な確認点: ${market.mainWatchPoints.slice(0, 3).join(" / ")}\n- 関連ソース: ${market.relatedOfficialSources.map((source) => `${source.title}（${source.source}）`).join("、") || "確認中"}\n\n質問: ${question}`,
    );
  }

  return applyAnswerGuardrails(
    `結論: Japan Market Watchは、日本関連のPolymarket市場を市場価格と一次情報で整理する読み取り専用ダッシュボードです。\n\n根拠:\n- 市場価格は期待確率の目安として扱います。\n- 公式情報、報道、市場情報を区別します。\n- 現在の市場データ状態は ${contextPack.dataStatus} です。\n\n質問: ${question}`,
  );
}
