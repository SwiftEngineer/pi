import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SubagentFinish, type SubagentLiveUpdate, subagentRegistry } from "../subagent-view/registry.ts";

const MAX_CONCURRENCY = positiveIntFromEnv("PI_TASK_MAX_CONCURRENCY", 4);
const MAX_OUTPUT_BYTES = positiveIntFromEnv("PI_TASK_MAX_OUTPUT_BYTES", 500_000);
const MAX_OUTPUT_LINES = positiveIntFromEnv("PI_TASK_MAX_OUTPUT_LINES", 5000);
const INLINE_RESULT_BYTES = positiveIntFromEnv("PI_TASK_INLINE_RESULT_BYTES", 50 * 1024);
const INLINE_RESULT_LINES = positiveIntFromEnv("PI_TASK_INLINE_RESULT_LINES", 1000);
const MAX_RUNTIME_MS = positiveIntFromEnv("PI_TASK_MAX_RUNTIME_MS", 60 * 60_000);
const KILL_GRACE_MS = positiveIntFromEnv("PI_TASK_KILL_GRACE_MS", 5_000);
const MAX_JSON_EVENT_BYTES = positiveIntFromEnv("PI_TASK_MAX_JSON_EVENT_BYTES", 2 * 1024 * 1024);

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

const TaskItem = Type.Object({
  id: Type.String({ description: "CamelCase task id." }),
  description: Type.String({ description: "Short UI label." }),
  assignment: Type.String({ description: "Complete self-contained assignment." }),
});

const TaskParams = Type.Object({
  agent: Type.String({ description: "Agent type: explore, plan, designer, reviewer, librarian, oracle, task, or quick_task." }),
  tasks: Type.Array(TaskItem, { description: "Tasks to execute in parallel." }),
  context: Type.Optional(Type.String({ description: "Shared context prepended to every assignment." })),
});

type TaskParamsType = {
  agent: string;
  tasks: Array<{ id: string; description: string; assignment: string }>;
  context?: string;
};

type SubtaskResult = {
  id: string;
  description: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  finalText: string;
  timedOut: boolean;
  aborted: boolean;
};

type ProcessExit = { code: number; signal?: NodeJS.Signals };

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function countNewlines(text: string): number {
  let count = 0;
  let index = text.indexOf("\n");
  while (index !== -1) {
    count++;
    index = text.indexOf("\n", index + 1);
  }
  return count;
}

function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function clipToLineLimit(text: string, remainingLines: number): string {
  if (remainingLines <= 0) return "";
  let index = -1;
  for (let i = 0; i < remainingLines; i++) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) return text;
  }
  return text.slice(0, index + 1);
}

class BoundedText {
  readonly maxBytes: number;
  readonly maxLines: number;
  #parts: string[] = [];
  #bytes = 0;
  #lines = 0;
  #droppedBytes = 0;
  #droppedLines = 0;

  constructor(maxBytes: number, maxLines: number) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }

  append(text: string): void {
    if (text.length === 0) return;
    const inputBytes = Buffer.byteLength(text, "utf8");
    const inputLines = countNewlines(text);
    if (this.#bytes >= this.maxBytes || this.#lines >= this.maxLines) {
      this.#droppedBytes += inputBytes;
      this.#droppedLines += inputLines;
      return;
    }

    const byLines = clipToLineLimit(text, this.maxLines - this.#lines);
    const byBytes = utf8Head(byLines, this.maxBytes - this.#bytes);
    if (byBytes.length > 0) {
      this.#parts.push(byBytes);
      this.#bytes += Buffer.byteLength(byBytes, "utf8");
      this.#lines += countNewlines(byBytes);
    }

    const keptBytes = Buffer.byteLength(byBytes, "utf8");
    if (keptBytes < inputBytes) {
      this.#droppedBytes += inputBytes - keptBytes;
      this.#droppedLines += Math.max(0, inputLines - countNewlines(byBytes));
    }
  }

  reset(text = ""): void {
    this.#parts = [];
    this.#bytes = 0;
    this.#lines = 0;
    this.#droppedBytes = 0;
    this.#droppedLines = 0;
    this.append(text);
  }

  text(): string {
    const body = this.#parts.join("");
    if (this.#droppedBytes === 0 && this.#droppedLines === 0) return body;
    const lineNotice = this.#droppedLines > 0 ? `, ${this.#droppedLines} lines` : "";
    return `${body}\n\n[Output truncated: ${this.#droppedBytes} bytes${lineNotice} omitted.]`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(line, "utf8") > MAX_JSON_EVENT_BYTES) return undefined;
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

async function writePrompt(agentName: string, prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "swift-pi-task-"));
  const safe = agentName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const file = path.join(dir, `${safe}.md`);
  await fsp.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function piCommand(): string {
  return process.env.SWIFT_PI_COMMAND || "pi";
}

function signalExitCode(signal: NodeJS.Signals | undefined): number {
  if (!signal) return 1;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  if (signal === "SIGINT") return 130;
  return 1;
}

function killChild(child: { pid?: number | undefined; kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone or not killable; close/error handlers will settle if possible.
    }
  }
}

async function runSubtask(ctxCwd: string, agent: string, context: string | undefined, task: TaskParamsType["tasks"][number], signal: AbortSignal | undefined, onLive?: (update: SubagentLiveUpdate) => void, onMessage?: (message: AgentMessage) => void, onMeta?: (text: string) => void): Promise<SubtaskResult> {
  const config = AGENT_PROMPTS[agent] ?? AGENT_PROMPTS.task;
  if (!config) throw new Error("Built-in task agent prompt is missing.");
  const assignment = context ? `${context}\n\n${task.assignment}` : task.assignment;
  const prompt = [
    config.prompt,
    "Return only the result needed by the caller. Do not include progress narration.",
    "Keep tool output bounded: narrow searches, avoid broad gitignore:false scans, and stop if a tool reports truncation instead of retrying the same broad query.",
  ].join("\n\n");
  const temp = await writePrompt(agent, prompt);
  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", temp.file, assignment];
  const child = spawn(piCommand(), args, {
    cwd: ctxCwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const completion = Promise.withResolvers<ProcessExit>();
  const stdout = new BoundedText(MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES);
  const stderr = new BoundedText(MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES);
  const finalText = new BoundedText(INLINE_RESULT_BYTES, INLINE_RESULT_LINES);
  let buffer = "";
  let timedOut = false;
  let aborted = false;
  let terminating = false;
  let killTimer: NodeJS.Timeout | undefined;
  let forceResolveTimer: NodeJS.Timeout | undefined;
  const abortHandler = () => terminate("abort");

  const processLine = (line: string) => {
    const event = parseEvent(line);
    if (!event) return;
    const text = assistantTextFromMessageEnd(event);
    if (text) finalText.reset(text);
    // Capture every finalized message into the append-only transcript (full
    // history), separate from the lossy live tail that drives the spinner.
    if (onMessage && event.type === "message_end" && isObject(event.message)) {
      onMessage(event.message as unknown as AgentMessage);
    }
    // Surface auto-retries (transient API errors) as a transcript marker so the
    // reader sees why a turn was re-run rather than just seeing a repeated turn.
    if (onMeta && event.type === "auto_retry_start") {
      const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
      const max = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
      const where = attempt && max ? ` (attempt ${attempt}/${max})` : "";
      onMeta(`retrying after a transient error${where}`);
    }
    if (onLive) {
      const update = liveFromEvent(event);
      if (update) onLive(update);
    }
  };

  const terminate = (reason: "abort" | "timeout") => {
    if (terminating) return;
    terminating = true;
    if (reason === "abort") aborted = true;
    if (reason === "timeout") timedOut = true;
    stderr.append(reason === "timeout" ? `\n[Subtask exceeded PI_TASK_MAX_RUNTIME_MS=${MAX_RUNTIME_MS}; terminating.]\n` : "\n[Subtask aborted by parent; terminating.]\n");
    killChild(child, "SIGTERM");
    killTimer = setTimeout(() => killChild(child, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
    forceResolveTimer = setTimeout(() => completion.resolve({ code: reason === "timeout" ? 124 : 130 }), KILL_GRACE_MS + 5_000);
    forceResolveTimer.unref();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout.append(text);
    buffer += text;
    if (Buffer.byteLength(buffer, "utf8") > MAX_JSON_EVENT_BYTES) {
      buffer = "";
      stderr.append(`\n[Skipped an oversized JSON event line over ${MAX_JSON_EVENT_BYTES} bytes.]\n`);
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.append(chunk.toString("utf8"));
  });
  child.on("close", (code, signalName) => {
    if (buffer.trim()) processLine(buffer);
    const exit: ProcessExit = { code: code ?? signalExitCode(signalName ?? undefined) };
    if (signalName) exit.signal = signalName;
    completion.resolve(exit);
  });
  child.on("error", (error) => {
    stderr.append(`${error.message}\n`);
    completion.resolve({ code: 1 });
  });

  if (signal?.aborted) terminate("abort");
  else signal?.addEventListener("abort", abortHandler, { once: true });
  const runtimeTimer = setTimeout(() => terminate("timeout"), MAX_RUNTIME_MS);
  runtimeTimer.unref();

  try {
    const exit = await completion.promise;
    clearTimeout(runtimeTimer);
    if (killTimer) clearTimeout(killTimer);
    if (forceResolveTimer) clearTimeout(forceResolveTimer);
    const out = stdout.text();
    const err = stderr.text();
    const final = finalText.text() || err || out || "(no output)";
    return {
      id: task.id,
      description: task.description,
      exitCode: aborted ? 130 : timedOut ? 124 : exit.code,
      stdout: out,
      stderr: err,
      finalText: truncateInline(final),
      timedOut,
      aborted,
    };
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    clearTimeout(runtimeTimer);
    if (killTimer) clearTimeout(killTimer);
    if (forceResolveTimer) clearTimeout(forceResolveTimer);
    await fsp.rm(temp.dir, { recursive: true, force: true });
  }
}

async function mapLimit<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      const item = items[current];
      if (item !== undefined) results[current] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function failedResult(task: TaskParamsType["tasks"][number], error: unknown): SubtaskResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: task.id,
    description: task.description,
    exitCode: 1,
    stdout: "",
    stderr: message,
    finalText: message,
    timedOut: false,
    aborted: false,
  };
}

function render(results: SubtaskResult[]): string {
  const text = results.map((result) => {
    const status = result.exitCode === 0 ? "completed" : result.timedOut ? "timed out" : `failed (${result.exitCode})`;
    return `### ${result.id} — ${status}\n${result.finalText}`;
  }).join("\n\n---\n\n");
  return truncateInline(text);
}

function renderStarted(jobId: string, params: TaskParamsType): string {
  const count = params.tasks.length;
  const labels = params.tasks.map((task) => `- ${task.id}: ${task.description}`).join("\n");
  return [
    `Started ${count} background sub-agent${count === 1 ? "" : "s"} (${jobId}).`,
    "The top-level conversation can continue while they run; results will be sent back automatically when finished.",
    labels,
  ].join("\n");
}

function renderFinal(jobId: string, results: SubtaskResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0).length;
  const status = failed === 0 ? "completed" : `${failed}/${results.length} failed`;
  return truncateInline(`Background sub-agents ${jobId} ${status}.\n\n${render(results)}`);
}

type BackgroundBatch = {
  controller: AbortController;
  startedAt: number;
};

const backgroundBatches = new Map<string, BackgroundBatch>();

async function runBackgroundBatch(
  pi: ExtensionAPI,
  ctxCwd: string,
  jobId: string,
  params: TaskParamsType,
  registryIds: Map<string, string>,
  controller: AbortController,
): Promise<void> {
  try {
    const results = await mapLimit(params.tasks, MAX_CONCURRENCY, async (task) => {
      const registryId = registryIds.get(task.id);
      if (registryId) subagentRegistry.start(registryId);
      const update = registryId ? (patch: SubagentLiveUpdate) => subagentRegistry.update(registryId, patch) : undefined;
      const onMessage = registryId ? (message: AgentMessage) => subagentRegistry.appendMessage(registryId, message) : undefined;
      const onMeta = registryId ? (text: string) => subagentRegistry.appendMeta(registryId, text) : undefined;
      try {
        const result = await runSubtask(ctxCwd, params.agent, params.context, task, controller.signal, update, onMessage, onMeta);
        if (registryId) subagentRegistry.finish(registryId, finishFromResult(result));
        return result;
      } catch (error) {
        const failed = failedResult(task, error);
        if (registryId) subagentRegistry.finish(registryId, { state: "error", final: failed.finalText, exitInfo: "failed" });
        return failed;
      }
    });
    if (!backgroundBatches.has(jobId)) return;
    const failed = results.some((result) => result.exitCode !== 0);
    pi.sendMessage({
      customType: "subagent-results",
      display: true,
      content: renderFinal(jobId, results),
      details: {
        jobId,
        agent: params.agent,
        results,
        failed,
        completedAt: Date.now(),
      },
    }, { triggerTurn: true, deliverAs: "followUp" });
  } finally {
    backgroundBatches.delete(jobId);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Start one or more independent background subagents in parallel using isolated Pi processes with bounded runtime and output. Returns immediately; results are delivered back automatically.",
    promptSnippet: "task — bounded background subagents with isolated context.",
    promptGuidelines: [
      "Use task for independent background subtasks; assignments must be self-contained and subagents must skip project-wide gates/formatters.",
      "The tool returns immediately. Continue the conversation normally; when sub-agents finish, their results are delivered automatically as a follow-up message.",
      "Task output and runtime are bounded; split work narrowly instead of launching broad open-ended agents.",
    ],
    parameters: TaskParams,
    executionMode: "parallel",
    async execute(toolCallId, params: TaskParamsType, signal, _onUpdate, ctx) {
      if (params.tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks supplied." }], details: { background: true, results: [] } };
      }
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Task start aborted before any sub-agents were launched." }], details: { background: true, aborted: true, results: [] }, terminate: true };
      }

      // Keep active background agents visible across top-level turns. Once no
      // background agents are running, a new task call starts a fresh panel.
      if (subagentRegistry.counts().running === 0) subagentRegistry.reset();

      const jobId = `subagents:${toolCallId}`;
      const controller = new AbortController();
      backgroundBatches.set(jobId, { controller, startedAt: Date.now() });

      // Register every sub-agent up front so the live panel shows all of them
      // (including queued ones) as soon as the tool call begins.
      const registryIds = new Map<string, string>();
      for (const task of params.tasks) {
        const id = `${toolCallId}:${task.id}`;
        registryIds.set(task.id, id);
        subagentRegistry.add(id, task.description, params.agent);
      }

      void runBackgroundBatch(pi, ctx.cwd, jobId, params, registryIds, controller).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        for (const task of params.tasks) {
          const registryId = registryIds.get(task.id);
          if (registryId) subagentRegistry.finish(registryId, { state: "error", final: message, exitInfo: "failed" });
        }
        const stillActive = backgroundBatches.has(jobId);
        backgroundBatches.delete(jobId);
        if (!stillActive) return;
        pi.sendMessage({
          customType: "subagent-results",
          display: true,
          content: `Background sub-agents ${jobId} failed before producing results.\n\n${message}`,
          details: { jobId, agent: params.agent, failed: true, error: message, completedAt: Date.now() },
        }, { triggerTurn: true, deliverAs: "followUp" });
      });

      return {
        content: [{ type: "text", text: renderStarted(jobId, params) }],
        details: {
          background: true,
          jobId,
          agent: params.agent,
          taskIds: params.tasks.map((task) => task.id),
          startedAt: backgroundBatches.get(jobId)?.startedAt,
        },
      };
    },
  });

  pi.on("session_shutdown", () => {
    for (const batch of backgroundBatches.values()) batch.controller.abort();
    backgroundBatches.clear();
  });
}
