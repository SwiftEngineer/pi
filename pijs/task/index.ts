/**
 * PiJS port (pi_agent_rust QuickJS runtime) — NON-BLOCKING background sub-agents.
 *
 * Adapted from extensions/task/index.ts. The `task` tool spawns isolated child
 * `pi --mode json` processes, streams their progress into the shared
 * `subagentRegistry`, and delivers the combined result as an autonomous
 * follow-up turn — the same contract as the Node original. All the pure logic
 * (built-in agent prompts, child-process JSON event parsing —
 * `parseEvent`/`assistantTextFromMessageEnd`/`liveFromEvent` — bounded
 * output/inline rendering, and registry population) ports faithfully.
 *
 * ── §9 #9 RESOLVED (2026-07-01): NON-BLOCKING IS NOW VIABLE ───────────────────
 * The fork host (`feat/pump-extensions`, installed as the active `pi`) calls
 * `pump_once` on a cadence BETWEEN host↔extension frames, which advances detached
 * extension JS (un-awaited promises, `setTimeout`, microtasks, and hostcalls such
 * as `pi.exec`/`pi.sendMessage`/`ctx.ui.setWidget`) while the session is NOT
 * streaming. So an un-awaited orchestration kicked off from `execute()` runs to
 * completion in the background and can deliver via `pi.sendMessage`. The old
 * BLOCKING fallback is gone.
 *
 * ── The two hard constraints the host imposes on the design ───────────────────
 *  1. The pump is GATED OFF while a turn is streaming (AgentStart..AgentDone) and
 *     each `pump_once` is capped at EXTENSION_QUERY_BUDGET_MS (10s), awaiting each
 *     hostcall inline. A single blocking `pi.exec("sh",["-c","a & b & wait"])`
 *     that runs >10s is therefore KILLED by the pump timeout AND would freeze all
 *     other background JS for its whole duration (no live updates). So children
 *     must be DETACHED: the launching `pi.exec` returns in ~0s and the children
 *     keep running as independent OS processes, polled between short pumps.
 *  2. `pi.exec` gives children `stdin = /dev/null`. Empirically `pi --mode json`
 *     only "hangs" on `> file` when it inherits a live (never-EOF) stdin; with
 *     stdin closed it writes its JSON stream to the file and exits normally. So a
 *     detached child `( pi --mode json … > out-i.json 2> err-i.json; echo $? >
 *     done-i ) </dev/null >/dev/null 2>&1 &` works and does not hold the launcher
 *     shell's stdout pipe open (its fds point at files/`/dev/null`), so the
 *     launcher `pi.exec` sees EOF immediately and returns.
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 *  - `execute()` validates, seeds the registry (pending), kicks an UN-AWAITED
 *    `orchestrate()`, and returns "Started N sub-agents" IMMEDIATELY. It never
 *    awaits a child, so it is not bounded by the ~60s tool budget.
 *  - `orchestrate()` (runs under the pump, between turns): `mkdir -p` a temp dir,
 *    launch children in PARALLEL respecting a concurrency cap, then poll: read the
 *    partial `out-i.json` files (one batched `pi.exec` per tick), feed new JSON
 *    lines through the SAME `parseEvent`/`liveFromEvent`/`assistantText…` pipeline
 *    to update the registry LIVE (drives the subagent-view strip), and watch for
 *    per-child `done-i` sentinels. On completion it finalizes the registry,
 *    `pi.sendMessage({customType:"subagent-results"}, {triggerTurn:true,
 *    deliverAs:"followUp"})`, and cleans up the temp dir.
 *  - All filesystem I/O goes through the SHELL (`pi.exec`), never `node:fs`:
 *    sandbox `node:fs` writes are discarded, and reading via a real `cat` child
 *    sidesteps any `read`-capability path-scoping. Files live under `/tmp` so the
 *    user's project tree is never touched.
 *
 * Other adaptations (unchanged from the earlier port):
 *  - typebox → plain JSON Schema; args validated inside execute() (§5.6).
 *  - `@earendil-works/*` values dropped; `AgentMessage` is a type-only import.
 *  - `node:child_process` spawn → `pi.exec` via `../_shared/exec.ts`.
 *  - The prompt is passed inline to `--append-system-prompt` (fs writes are
 *    discarded, and the flag accepts text directly).
 *  - `BoundedText` lives in `../_shared/text.ts`.
 *  - `piCommand()` resolves to `process.execPath` (the running pi binary) else
 *    `"pi"` on PATH.
 *  - ⚠ No typed private-class-field declarations anywhere (loader bug); this file
 *    uses plain functions + closures, and the only class (`BoundedText`) already
 *    uses the safe pattern in `_shared/text.ts`.
 */

import { execCommand, type ExecResult } from "../_shared/exec.ts";
import { BoundedText } from "../_shared/text.ts";
import { type SubagentFinish, type SubagentLiveUpdate, subagentRegistry } from "../subagent-view/registry.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Tuning (env is empty in the sandbox, so these degrade to the defaults; the
// env reads are kept for faithfulness in case a host ever forwards vars).
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = positiveIntFromEnv("PI_TASK_MAX_OUTPUT_BYTES", 500_000);
const MAX_OUTPUT_LINES = positiveIntFromEnv("PI_TASK_MAX_OUTPUT_LINES", 5000);
const INLINE_RESULT_BYTES = positiveIntFromEnv("PI_TASK_INLINE_RESULT_BYTES", 50 * 1024);
const INLINE_RESULT_LINES = positiveIntFromEnv("PI_TASK_INLINE_RESULT_LINES", 1000);
const MAX_JSON_EVENT_BYTES = positiveIntFromEnv("PI_TASK_MAX_JSON_EVENT_BYTES", 2 * 1024 * 1024);

/** Cap on children running at once (larger batches run in waves). */
const MAX_CONCURRENCY = positiveIntFromEnv("PI_TASK_MAX_CONCURRENCY", 4);
/** How often the background orchestration reads child progress files. */
const POLL_INTERVAL_MS = positiveIntFromEnv("PI_TASK_POLL_INTERVAL_MS", 700);
/**
 * Per-child wall-clock cap, enforced by the `timeout` coreutil wrapping each
 * child. Unlike the old blocking design there is NO ~60s tool budget here (the
 * orchestration is detached from execute()), so this is generously long.
 */
const CHILD_TIMEOUT_MS = positiveIntFromEnv("PI_TASK_CHILD_TIMEOUT_MS", 30 * 60_000);
/**
 * Overall safety budget for the whole background job. It only bounds a pathological
 * run (e.g. a sentinel that never appears); it is always larger than a child's own
 * timeout, so in normal operation every child settles via its own `done-i`.
 */
const ORCH_BUDGET_MS = positiveIntFromEnv("PI_TASK_ORCH_BUDGET_MS", CHILD_TIMEOUT_MS + 5 * 60_000);
/** Short timeout for the orchestration's own fast helper execs (mkdir/launch/read/cleanup). */
const HELPER_EXEC_TIMEOUT_MS = 8_000;

const AGENT_PROMPTS: Record<string, { description: string; prompt: string }> = {
  explore: {
    description: "Fast read-only codebase scout returning compressed context.",
    prompt: "You are a read-only codebase scout. Inspect only what is needed, do not edit files, do not run gates/formatters, and return concise source-grounded findings.",
  },
  plan: {
    description: "Software architect for multi-file implementation plans.",
    prompt: "You are a software architect. Produce concrete implementation plans grounded in the repo. Do not edit files or run gates/formatters.",
  },
  designer: {
    description: "UI/UX implementation and review specialist.",
    prompt: "You are a UI/UX specialist. Focus on polished product design, accessibility, and implementation details. Do not run gates/formatters.",
  },
  reviewer: {
    description: "Code review specialist for correctness, security, and maintainability.",
    prompt: "You are a code reviewer. Look for correctness, security, reliability, and maintainability issues. Do not edit files or run gates/formatters.",
  },
  librarian: {
    description: "External library/API researcher.",
    prompt: "You are a library researcher. Read primary source/docs and return definitive source-grounded API facts. Do not edit files or run gates/formatters.",
  },
  oracle: {
    description: "Senior engineer for debugging, architecture, and implementation advice.",
    prompt: "You are a senior engineer. Solve hard debugging and architecture problems concretely. If editing is requested, keep changes targeted and do not run project-wide gates/formatters.",
  },
  task: {
    description: "General-purpose implementation subagent.",
    prompt: "You are a general-purpose coding subagent. Follow the assignment exactly, edit only targeted files, and do not run project-wide gates/formatters.",
  },
  quick_task: {
    description: "Mechanical low-reasoning update or collection agent.",
    prompt: "You are a mechanical task runner. Perform only the explicitly requested simple update or collection. Do not run gates/formatters.",
  },
};

// ---------------------------------------------------------------------------
// Schema (plain JSON Schema — host validates only type/properties/required; the
// real checks live in validateParams, §5.6)
// ---------------------------------------------------------------------------

const TaskParams = {
  type: "object",
  properties: {
    agent: {
      type: "string",
      description: "Agent type: explore, plan, designer, reviewer, librarian, oracle, task, or quick_task.",
    },
    tasks: {
      type: "array",
      description: "Tasks to run in parallel as background sub-agents; results are delivered automatically when they finish.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "CamelCase task id." },
          description: { type: "string", description: "Short UI label." },
          assignment: { type: "string", description: "Complete self-contained assignment." },
        },
        required: ["id", "description", "assignment"],
      },
    },
    context: { type: "string", description: "Shared context prepended to every assignment." },
  },
  required: ["agent", "tasks"],
};

interface TaskInput {
  agent: string;
  tasks: Array<{ id: string; description: string; assignment: string }>;
  context: string | undefined;
}

type SubtaskResult = {
  id: string;
  description: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  finalText: string;
  timedOut: boolean;
  aborted: boolean;
  /** True when the task was never launched (should not happen; kept for parity). */
  skipped: boolean;
};

interface RegistryHooks {
  onLive?: (update: SubagentLiveUpdate) => void;
  onMessage?: (message: AgentMessage) => void;
  onMeta?: (text: string) => void;
}

/** Mutable per-child state carried across poll ticks. */
interface ChildState {
  index: number;
  task: TaskInput["tasks"][number];
  registryId: string;
  hooks: RegistryHooks;
  finalText: BoundedText;
  stdout: BoundedText;
  /** How many chars of the (append-only) out-file have already been processed. */
  processedChars: number;
  launched: boolean;
  finished: boolean;
  result: SubtaskResult | undefined;
}

// ---------------------------------------------------------------------------
// Small helpers (ported from the Node version)
// ---------------------------------------------------------------------------

function positiveIntFromEnv(name: string, fallback: number): number {
  let raw: unknown;
  try {
    raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
  } catch {
    raw = undefined;
  }
  if (typeof raw !== "string" || !raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolve the pi binary: the running executable if it is `pi`, else `pi` on PATH. */
function piCommand(): string {
  try {
    const ep = (globalThis as { process?: { execPath?: unknown } }).process?.execPath;
    if (typeof ep === "string" && ep) {
      const base = ep.split(/[\\/]/).pop() ?? "";
      if (base === "pi" || base === "pi.exe") return ep;
    }
  } catch {
    // fall through to PATH
  }
  return "pi";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** POSIX single-quote escaping so arbitrary user/model text is a safe shell literal. */
function shQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  if (byteLength(line) > MAX_JSON_EVENT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isObject(parsed) ? parsed : undefined;
}

function assistantTextFromMessageEnd(event: Record<string, unknown>): string | undefined {
  if (event.type !== "message_end" || !isObject(event.message)) return undefined;
  const message = event.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (isObject(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Derive a live panel update from a single JSON event line, if any. */
function liveFromEvent(event: Record<string, unknown>): SubagentLiveUpdate | undefined {
  switch (event.type) {
    case "turn_start":
      return { phase: "thinking" };
    case "message_start":
      return { resetText: true, phase: "writing" };
    case "message_update": {
      const ev = event.assistantMessageEvent;
      if (!isObject(ev)) return undefined;
      if (ev.type === "text_delta" && typeof ev.delta === "string") return { appendText: ev.delta, phase: "writing" };
      if (ev.type === "thinking_delta" && typeof ev.delta === "string") return { appendThinking: ev.delta, phase: "reasoning" };
      return undefined;
    }
    case "tool_execution_start": {
      const tool = typeof event.toolName === "string" ? event.toolName : undefined;
      return { tool: tool ?? null, phase: tool ? `using ${tool}` : "running" };
    }
    case "tool_execution_end":
      return { tool: null, phase: "working" };
    case "agent_end":
      return { phase: "done" };
    default:
      return undefined;
  }
}

/** Map a settled subtask to its registry finish payload. */
function finishFromResult(result: SubtaskResult): SubagentFinish {
  if (result.exitCode === 0) return { state: "done", final: result.finalText, exitInfo: "completed" };
  const exitInfo = result.timedOut
    ? "timed out"
    : result.aborted
      ? "aborted"
      : `failed (${result.exitCode})`;
  return { state: "error", final: result.finalText, exitInfo };
}

function truncateInline(text: string): string {
  const out = new BoundedText(INLINE_RESULT_BYTES, INLINE_RESULT_LINES);
  out.append(text);
  return out.text();
}

/** Apply one captured child JSON event line to finalText + the registry hooks. */
function processLine(line: string, finalText: BoundedText, hooks: RegistryHooks): void {
  const event = parseEvent(line);
  if (!event) return;
  const text = assistantTextFromMessageEnd(event);
  if (text) finalText.reset(text);
  if (hooks.onMessage && event.type === "message_end" && isObject(event.message)) {
    hooks.onMessage(event.message as unknown as AgentMessage);
  }
  if (hooks.onMeta && event.type === "auto_retry_start") {
    const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
    const max = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
    const where = attempt && max ? ` (attempt ${attempt}/${max})` : "";
    hooks.onMeta(`retrying after a transient error${where}`);
  }
  if (hooks.onLive) {
    const update = liveFromEvent(event);
    if (update) hooks.onLive(update);
  }
}

/**
 * Feed newly-appended lines of a child's (append-only) out-file into the
 * registry, EXACTLY ONCE. `full` is the whole current file content; `state`
 * tracks how many chars were already consumed, so re-reading the full file each
 * tick never double-counts. During streaming we only drain up to the last
 * newline (the trailing partial line may still be mid-write); on `finalDrain`
 * (child settled) the trailing line is complete, so we drain the remainder too —
 * this recovers a final `message_end` flushed in the sub-ms window between a
 * poll's `cat` and its `done` check.
 */
function drainNewLines(state: ChildState, full: string, finalDrain: boolean): void {
  if (full.length <= state.processedChars) return;
  const fresh = full.slice(state.processedChars);
  let complete: string;
  if (finalDrain) {
    complete = fresh;
  } else {
    const lastNl = fresh.lastIndexOf("\n");
    if (lastNl < 0) return;
    complete = fresh.slice(0, lastNl + 1);
  }
  state.stdout.append(complete);
  for (const line of complete.split("\n")) {
    if (line) processLine(line, state.finalText, state.hooks);
  }
  state.processedChars += complete.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shell command construction (children + progress reads — all FS via the shell)
// ---------------------------------------------------------------------------

function outPath(dir: string, i: number): string {
  return `${dir}/out-${i}.json`;
}
function errPath(dir: string, i: number): string {
  return `${dir}/err-${i}.json`;
}
function donePath(dir: string, i: number): string {
  return `${dir}/done-${i}`;
}
function pidPath(dir: string, i: number): string {
  return `${dir}/pid-${i}`;
}

/**
 * A detached child: `timeout`-bounded `pi --mode json`, stdout/stderr → files,
 * exit code → the `done-i` sentinel. `setsid` puts the child in its OWN session /
 * process group (leader pid == pgid), and the leader records its own `$$` to a
 * `pid-i` file so a `session_shutdown` handler can `kill -TERM -<pid>` the whole
 * group (best-effort abort of in-flight children — Node parity). The child has
 * stdin closed and its own std streams → `/dev/null`, so it does NOT hold the
 * launcher shell's stdout pipe open — the launching `pi.exec` returns
 * immediately. The literal `--` ends option parsing so an assignment beginning
 * with `-`/`--` is a positional, never an injected pi flag.
 */
function buildChildScript(dir: string, i: number, promptText: string, assignment: string): string {
  const timeoutSec = Math.max(1, Math.round(CHILD_TIMEOUT_MS / 1000));
  const inner = [
    `echo $$ > ${shQuote(pidPath(dir, i))}`,
    `timeout ${timeoutSec} ${shQuote(piCommand())} --mode json -p --no-session --append-system-prompt ${shQuote(promptText)} -- ${shQuote(assignment)} > ${shQuote(outPath(dir, i))} 2> ${shQuote(errPath(dir, i))}`,
    `echo $? > ${shQuote(donePath(dir, i))}`,
  ].join("; ");
  return `setsid sh -c ${shQuote(inner)} < /dev/null > /dev/null 2>&1 &`;
}

/**
 * One batched read of every active child's out-file plus its done-sentinel,
 * framed by a random boundary that cannot occur in the JSON stream. Each file's
 * FULL current content is emitted (the orchestration slices off already-processed
 * chars); sentinels are emitted as `i=<exitcode>` lines after a `SENT` marker.
 */
function buildReadScript(dir: string, activeIndices: number[], boundary: string): string {
  const parts: string[] = [];
  for (const i of activeIndices) {
    parts.push(`printf '\\n%s#%s\\n' ${shQuote(boundary)} ${shQuote(String(i))}`);
    parts.push(`cat ${shQuote(outPath(dir, i))} 2>/dev/null || true`);
  }
  parts.push(`printf '\\n%s#SENT\\n' ${shQuote(boundary)}`);
  for (const i of activeIndices) {
    parts.push(
      `if [ -f ${shQuote(donePath(dir, i))} ]; then printf '%s=%s\\n' ${shQuote(String(i))} "$(cat ${shQuote(donePath(dir, i))} 2>/dev/null)"; fi`,
    );
  }
  return parts.join("\n");
}

/** Parse a batched read into per-child full content + settled exit codes. */
function parseReadOutput(stdout: string, boundary: string): { contents: Map<number, string>; sentinels: Map<number, number> } {
  const contents = new Map<number, string>();
  const sentinels = new Map<number, number>();
  const parts = stdout.split(`\n${boundary}#`);
  for (let k = 1; k < parts.length; k++) {
    const piece = parts[k] ?? "";
    const nl = piece.indexOf("\n");
    if (nl < 0) continue;
    const key = piece.slice(0, nl);
    const body = piece.slice(nl + 1);
    if (key === "SENT") {
      for (const line of body.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const idx = Number.parseInt(line.slice(0, eq), 10);
        const code = Number.parseInt(line.slice(eq + 1), 10);
        if (Number.isInteger(idx)) sentinels.set(idx, Number.isFinite(code) ? code : 1);
      }
    } else {
      const idx = Number.parseInt(key, 10);
      if (Number.isInteger(idx)) contents.set(idx, body);
    }
  }
  return { contents, sentinels };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(results: SubtaskResult[]): string {
  const text = results.map((result) => {
    const status = result.exitCode === 0
      ? "completed"
      : result.skipped
        ? "skipped"
        : result.timedOut
          ? "timed out"
          : `failed (${result.exitCode})`;
    return `### ${result.id} — ${status}\n${result.finalText}`;
  }).join("\n\n---\n\n");
  return truncateInline(text);
}

function renderStarted(jobId: string, input: TaskInput): string {
  const count = input.tasks.length;
  const labels = input.tasks.map((task) => `- ${task.id}: ${task.description}`).join("\n");
  return [
    `Started ${count} background sub-agent${count === 1 ? "" : "s"} (${jobId}).`,
    "The top-level conversation can continue while they run; their combined results will be delivered automatically as a follow-up message when they finish.",
    labels,
  ].join("\n");
}

function renderFinal(jobId: string, results: SubtaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0).length;
  const status = failed === 0 ? "completed" : `${failed}/${results.length} failed`;
  return truncateInline(`Background sub-agents ${jobId} ${status}.\n\n${render(results)}`);
}

// ---------------------------------------------------------------------------
// Validation (§5.6)
// ---------------------------------------------------------------------------

function validateParams(raw: unknown): TaskInput | string {
  if (!isObject(raw)) return "task parameters must be an object with 'agent' and 'tasks'.";
  const agentRaw = raw.agent;
  const agent = typeof agentRaw === "string" && agentRaw.trim() ? agentRaw : "task";
  if (!Array.isArray(raw.tasks)) return "tasks must be an array of { id, description, assignment }.";
  const tasks: TaskInput["tasks"] = [];
  for (const t of raw.tasks) {
    if (!isObject(t)) return "each task must be an object with id, description, assignment.";
    const id = t.id;
    const description = t.description;
    const assignment = t.assignment;
    if (typeof id !== "string" || !id.trim()) return "each task.id must be a non-empty string.";
    if (typeof description !== "string") return "each task.description must be a string.";
    if (typeof assignment !== "string" || !assignment.trim()) return "each task.assignment must be a non-empty string.";
    tasks.push({ id, description, assignment });
  }
  const context = typeof raw.context === "string" ? raw.context : undefined;
  return { agent, tasks, context };
}

// ---------------------------------------------------------------------------
// Background orchestration (runs UN-AWAITED under the host pump)
// ---------------------------------------------------------------------------

interface PiApi {
  exec: (command: string, args: string[], options?: unknown) => Promise<unknown>;
  sendMessage?: (message: unknown, options?: unknown) => void;
}

function buildPromptText(agent: string): string {
  const config = AGENT_PROMPTS[agent] ?? AGENT_PROMPTS.task;
  const base = config?.prompt ?? AGENT_PROMPTS.task!.prompt;
  return [
    base,
    "Return only the result needed by the caller. Do not include progress narration.",
    "Keep tool output bounded: narrow searches, avoid broad gitignore:false scans, and stop if a tool reports truncation instead of retrying the same broad query.",
  ].join("\n\n");
}

/** Track live-running jobs so a stale reaper can settle a crashed batch. */
const activeJobs = new Set<string>();

/**
 * Live batches keyed by jobId, so a `session_shutdown` handler can abort any
 * in-flight children (Node parity). `count` is the number of children launched
 * with a `pid-i` file to look for.
 */
interface BatchInfo {
  dir: string;
  cwd: string;
  count: number;
}
const activeBatches = new Map<string, BatchInfo>();

/**
 * Best-effort abort of any still-live children of a batch on session shutdown:
 * read each `pid-i` (the setsid group-leader pid) and `kill -TERM -<pid>` the
 * whole process group, then remove the batch files. `kill`/`rm -f`/`rmdir` all
 * pass the host's exec mediation (only `rm -rf` / `kill -9 <pid1>` etc. are
 * denied). Runs from the shutdown event frame; if the extension runtime is torn
 * down before it dispatches, the child `timeout` wrapper remains the backstop.
 */
async function abortBatch(pi: PiApi, info: BatchInfo): Promise<void> {
  const { dir, cwd, count } = info;
  const kills: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const pf = shQuote(pidPath(dir, i));
    // SAFETY: only kill if the recorded pid is STILL our child — verified by its
    // `/proc/<pid>/cmdline` containing this batch's unique dir token. Without this
    // guard a reused/foreign pid could be signalled (a real hazard, since the
    // leader is a process-group leader and we send a group kill). The guard also
    // makes this a no-op where `/proc` is absent (e.g. macOS), falling back to the
    // child `timeout`. The leader is a `setsid` group leader, so `-"$P"` (negative
    // = process group) tears down the whole `sh`→`timeout`→`pi` tree.
    kills.push(
      `if [ -f ${pf} ]; then P="$(cat ${pf} 2>/dev/null)"; if [ -n "$P" ] && tr '\\0' ' ' < /proc/"$P"/cmdline 2>/dev/null | grep -qF ${shQuote(dir)}; then kill -TERM -"$P" 2>/dev/null || true; fi; fi`,
    );
    files.push(shQuote(outPath(dir, i)), shQuote(errPath(dir, i)), shQuote(donePath(dir, i)), pf);
  }
  const script = `${kills.join("\n")}\nrm -f ${files.join(" ")} 2>/dev/null; rmdir ${shQuote(dir)} 2>/dev/null || true`;
  try {
    await execCommand("sh", ["-c", script], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);
  } catch {
    // Best-effort; the per-child `timeout` bounds any survivor.
  }
}

async function orchestrate(
  pi: PiApi,
  cwd: string,
  jobId: string,
  dir: string,
  input: TaskInput,
  states: ChildState[],
): Promise<void> {
  const boundary = `__PIsub_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}__`;
  const promptText = buildPromptText(input.agent);
  const deadline = Date.now() + ORCH_BUDGET_MS;
  let nextToLaunch = 0;
  let cleaned = false;
  let delivered = false;

  const cleanupDir = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // NOTE: the host's exec mediation DENIES `rm -rf` (recursive-delete class),
    // so we remove the known files with non-recursive `rm -f` and drop the (now
    // empty) dir with `rmdir` — both pass mediation.
    const files: string[] = [];
    for (const s of states) files.push(shQuote(outPath(dir, s.index)), shQuote(errPath(dir, s.index)), shQuote(donePath(dir, s.index)), shQuote(pidPath(dir, s.index)));
    try {
      await execCommand("sh", ["-c", `rm -f ${files.join(" ")} 2>/dev/null; rmdir ${shQuote(dir)} 2>/dev/null || true`], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);
    } catch {
      // Best-effort; /tmp is reclaimed by the OS regardless.
    }
  };

  const activeIndices = (): number[] =>
    states.filter((s) => s.launched && !s.finished).map((s) => s.index);
  const runningCount = (): number => activeIndices().length;
  const allFinished = (): boolean => states.every((s) => s.finished);

  const finalizeChild = async (state: ChildState, code: number, forced: boolean): Promise<void> => {
    // Settle-time re-read: the child has exited (or is being force-settled), so
    // do one more bounded read of out-i.json and drain any lines the last poll's
    // `cat` missed (a final message_end can land between that cat and the `done`
    // check). `drainNewLines` is exactly-once via `state.processedChars`.
    const fullOut = await readOut(pi, dir, state.index, cwd);
    drainNewLines(state, fullOut, true);
    const errText = await readErr(pi, dir, state.index, cwd);
    const out = state.stdout.text();
    const timedOut = forced || code === 124;
    const final = state.finalText.text() || errText || out || (forced ? "(sub-agent did not finish before the task budget)" : "(no output)");
    const result: SubtaskResult = {
      id: state.task.id,
      description: state.task.description,
      exitCode: forced ? (code || 124) : code,
      stdout: out,
      stderr: errText,
      finalText: truncateInline(final),
      timedOut,
      aborted: false,
      skipped: false,
    };
    state.result = result;
    state.finished = true;
    const finish = timedOut && result.exitCode !== 0
      ? { state: "error" as const, final: result.finalText, exitInfo: forced ? "timed out (task budget)" : "timed out" }
      : finishFromResult(result);
    subagentRegistry.finish(state.registryId, finish);
  };

  try {
    await execCommand("sh", ["-c", `mkdir -p ${shQuote(dir)}`], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);

    while (!allFinished()) {
      // Launch up to the concurrency cap.
      while (runningCount() < MAX_CONCURRENCY && nextToLaunch < states.length) {
        const state = states[nextToLaunch++];
        if (!state) continue;
        const script = buildChildScript(dir, state.index, promptText, state.task.assignment);
        try {
          await execCommand("sh", ["-c", script], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);
          state.launched = true;
          subagentRegistry.start(state.registryId);
        } catch (error) {
          // Spawn failure: settle immediately so the batch can complete.
          const message = error instanceof Error ? error.message : String(error);
          state.launched = true;
          state.finalText.reset(message);
          await finalizeChild(state, 1, false);
        }
      }

      if (allFinished()) break;
      await sleep(POLL_INTERVAL_MS);

      const active = activeIndices();
      if (active.length > 0) {
        let read: ExecResult | undefined;
        try {
          read = await execCommand("sh", ["-c", buildReadScript(dir, active, boundary)], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);
        } catch {
          read = undefined;
        }
        if (read) {
          const { contents, sentinels } = parseReadOutput(read.stdout, boundary);
          // 1) Feed new complete lines from each active child into the registry LIVE.
          //    `contents.get(i)` is the child's FULL out-file content each tick; we
          //    slice off already-processed chars, so the per-tick cost is O(file
          //    size) — acceptable because it is bounded by the child's own output
          //    (BoundedText caps) over a short-lived run (Finding 3 / not reworked
          //    into byte-range reads by design).
          for (const i of active) {
            const state = states[i];
            if (state) drainNewLines(state, contents.get(i) ?? "", false);
          }
          // 2) Settle any child whose sentinel appeared (finalizeChild re-reads to
          //    recover any tail flushed between this tick's cat and its done check).
          for (const i of active) {
            const state = states[i];
            if (state && sentinels.has(i)) await finalizeChild(state, sentinels.get(i) ?? 1, false);
          }
        }
      }

      // Overall safety budget: force-settle anything still running.
      if (Date.now() > deadline) {
        for (const state of states) {
          if (state.launched && !state.finished) await finalizeChild(state, 124, true);
          if (!state.launched && !state.finished) {
            state.finalText.reset("skipped: task budget exhausted before this sub-agent could run.");
            state.finished = true;
            state.result = {
              id: state.task.id,
              description: state.task.description,
              exitCode: 1,
              stdout: "",
              stderr: "",
              finalText: state.finalText.text(),
              timedOut: false,
              aborted: false,
              skipped: true,
            };
            subagentRegistry.finish(state.registryId, { state: "error", final: state.result.finalText, exitInfo: "skipped (task budget)" });
          }
        }
        break;
      }
    }

    const results: SubtaskResult[] = states.map((s) => s.result ?? {
      id: s.task.id,
      description: s.task.description,
      exitCode: 1,
      stdout: "",
      stderr: "",
      finalText: "(sub-agent produced no result)",
      timedOut: false,
      aborted: false,
      skipped: false,
    });
    // Clean up BEFORE delivering: sendMessage(triggerTurn) makes the session
    // busy, which pauses the pump, so a cleanup queued after delivery would not
    // dispatch until the follow-up turn ends (and is lost if the session exits).
    await cleanupDir();
    // Exactly-once delivery: mark BEFORE the send so that if pi.sendMessage
    // throws, the catch branch below does not emit a SECOND (failure) message.
    if (!delivered) {
      delivered = true;
      deliverResults(pi, jobId, input.agent, results);
    }
  } catch (error) {
    // Orchestration itself failed: settle any unfinished children and report —
    // but only if we haven't already delivered a result (exactly-once).
    const message = error instanceof Error ? error.message : String(error);
    for (const state of states) {
      if (!state.finished) {
        state.finished = true;
        subagentRegistry.finish(state.registryId, { state: "error", final: message, exitInfo: "failed" });
      }
    }
    if (!delivered && typeof pi.sendMessage === "function") {
      delivered = true;
      try {
        pi.sendMessage(
          {
            customType: "subagent-results",
            display: true,
            content: `Background sub-agents ${jobId} failed before producing results.\n\n${message}`,
            details: { jobId, agent: input.agent, failed: true, error: message, completedAt: Date.now() },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        // best-effort; never throw out of the background orchestration.
      }
    }
  } finally {
    activeJobs.delete(jobId);
    activeBatches.delete(jobId);
    // Backup cleanup for the error/timeout paths (no-op if already cleaned).
    await cleanupDir();
  }
}

/** Read a child's stderr file (best-effort) for the failure/no-output fallback. */
async function readErr(pi: PiApi, dir: string, i: number, cwd: string): Promise<string> {
  try {
    const r = await execCommand("sh", ["-c", `cat ${shQuote(errPath(dir, i))} 2>/dev/null || true`], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);
    const bounded = new BoundedText(MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES);
    bounded.append(r.stdout);
    return bounded.text();
  } catch {
    return "";
  }
}

/** Read a child's out-file in full (best-effort) for the settle-time tail drain. */
async function readOut(pi: PiApi, dir: string, i: number, cwd: string): Promise<string> {
  try {
    const r = await execCommand("sh", ["-c", `cat ${shQuote(outPath(dir, i))} 2>/dev/null || true`], { cwd, timeoutMs: HELPER_EXEC_TIMEOUT_MS }, pi);
    return r.stdout;
  } catch {
    return "";
  }
}

function deliverResults(pi: PiApi, jobId: string, agent: string, results: SubtaskResult[]): void {
  if (typeof pi.sendMessage !== "function") return;
  const failed = results.some((result) => result.exitCode !== 0);
  pi.sendMessage(
    {
      customType: "subagent-results",
      display: true,
      content: renderFinal(jobId, results),
      details: { jobId, agent, results, failed, completedAt: Date.now() },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

interface ProviderApi extends PiApi {
  registerTool: (spec: unknown) => void;
  on?: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
}

/**
 * Reap crashed "ghost" records. The registry lives on `globalThis`, so if a
 * prior background job was hard-killed (session shutdown mid-run) its records
 * never `finish()` — a stale pending/running entry would keep `counts().running
 * > 0` forever and permanently block `reset()`. Settle any pending/running record
 * whose `startedAt` is older than `ORCH_BUDGET_MS` — the maximum a live job can
 * run, so such a record cannot belong to a still-active batch — letting a fresh
 * call `reset()` cleanly. (Records from a job that is genuinely still in flight
 * are younger than the budget and are left untouched.)
 */
function reapStaleGhosts(): void {
  const now = Date.now();
  for (const snap of subagentRegistry.list()) {
    if ((snap.state === "pending" || snap.state === "running") && now - snap.startedAt > ORCH_BUDGET_MS) {
      subagentRegistry.finish(snap.id, {
        state: "error",
        final: snap.final ?? "sub-agent did not settle (a prior background job was interrupted).",
        exitInfo: "interrupted",
      });
    }
  }
}

export default function (pi: ProviderApi) {
  // Best-effort parity with Node: abort in-flight children when the session
  // shuts down, so they don't orphan for up to CHILD_TIMEOUT_MS. (The child
  // `timeout` wrapper is the backstop if this doesn't dispatch in time.)
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", () => {
      const batches = [...activeBatches.values()];
      activeBatches.clear();
      for (const info of batches) void abortBatch(pi, info);
    });
  }

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Start one or more independent background sub-agents (isolated Pi processes) in parallel. Returns immediately; their combined results are delivered automatically as a follow-up message when they finish. Keep assignments self-contained and narrow.",
    parameters: TaskParams,
    async execute(toolCallId: string, rawParams: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd?: string }) {
      const validated = validateParams(rawParams);
      if (typeof validated === "string") {
        return { content: [{ type: "text", text: validated }], details: { background: false, error: validated, results: [] } };
      }
      const { agent, tasks, context } = validated;
      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks supplied." }], details: { background: false, results: [] } };
      }

      // Reap ghosts from an interrupted prior job, then keep active sub-agents
      // visible across turns; a fresh call with none running starts a new panel.
      reapStaleGhosts();
      if (subagentRegistry.counts().running === 0) subagentRegistry.reset();

      const jobId = `subagents:${toolCallId}`;
      const cwd = ctx && typeof ctx.cwd === "string"
        ? ctx.cwd
        : ((pi as { process?: { cwd?: () => string } }).process?.cwd?.() ?? ".");

      // Seed the registry (pending) so the strip shows every sub-agent immediately.
      const states: ChildState[] = tasks.map((task, index) => {
        const registryId = `${toolCallId}:${task.id}`;
        subagentRegistry.add(registryId, task.description, agent);
        const hooks: RegistryHooks = {
          onLive: (update) => subagentRegistry.update(registryId, update),
          onMessage: (message) => subagentRegistry.appendMessage(registryId, message),
          onMeta: (text) => subagentRegistry.appendMeta(registryId, text),
        };
        return {
          index,
          task,
          registryId,
          hooks,
          finalText: new BoundedText(INLINE_RESULT_BYTES, INLINE_RESULT_LINES),
          stdout: new BoundedText(MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES),
          processedChars: 0,
          launched: false,
          finished: false,
          result: undefined,
        };
      });

      // Prepend shared context to each assignment (per Node).
      if (context) {
        for (const state of states) state.task = { ...state.task, assignment: `${context}\n\n${state.task.assignment}` };
      }

      // Unique /tmp scratch dir; sanitize the tool-call id and add entropy.
      const safeId = toolCallId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
      const dir = `/tmp/pi-subagents-${safeId}-${Math.random().toString(36).slice(2, 10)}`;

      // Kick the UN-AWAITED background orchestration. It runs under the host pump
      // (between turns) and does not block this frame; execute() returns now.
      activeJobs.add(jobId);
      activeBatches.set(jobId, { dir, cwd, count: tasks.length });
      void orchestrate(pi, cwd, jobId, dir, { agent, tasks, context }, states).catch(() => {
        // orchestrate() already reports its own failures via sendMessage; this
        // guard only prevents an unhandled rejection.
        activeJobs.delete(jobId);
        activeBatches.delete(jobId);
      });

      return {
        content: [{ type: "text", text: renderStarted(jobId, { agent, tasks, context }) }],
        details: {
          background: true,
          jobId,
          agent,
          taskIds: tasks.map((task) => task.id),
          startedAt: Date.now(),
        },
      };
    },
  });
}
