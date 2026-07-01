/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/ask.ts. The sequential interactive logic
 * (fallbackChoice no-UI path + multi-select loop) ports verbatim. Adaptations
 * forced by the QuickJS runtime:
 *  1. Drop the `@earendil-works/pi-coding-agent` type import and the typebox
 *     `Type.Object` schema; duck-type `pi`, use a plain JSON Schema object.
 *  2. Omit `promptSnippet`/`promptGuidelines`/`executionMode` — the Rust host
 *     reads only `{ name, description, label?, parameters, execute }`.
 *  3. Keep the `execute(toolCallId, params, signal, onUpdate, ctx)` five-arg
 *     signature; `signal`/`onUpdate` are unused (host passes undefined).
 *
 * Assumption (§9 #4): the calls `ctx.hasUI` (a field) and
 * `await ctx.ui.select(prompt, choices)` (an async method) are kept EXACTLY as
 * in the Node version. The `ctx.ui` shape under PiJS is unconfirmed — it could
 * be the same `ctx.ui.select` method or a `pi.ui("select", …)` hostcall. The
 * port preserves the likely-correct shape exactly; if the host differs, this is
 * the binding to revise (the same way the Phase-0 slice documented `ctx.cwd`).
 */

const Option = {
  type: "object",
  properties: {
    label: { type: "string" },
    description: { type: "string" },
  },
  required: ["label"],
};

const Question = {
  type: "object",
  properties: {
    id: { type: "string" },
    question: { type: "string" },
    options: { type: "array", items: Option },
    multi: { type: "boolean" },
    recommended: { type: "number" },
  },
  required: ["id", "question", "options"],
};

const AskParams = {
  type: "object",
  properties: {
    questions: { type: "array", items: Question, description: "Questions to ask the user." },
  },
  required: ["questions"],
};
type AskParamsType = { questions: Array<{ id: string; question: string; options: Array<{ label: string; description?: string }>; multi?: boolean; recommended?: number }> };

function fallbackChoice(question: AskParamsType["questions"][number]): string[] {
  if (question.options.length === 0) return [];
  const index = question.recommended !== undefined ? Math.max(0, Math.min(question.recommended, question.options.length - 1)) : 0;
  const option = question.options[index];
  return option ? [option.label] : [];
}

export default function (pi: { registerTool: (spec: unknown) => void }) {
  pi.registerTool({
    name: "ask",
    label: "Ask User",
    description: "Ask structured clarification questions with selectable options. Use only when repo context/tools cannot answer and choices have material tradeoffs.",
    parameters: AskParams,
    async execute(_toolCallId: string, params: AskParamsType, _signal: unknown, _onUpdate: unknown, ctx: { hasUI: boolean; ui: { select: (prompt: string, choices: string[]) => Promise<string> } }) {
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
