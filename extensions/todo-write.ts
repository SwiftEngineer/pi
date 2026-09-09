import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Status = "pending" | "in_progress" | "done" | "dropped";
interface TodoItem { content: string; status: Status; notes: string[] }
interface TodoPhase { name: string; items: TodoItem[] }

const state: { phases: TodoPhase[] } = { phases: [] };

const TodoOp = Type.Object({
  op: Type.Union([
    Type.Literal("init"),
    Type.Literal("start"),
    Type.Literal("done"),
    Type.Literal("drop"),
    Type.Literal("rm"),
    Type.Literal("append"),
    Type.Literal("note"),
  ]),
  list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String()) }))),
  task: Type.Optional(Type.String()),
  phase: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(Type.String())),
  text: Type.Optional(Type.String()),
});

const TodoParams = Type.Object({ ops: Type.Array(TodoOp, { description: "Todo operations to apply in order." }) });
type TodoParamsType = { ops: Array<{ op: string; list?: Array<{ phase: string; items: string[] }>; task?: string; phase?: string; items?: string[]; text?: string }> };

function findTask(content: string): TodoItem | undefined {
  for (const phase of state.phases) {
    const item = phase.items.find((candidate) => candidate.content === content);
    if (item) return item;
  }
  return undefined;
}

function findPhase(name: string): TodoPhase | undefined {
  return state.phases.find((phase) => phase.name === name);
}

function promoteNextPending(): void {
  if (state.phases.some((phase) => phase.items.some((item) => item.status === "in_progress"))) return;
  for (const phase of state.phases) {
    const next = phase.items.find((item) => item.status === "pending");
    if (next) {
      next.status = "in_progress";
      return;
    }
  }
}

function phaseDone(phase: TodoPhase): void {
  for (const item of phase.items) if (item.status !== "dropped") item.status = "done";
}

function render(): string {
  if (state.phases.length === 0) return "No todos.";
  const icon: Record<Status, string> = { pending: "○", in_progress: "→", done: "✓", dropped: "⊘" };
  const lines: string[] = [];
  let remaining = 0;
  for (const phase of state.phases) {
    lines.push(`${phase.name}:`);
    for (const item of phase.items) {
      if (item.status === "pending" || item.status === "in_progress") remaining++;
      lines.push(`  ${icon[item.status]} ${item.content}`);
      for (const note of item.notes) lines.push(`    note: ${note}`);
    }
  }
  lines.push(`Remaining items: ${remaining}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Todos are per-session scratch state; reset on every session start/reload so
  // they cannot leak across session switches in a long-lived process (mirrors
  // how extensions/subagents/index.ts rebinds on session_start).
  pi.on("session_start", () => {
    state.phases = [];
  });

  pi.registerTool({
    name: "todo_write",
    label: "Todo Write",
    description: "Maintain a phased task list for multi-step work. Use for tasks with three or more distinct steps.",
    promptSnippet: "todo_write — maintain phased task state.",
    promptGuidelines: ["Use todo_write for multi-step tasks; mark tasks done immediately after finishing them."],
    parameters: TodoParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: TodoParamsType) {
      for (const op of params.ops) {
        switch (op.op) {
          case "init":
            state.phases = (op.list ?? []).map((phase) => ({
              name: phase.phase,
              items: phase.items.map((content, index) => ({ content, status: index === 0 ? "in_progress" : "pending", notes: [] })),
            }));
            break;
          case "append": {
            if (!op.phase || !op.items) break;
            let phase = findPhase(op.phase);
            if (!phase) {
              phase = { name: op.phase, items: [] };
              state.phases.push(phase);
            }
            phase.items.push(...op.items.map((content) => ({ content, status: "pending" as Status, notes: [] })));
            promoteNextPending();
            break;
          }
          case "start": {
            if (!op.task) break;
            const item = findTask(op.task);
            if (item) item.status = "in_progress";
            break;
          }
          case "done":
            if (op.phase) {
              const phase = findPhase(op.phase);
              if (phase) phaseDone(phase);
            } else if (op.task) {
              const item = findTask(op.task);
              if (item) item.status = "done";
            }
            promoteNextPending();
            break;
          case "drop":
            if (op.phase) {
              const phase = findPhase(op.phase);
              if (phase) for (const item of phase.items) item.status = "dropped";
            } else if (op.task) {
              const item = findTask(op.task);
              if (item) item.status = "dropped";
            }
            promoteNextPending();
            break;
          case "rm":
            if (op.phase) state.phases = state.phases.filter((phase) => phase.name !== op.phase);
            else if (op.task) for (const phase of state.phases) phase.items = phase.items.filter((item) => item.content !== op.task);
            else state.phases = [];
            promoteNextPending();
            break;
          case "note": {
            if (!op.task || !op.text) break;
            const item = findTask(op.task);
            if (item) item.notes.push(op.text);
            break;
          }
        }
      }
      return { content: [{ type: "text", text: render() }], details: { phases: state.phases } };
    },
  });
}
