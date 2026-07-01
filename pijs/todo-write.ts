/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/todo-write.ts. The pure in-memory state machine
 * (findTask/findPhase/promoteNextPending/phaseDone/render + the switch) ports
 * verbatim. Adaptations forced by the QuickJS runtime:
 *  1. Drop the `@earendil-works/pi-coding-agent` type import and the typebox
 *     `Type.Object` schema; duck-type `pi`, use a plain JSON Schema object.
 *  2. Omit `promptSnippet`/`promptGuidelines`/`executionMode` — the Rust host
 *     reads only `{ name, description, label?, parameters, execute }`.
 *  3. Keep the `execute(toolCallId, params, signal, onUpdate, ctx)` five-arg
 *     signature; `signal`/`onUpdate`/`ctx` are unused here (host passes
 *     undefined).
 *  4. Per §5.6 the host validates only type/properties/required, so the `op`
 *     enum is kept in the schema as documentation but membership is ALSO
 *     validated inside `execute` (a no-op vs. the original switch, which
 *     already ignored unknown ops).
 *
 * Assumption (§9 #8): `state` is kept at module scope, exactly as in the Node
 * version (which does NOT stash it on `globalThis`). Whether PiJS re-evaluates
 * the extension per turn (resetting module state) is unconfirmed; if it does,
 * `state` would need to move to `globalThis` like the Node `subagentRegistry`.
 * Left as-is for a faithful adapter port.
 */

type Status = "pending" | "in_progress" | "done" | "dropped";
interface TodoItem { content: string; status: Status; notes: string[] }
interface TodoPhase { name: string; items: TodoItem[] }

const state: { phases: TodoPhase[] } = { phases: [] };

const VALID_OPS = new Set(["init", "start", "done", "drop", "rm", "append", "note"]);

const TodoOp = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["init", "start", "done", "drop", "rm", "append", "note"] },
    list: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phase: { type: "string" },
          items: { type: "array", items: { type: "string" } },
        },
        required: ["phase", "items"],
      },
    },
    task: { type: "string" },
    phase: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    text: { type: "string" },
  },
  required: ["op"],
};

const TodoParams = {
  type: "object",
  properties: {
    ops: { type: "array", items: TodoOp, description: "Todo operations to apply in order." },
  },
  required: ["ops"],
};
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

export default function (pi: { registerTool: (spec: unknown) => void }) {
  pi.registerTool({
    name: "todo_write",
    label: "Todo Write",
    description: "Maintain a phased task list for multi-step work. Use for tasks with three or more distinct steps.",
    parameters: TodoParams,
    async execute(_toolCallId: string, params: TodoParamsType, _signal: unknown, _onUpdate: unknown, _ctx: unknown) {
      for (const op of params.ops) {
        // §5.6: the host validates only type/properties/required, so the `op`
        // enum above is documentation; enforce membership here. Unknown ops
        // are skipped (same no-op as the original switch's implicit default).
        if (typeof op.op !== "string" || !VALID_OPS.has(op.op)) continue;
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
