import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Option = Type.Object({
  label: Type.String(),
  description: Type.Optional(Type.String()),
});

const Question = Type.Object({
  id: Type.String(),
  question: Type.String(),
  options: Type.Array(Option),
  multi: Type.Optional(Type.Boolean()),
  recommended: Type.Optional(Type.Number()),
});

const AskParams = Type.Object({ questions: Type.Array(Question, { description: "Questions to ask the user." }) });
type AskParamsType = { questions: Array<{ id: string; question: string; options: Array<{ label: string; description?: string }>; multi?: boolean; recommended?: number }> };

function fallbackChoice(question: AskParamsType["questions"][number]): string[] {
  if (question.options.length === 0) return [];
  const index = question.recommended !== undefined ? Math.max(0, Math.min(question.recommended, question.options.length - 1)) : 0;
  const option = question.options[index];
  return option ? [option.label] : [];
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask",
    label: "Ask User",
    description: "Ask structured clarification questions with selectable options. Use only when repo context/tools cannot answer and choices have material tradeoffs.",
    promptSnippet: "ask — structured user clarification.",
    promptGuidelines: ["Default to action; use ask only when a missing choice materially changes the outcome."],
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: AskParamsType, _signal, _onUpdate, ctx) {
      const answers: Record<string, string[]> = {};
      const lines: string[] = [];
      for (const question of params.questions) {
        if (!ctx.hasUI || question.options.length === 0) {
          answers[question.id] = fallbackChoice(question);
        } else if (question.multi) {
          const picked: string[] = [];
          while (true) {
            const remaining = question.options.map((option) => option.label).filter((label) => !picked.includes(label));
            const choices = remaining.length > 0 ? [...remaining, "Done"] : ["Done"];
            const selected = await ctx.ui.select(`${question.question}${picked.length ? ` (${picked.join(", ")})` : ""}`, choices);
            if (!selected || selected === "Done") break;
            picked.push(selected);
          }
          answers[question.id] = picked.length > 0 ? picked : fallbackChoice(question);
        } else {
          const labels = question.options.map((option, index) => {
            const suffix = index === question.recommended ? " (Recommended)" : "";
            return `${option.label}${suffix}`;
          });
          const selected = await ctx.ui.select(question.question, labels);
          const normalized = selected?.replace(/ \(Recommended\)$/, "");
          answers[question.id] = normalized ? [normalized] : fallbackChoice(question);
        }
        const answer = answers[question.id] ?? [];
        lines.push(`${question.id}: ${answer.join(", ") || "(no selection)"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { answers } };
    },
  });
}
