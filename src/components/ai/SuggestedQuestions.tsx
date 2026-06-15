import { DEFAULT_SUGGESTED_QUESTIONS } from "@/src/lib/ai/prompts";

export function SuggestedQuestions({ onSelect, questions = DEFAULT_SUGGESTED_QUESTIONS }: { onSelect: (question: string) => void; questions?: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {questions.map((question) => (
        <button
          key={question}
          type="button"
          onClick={() => onSelect(question)}
          className="rounded-md border border-border bg-white px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-accent hover:text-accent-foreground"
        >
          {question}
        </button>
      ))}
    </div>
  );
}
