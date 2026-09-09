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
    description: "Ask structured clarification questions with selectable options. Use only when repo context/tools cannot answer and choices have material tradeoffs. Cancelling a question records no answer ('cancelled') rather than a default choice — re-ask or proceed without it.",
    promptSnippet: "ask — structured user clarification.",
    promptGuidelines: ["Default to action; use ask only when a missing choice materially changes the outcome."],
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: AskParamsType, _signal, _onUpdate, ctx) {
      const answers: Record<string, string[]> = {};
      const cancelled: string[] = [];
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
          if (picked.length > 0) answers[question.id] = picked;
          else cancelled.push(question.id);
        } else {
          // The recommendation is tracked by index: the "(Recommended)" suffix
          // is display-only, and the selection is mapped back through the
          // labels array — never stripped from the label text, which may
          // legitimately end with "(Recommended)".
          const labels = question.options.map((option, index) =>
            index === question.recommended ? `${option.label} (Recommended)` : option.label,
          );
          const selected = await ctx.ui.select(question.question, labels);
          if (selected === undefined) {
            cancelled.push(question.id); // Esc/cancel — record no answer instead of inventing one.
          } else {
            const index = labels.indexOf(selected);
            answers[question.id] = [question.options[index]?.label ?? selected];
          }
        }
        const answer = answers[question.id];
        lines.push(`${question.id}: ${answer ? answer.join(", ") : "(cancelled — no answer)"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { answers, cancelled } };
    },
  });
}
