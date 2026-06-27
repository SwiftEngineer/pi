import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CONCURRENCY = 4;
const OUTPUT_LIMIT = 48 * 1024;

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
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assistantTextFromEvent(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.type !== "message_end" || !isObject(parsed.message)) return undefined;
  const message = parsed.message;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const parts: string[] = [];
  for (const part of message.content) {
    if (isObject(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function truncate(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= OUTPUT_LIMIT) return text;
  let end = OUTPUT_LIMIT;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > OUTPUT_LIMIT) end--;
  return `${text.slice(0, end)}\n\n[Output truncated: ${bytes - Buffer.byteLength(text.slice(0, end), "utf8")} bytes omitted.]`;
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

async function runSubtask(ctxCwd: string, agent: string, context: string | undefined, task: TaskParamsType["tasks"][number], signal: AbortSignal | undefined): Promise<SubtaskResult> {
  const config = AGENT_PROMPTS[agent] ?? AGENT_PROMPTS.task;
  if (!config) throw new Error("Built-in task agent prompt is missing.");
  const assignment = context ? `${context}\n\n${task.assignment}` : task.assignment;
  const prompt = `${config.prompt}\n\nReturn only the result needed by the caller. Do not include progress narration.`;
  const temp = await writePrompt(agent, prompt);
  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", temp.file, assignment];
  const child = spawn(piCommand(), args, { cwd: ctxCwd, stdio: ["ignore", "pipe", "pipe"] });
  const completion = Promise.withResolvers<number>();
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let finalText = "";
  let aborted = false;

  const processLine = (line: string) => {
    const text = assistantTextFromEvent(line);
    if (text) finalText = text;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("close", (code) => {
    if (buffer.trim()) processLine(buffer);
    completion.resolve(code ?? 0);
  });
  child.on("error", (error) => {
    stderr += `${error.message}\n`;
    completion.resolve(1);
  });

  const abort = () => {
    aborted = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000).unref();
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  try {
    const exitCode = await completion.promise;
    return {
      id: task.id,
      description: task.description,
      exitCode: aborted ? 130 : exitCode,
      stdout: truncate(stdout),
      stderr: truncate(stderr),
      finalText: truncate(finalText || stderr || stdout || "(no output)"),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
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

function render(results: SubtaskResult[]): string {
  return results.map((result) => {
    const status = result.exitCode === 0 ? "completed" : `failed (${result.exitCode})`;
    return `### ${result.id} — ${status}\n${result.finalText}`;
  }).join("\n\n---\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Run one or more independent subagents in parallel using isolated Pi processes. Use for decomposable investigation or edits.",
    promptSnippet: "task — parallel subagents with isolated context.",
    promptGuidelines: ["Use task for independent subtasks; assignments must be self-contained and subagents must skip project-wide gates/formatters."],
    parameters: TaskParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: TaskParamsType, signal, _onUpdate, ctx) {
      if (params.tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks supplied." }], details: { results: [] } };
      }
      const results = await mapLimit(params.tasks, MAX_CONCURRENCY, (task) => runSubtask(ctx.cwd, params.agent, params.context, task, signal));
      const failed = results.some((result) => result.exitCode !== 0);
      return { content: [{ type: "text", text: render(results) }], details: { results }, terminate: failed };
    },
  });
}
