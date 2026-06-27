/**
 * Background subagents.
 *
 * Replaces the blocking `task` tool. In interactive TUI mode the tool spawns
 * detached child `pi` processes and returns a dispatch acknowledgement
 * immediately, keeping the parent interactive (Feature 1). Each agent's status
 * and full message log is tracked in an in-memory registry derived from the
 * child's `--mode json` event stream, surfaced as a live indicator line below
 * the prompt (Feature 2). Hotkeys move a selector across indicators, open a
 * session-replay overlay, and abort the selected in-flight agent (Features 2 &
 * 3). On completion each result is auto-delivered to the parent as a custom
 * follow-up message (D3), and terminal records persist as session entries so
 * history survives reloads and session switches (D8).
 *
 * In non-interactive modes (json/print/rpc) the tool falls back to blocking
 * execution and returns aggregated results directly (D2), because those
 * processes exit when the turn ends and background delivery would be lost.
 *
 * Nesting is prevented at the capability level (D10): children are spawned with
 * SWIFT_PI_SUBAGENT=1, and when that variable is set this extension registers
 * nothing at all.
 *
 * Design decisions D1–D11 in openspec/changes/background-subagents/design.md are
 * binding; inline references point at the relevant one.
 *
 * Hotkeys (chosen to avoid collisions with pi's built-in keybindings — alt+,
 * alt+. alt+o alt+x are all unbound by the default TUI):
 *   alt+,  select previous indicator (wrap)
 *   alt+.  select next indicator (wrap)
 *   alt+o  open the selected agent's session-replay overlay
 *   alt+x  abort the selected in-flight agent
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  type Focusable,
  Key,
  Markdown,
  matchesKey,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AGENT_PROMPTS, type AgentStatus, isTerminalStatus, PARENT_GLYPH, STATUS_META, typeGlyph } from "./agents.ts";

// ─── constants ──────────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 4;
const OUTPUT_LIMIT = 48 * 1024;
const WIDGET_KEY = "subagents-indicator";
const RESULT_TYPE = "subagent_result";
const DISPATCH_ENTRY = "subagent_dispatch";
const COMPLETION_ENTRY = "subagent_completion";
const SIGKILL_ESCALATION_MS = 5_000;
const SHUTDOWN_GRACE_MS = 300;

// ─── types ──────────────────────────────────────────────────────────────────

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface AgentRecord {
  id: string;
  type: string;
  /** Short UI label (task.description). */
  task: string;
  /** Full self-contained assignment sent to the child. */
  assignment: string;
  status: AgentStatus;
  messages: Message[];
  usage: UsageStats;
  spawnedAt: number;
  model: string | undefined;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  stderr: string;
  /** Restored dispatch with no completion entry (pi exited mid-run). */
  lost: boolean;
  finalized: boolean;
  abortRequested: boolean;
  child: ChildProcess | undefined;
}

interface DispatchData {
  id: string;
  type: string;
  task: string;
  assignment: string;
  spawnedAt: number;
}

interface CompletionData {
  id: string;
  status: AgentStatus;
  messages: Message[];
  usage: UsageStats;
  model: string | undefined;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  stderr: string;
  lost: boolean;
}

interface ResultDetails {
  id: string;
  type: string;
  task: string;
  status: AgentStatus;
  usage: UsageStats;
  model: string | undefined;
}

// ─── module-scope live state (D6) ─────────────────────────────────────────────
//
// Background callbacks read ONLY `current`, never a captured `ctx`. The
// reference is overwritten on every session_start; a captured ctx would throw
// via assertActive after a reload/switch and crash pi.

let current: { ctx: ExtensionContext; pi: ExtensionAPI } | undefined;

/** Insertion-ordered registry of every dispatched agent this session. */
const registry = new Map<string, AgentRecord>();

/** Selector: 0 = parent, 1..n = agents in registry insertion order. */
let selectedIndex = 0;
let idCounter = 0;

// ─── guarded background dispatcher (D7) ───────────────────────────────────────
//
// Every child-stdout / completion / timeout / repaint callback runs through
// `guard`; an uncaught throw in a background callback crashes the process.

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    // Contained: a background callback must never propagate (D7). Best-effort
    // surfacing without risking a second throw.
    try {
      current?.ctx.ui.notify("subagents: background error (contained)", "warning");
    } catch {
      /* ignore */
    }
  }
}

// ─── child process invocation ─────────────────────────────────────────────────

/**
 * Resolve how to launch a child pi. Preserves the SWIFT_PI_COMMAND override
 * used by tests/e2e, otherwise mirrors the official example's runtime
 * resolution (re-exec the current script under the current runtime; fall back
 * to a `pi` on PATH).
 */
function piInvocation(args: string[]): { command: string; args: string[] } {
  const override = process.env.SWIFT_PI_COMMAND;
  if (override) return { command: override, args };

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

async function writePrompt(agentName: string, prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "swift-pi-subagent-"));
  const safe = agentName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const file = path.join(dir, `${safe}.md`);
  await fsp.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function newUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Child-runner core (shared by dispatch and blocking paths). Spawns one child
 * pi, streams its `--mode json` events, and mutates `record` live:
 *   - message_start (assistant)  → status "thinking" (D: use start events)
 *   - tool_execution_start       → status "working"
 *   - message_end (assistant)    → capture message + usage/model/stopReason
 *   - message_end (toolResult)   → capture tool result for replay
 * Resolves when the child closes, having set a terminal status. Never rejects.
 */
function runChild(record: AgentRecord, cwd: string, onUpdate: () => void, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    void (async () => {
      const config = AGENT_PROMPTS[record.type] ?? AGENT_PROMPTS.task;
      const prompt = `${config?.prompt ?? ""}\n\nReturn only the result needed by the caller. Do not include progress narration.`;
      let temp: { dir: string; file: string } | undefined;
      try {
        temp = await writePrompt(record.type, prompt);
      } catch {
        record.status = "failed";
        record.errorMessage = "Failed to stage subagent system prompt.";
        resolve();
        return;
      }

      const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", temp.file, record.assignment];
      const invocation = piInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SWIFT_PI_SUBAGENT: "1" },
      });
      record.child = child;

      let buffer = "";
      const setStatus = (status: AgentStatus) => {
        if (isTerminalStatus(record.status)) return;
        record.status = status;
        onUpdate();
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!isObject(event)) return;

        if (event.type === "message_start" && isObject(event.message) && event.message.role === "assistant") {
          setStatus("thinking");
          return;
        }
        if (event.type === "tool_execution_start") {
          setStatus("working");
          return;
        }
        if (event.type === "message_end" && isObject(event.message)) {
          const raw = event.message;
          if (raw.role === "assistant") {
            record.messages.push(raw as unknown as Message);
            record.usage.turns++;
            const usage = raw.usage;
            if (isObject(usage)) {
              record.usage.input += num(usage.input);
              record.usage.output += num(usage.output);
              record.usage.cacheRead += num(usage.cacheRead);
              record.usage.cacheWrite += num(usage.cacheWrite);
              record.usage.contextTokens = num(usage.totalTokens);
              const cost = usage.cost;
              if (isObject(cost)) record.usage.cost += num(cost.total);
            }
            if (!record.model && typeof raw.model === "string") record.model = raw.model;
            if (typeof raw.stopReason === "string") record.stopReason = raw.stopReason;
            if (typeof raw.errorMessage === "string") record.errorMessage = raw.errorMessage;
            onUpdate();
          } else if (raw.role === "toolResult") {
            record.messages.push(raw as unknown as Message);
            onUpdate();
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        guard(() => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        guard(() => {
          record.stderr += chunk.toString("utf8");
        });
      });

      const cleanup = async () => {
        if (temp) await fsp.rm(temp.dir, { recursive: true, force: true }).catch(() => {});
      };

      const abort = () => {
        record.abortRequested = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            if (stillRunning(child)) child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, SIGKILL_ESCALATION_MS).unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });

      const finish = (code: number) => {
        guard(() => {
          if (buffer.trim()) processLine(buffer);
          if (record.abortRequested) record.status = "aborted";
          else if (code === 0 && record.stopReason !== "error" && record.stopReason !== "aborted") record.status = "done";
          else record.status = "failed";
        });
        signal?.removeEventListener("abort", abort);
        record.child = undefined;
        void cleanup().finally(resolve);
      };

      child.on("close", (code) => finish(code ?? 0));
      child.on("error", (error) => {
        guard(() => {
          record.stderr += `${error.message}\n`;
        });
        finish(1);
      });
    })();
  });
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// `child.killed` only records that a signal was successfully SENT (it is true
// right after SIGTERM even while the process ignores it), so escalation checks
// must test actual liveness instead.
function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

// ─── output helpers ───────────────────────────────────────────────────────────

function truncate(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= OUTPUT_LIMIT) return text;
  let end = OUTPUT_LIMIT;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > OUTPUT_LIMIT) end--;
  const omitted = bytes - Buffer.byteLength(text.slice(0, end), "utf8");
  return `${text.slice(0, end)}\n\n[Output truncated: ${omitted} bytes omitted.]`;
}

function finalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) return part.text;
      }
    }
  }
  return "";
}

function isFailed(record: AgentRecord): boolean {
  return record.status === "failed" || record.status === "aborted";
}

/** Body text delivered to / returned to the parent for one agent. */
function resultBody(record: AgentRecord): string {
  if (isFailed(record)) {
    const reason = record.status === "aborted" ? "Subagent aborted by operator." : "Subagent failed.";
    const detail = record.errorMessage || record.stderr.trim() || finalAssistantText(record.messages);
    return truncate(detail ? `${reason}\n${detail}` : reason);
  }
  return truncate(finalAssistantText(record.messages) || record.stderr.trim() || "(no output)");
}

function resultHeaderText(record: AgentRecord): string {
  return `[subagent ${record.type} — ${record.status}] ${record.task}`;
}

// ─── persistence (D8) ─────────────────────────────────────────────────────────

function appendDispatchEntry(pi: ExtensionAPI, record: AgentRecord): void {
  const data: DispatchData = {
    id: record.id,
    type: record.type,
    task: record.task,
    assignment: record.assignment,
    spawnedAt: record.spawnedAt,
  };
  pi.appendEntry<DispatchData>(DISPATCH_ENTRY, data);
}

function appendCompletionEntry(pi: ExtensionAPI, record: AgentRecord): void {
  const data: CompletionData = {
    id: record.id,
    status: record.status,
    messages: record.messages,
    usage: record.usage,
    model: record.model,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    stderr: truncate(record.stderr),
    lost: record.lost,
  };
  pi.appendEntry<CompletionData>(COMPLETION_ENTRY, data);
}

// ─── delivery (D3) ────────────────────────────────────────────────────────────
//
// Always deliverAs "followUp", unconditionally — no isIdle() branch. When idle
// the option is ignored and triggerTurn starts a new turn; when busy it queues.
// This is race-free (a busy send with no deliverAs throws internally and the
// delivery is silently lost).

function deliverResult(record: AgentRecord): void {
  const c = current;
  if (!c) return;
  const details: ResultDetails = {
    id: record.id,
    type: record.type,
    task: record.task,
    status: record.status,
    usage: record.usage,
    model: record.model,
  };
  c.pi.sendMessage<ResultDetails>(
    {
      customType: RESULT_TYPE,
      content: `${resultHeaderText(record)}\n\n${resultBody(record)}`,
      display: true,
      details,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

/**
 * Move a record to its terminal state exactly once: append the completion entry
 * (D8) and, in interactive mode, auto-deliver the result (D3). Idempotent.
 */
function finalize(record: AgentRecord, opts: { deliver: boolean }): void {
  if (record.finalized) return;
  record.finalized = true;
  record.child = undefined;
  const c = current;
  if (c) guard(() => appendCompletionEntry(c.pi, record));
  if (opts.deliver) guard(() => deliverResult(record));
}

// ─── indicator line (Feature 2, D4/D5) ────────────────────────────────────────

function renderToken(theme: Theme, glyph: string, status: AgentStatus | undefined, selected: boolean): string {
  const color: ThemeColor = status ? STATUS_META[status].color : "text";
  const inner = status ? `${glyph}|${STATUS_META[status].glyph}` : glyph;
  const bracketColor: ThemeColor = selected ? "accent" : "dim";
  const token = theme.fg(bracketColor, "[") + theme.fg(color, inner) + theme.fg(bracketColor, "]");
  return selected ? theme.bold(token) : token;
}

function repaintIndicator(): void {
  const c = current;
  if (!c) return;
  if (registry.size === 0) {
    c.ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
    return;
  }
  clampSelector();
  const theme = c.ctx.ui.theme;
  const tokens: string[] = [renderToken(theme, PARENT_GLYPH, undefined, selectedIndex === 0)];
  let hasLive = false;
  let i = 1;
  for (const record of registry.values()) {
    tokens.push(renderToken(theme, typeGlyph(record.type), record.status, selectedIndex === i));
    if (!isTerminalStatus(record.status)) hasLive = true;
    i++;
  }
  // Hotkey reminder, shown only while agents are present (same visibility as the
  // indicator line itself); abort is offered only while something is in flight.
  const hint = theme.fg("dim", `alt+, / alt+. select · alt+o replay${hasLive ? " · alt+x abort" : ""}`);
  c.ctx.ui.setWidget(WIDGET_KEY, [tokens.join(" "), hint], { placement: "belowEditor" });
}

// ─── selector (Feature 3) ─────────────────────────────────────────────────────

function indicatorCount(): number {
  return 1 + registry.size;
}

function clampSelector(): void {
  const n = indicatorCount();
  if (selectedIndex < 0) selectedIndex = 0;
  if (selectedIndex >= n) selectedIndex = n - 1;
}

function moveSelector(delta: number): void {
  const n = indicatorCount();
  selectedIndex = (((selectedIndex + delta) % n) + n) % n;
  repaintIndicator();
}

function selectedRecord(): AgentRecord | undefined {
  if (selectedIndex <= 0) return undefined; // parent
  return [...registry.values()][selectedIndex - 1];
}

// ─── replay overlay (Feature 2, D5) ───────────────────────────────────────────

function formatToolCall(name: string, args: Record<string, unknown>, theme: Theme): string {
  const home = os.homedir();
  const shorten = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  switch (name) {
    case "bash": {
      const command = String(args.command ?? "...");
      return theme.fg("muted", "$ ") + theme.fg("toolOutput", command.length > 72 ? `${command.slice(0, 72)}…` : command);
    }
    case "read":
    case "write":
    case "edit": {
      const raw = String(args.file_path ?? args.path ?? "...");
      return theme.fg("muted", `${name} `) + theme.fg("accent", shorten(raw));
    }
    case "grep":
    case "search": {
      const pattern = String(args.pattern ?? "");
      return theme.fg("muted", `${name} `) + theme.fg("accent", `/${pattern}/`);
    }
    default: {
      const preview = JSON.stringify(args);
      return theme.fg("accent", name) + theme.fg("dim", ` ${preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}`);
    }
  }
}

function usageLine(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${usage.input}`);
  if (usage.output) parts.push(`↓${usage.output}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

class ReplayOverlay implements Component, Focusable {
  focused = false;
  private scroll = 0;
  private cachedWidth = -1;
  private cachedBody: string[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly record: AgentRecord,
    private readonly done: (result: undefined) => void,
  ) {}

  private viewHeight(): number {
    const rows = this.tui.terminal.rows || 24;
    return Math.max(4, Math.floor(rows * 0.8) - 2);
  }

  private buildBody(width: number): string[] {
    if (width === this.cachedWidth) return this.cachedBody;
    const th = this.theme;
    const rec = this.record;
    const container = new Container();
    const statusMeta = STATUS_META[rec.status];
    container.addChild(
      new Text(
        `${th.fg(statusMeta.color, statusMeta.glyph)} ${th.fg("toolTitle", th.bold(rec.type))} ${th.fg(statusMeta.color, rec.status)}${rec.lost ? th.fg("warning", " (lost — pi exited while running)") : ""}`,
        0,
        0,
      ),
    );
    const u = usageLine(rec.usage);
    if (u) container.addChild(new Text(th.fg("dim", u), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(th.fg("muted", "─── Assignment ───"), 0, 0));
    container.addChild(new Text(th.fg("dim", rec.assignment), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(th.fg("muted", "─── Transcript ───"), 0, 0));

    const md = getMarkdownTheme();
    let rendered = false;
    for (const msg of rec.messages) {
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text" && part.text.trim()) {
            container.addChild(new Markdown(part.text.trim(), 0, 0, md));
            rendered = true;
          } else if (part.type === "toolCall") {
            container.addChild(new Text(th.fg("muted", "→ ") + formatToolCall(part.name, part.arguments, th), 0, 0));
            rendered = true;
          }
        }
      } else if (msg.role === "toolResult") {
        const text = msg.content
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("")
          .trim();
        if (text) {
          const clipped = text.length > 800 ? `${text.slice(0, 800)}…` : text;
          container.addChild(new Text(th.fg(msg.isError ? "error" : "toolOutput", `  ⎿ ${clipped.replace(/\n/g, "\n    ")}`), 0, 0));
          rendered = true;
        }
      }
    }
    if (!rendered) {
      const err = rec.errorMessage || rec.stderr.trim();
      container.addChild(new Text(th.fg(isFailed(rec) ? "error" : "muted", err || "(no captured output)"), 0, 0));
    }

    this.cachedBody = container.render(width);
    this.cachedWidth = width;
    return this.cachedBody;
  }

  private maxScroll(width: number): number {
    return Math.max(0, this.buildBody(width).length - this.viewHeight());
  }

  handleInput(data: string): void {
    const width = this.cachedWidth > 0 ? this.cachedWidth : 80;
    const page = Math.max(1, this.viewHeight() - 1);
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, Key.alt("o"))) {
      this.done(undefined);
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll = Math.min(this.maxScroll(width), this.scroll + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.scroll = Math.max(0, this.scroll - page);
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
      this.scroll = Math.min(this.maxScroll(width), this.scroll + page);
    } else if (matchesKey(data, "home")) {
      this.scroll = 0;
    } else if (matchesKey(data, "end")) {
      this.scroll = this.maxScroll(width);
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(1, width - 2);
    const body = this.buildBody(inner);
    const height = this.viewHeight();
    const max = Math.max(0, body.length - height);
    if (this.scroll > max) this.scroll = max;
    const window = body.slice(this.scroll, this.scroll + height);
    while (window.length < height) window.push("");
    const title = th.fg("toolTitle", th.bold(` Replay: ${this.record.type} `));
    const hint = th.fg(
      "dim",
      ` ${body.length > height ? `${this.scroll + 1}-${Math.min(this.scroll + height, body.length)}/${body.length} · ` : ""}↑↓ scroll · Esc close `,
    );
    const lines = [title, ...window.map((l) => ` ${l}`), hint];
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  dispose(): void {}
}

// ─── record construction ──────────────────────────────────────────────────────

function makeRecord(type: string, task: { description: string; assignment: string }, context: string | undefined): AgentRecord {
  const id = `sa-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
  const assignment = context ? `${context}\n\n${task.assignment}` : task.assignment;
  return {
    id,
    type,
    task: task.description,
    assignment,
    status: "waiting",
    messages: [],
    usage: newUsage(),
    spawnedAt: Date.now(),
    model: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    stderr: "",
    lost: false,
    finalized: false,
    abortRequested: false,
    child: undefined,
  };
}

// ─── parameters ───────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  id: Type.String({ description: "CamelCase task id." }),
  description: Type.String({ description: "Short UI label." }),
  assignment: Type.String({ description: "Complete self-contained assignment." }),
});

const SubagentParams = Type.Object({
  agent: Type.String({ description: "Agent type: explore, plan, designer, reviewer, librarian, oracle, task, or quick_task." }),
  tasks: Type.Array(TaskItem, { description: "Tasks to run as background subagents." }),
  context: Type.Optional(Type.String({ description: "Shared context prepended to every assignment." })),
});

type SubagentParamsType = {
  agent: string;
  tasks: Array<{ id: string; description: string; assignment: string }>;
  context?: string;
};

// ─── blocking fallback (D2) ────────────────────────────────────────────────────

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

function renderBlocking(records: AgentRecord[]): string {
  return records
    .map((record) => {
      const status = record.status === "done" ? "completed" : record.status;
      return `### ${record.task} — ${status}\n${resultBody(record)}`;
    })
    .join("\n\n---\n\n");
}

// ─── background start (dispatch path) ─────────────────────────────────────────

function startAndFinalize(record: AgentRecord, cwd: string): void {
  void (async () => {
    try {
      await runChild(record, cwd, () => guard(repaintIndicator), undefined);
    } catch {
      record.status = "failed";
    }
    finalize(record, { deliver: true });
    guard(repaintIndicator);
  })();
}

// ─── extension factory ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // D10: a child (SWIFT_PI_SUBAGENT set) registers nothing — no tool, widget,
  // shortcuts, or delivery wiring — so the delegation tool is invisible to it.
  if (process.env.SWIFT_PI_SUBAGENT) return;

  // Re-bind the live context on every session_start (all five reasons) and
  // rebuild the registry from persisted entries (D6/D8).
  pi.on("session_start", (_event, ctx) => {
    current = { ctx, pi };
    registry.clear();
    selectedIndex = 0;
    guard(() => {
      const dispatches = new Map<string, DispatchData>();
      const completions = new Map<string, CompletionData>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom") continue;
        if (entry.customType === DISPATCH_ENTRY) {
          const data = entry.data as DispatchData | undefined;
          if (data?.id) dispatches.set(data.id, data);
        } else if (entry.customType === COMPLETION_ENTRY) {
          const data = entry.data as CompletionData | undefined;
          if (data?.id) completions.set(data.id, data);
        }
      }
      for (const [id, d] of dispatches) {
        const comp = completions.get(id);
        const record: AgentRecord = {
          id,
          type: d.type,
          task: d.task,
          assignment: d.assignment,
          status: "aborted",
          messages: [],
          usage: newUsage(),
          spawnedAt: d.spawnedAt,
          model: undefined,
          stopReason: undefined,
          errorMessage: undefined,
          stderr: "",
          lost: true,
          finalized: true,
          abortRequested: false,
          child: undefined,
        };
        if (comp) {
          record.status = comp.status;
          record.messages = Array.isArray(comp.messages) ? comp.messages : [];
          record.usage = comp.usage ?? newUsage();
          record.model = comp.model;
          record.stopReason = comp.stopReason;
          record.errorMessage = comp.errorMessage;
          record.stderr = comp.stderr ?? "";
          record.lost = comp.lost ?? false;
        }
        registry.set(id, record);
      }
    });
    guard(repaintIndicator);
  });

  // D9: kill live children on shutdown and append their aborted-completion
  // entries. Bounded (SIGTERM, brief grace, SIGKILL), awaited.
  //
  // Finalize BEFORE the grace wait: a SIGTERMed child often closes inside that
  // window, and its close-path continuation calls finalize({deliver: true}) —
  // if the record were not already finalized, that would deliver a result with
  // triggerTurn into the session being torn down (a phantom turn on quit, or a
  // stray delivery into the replacement session after a switch). Capture the
  // children first because finalize clears record.child.
  pi.on("session_shutdown", async () => {
    const live = [...registry.values()].filter((r) => !r.finalized);
    const children = live.map((r) => r.child).filter((c): c is ChildProcess => c !== undefined);
    for (const record of live) {
      record.abortRequested = true;
      record.status = "aborted";
      record.lost = true;
      finalize(record, { deliver: false });
    }
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    if (children.length > 0) await new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS));
    for (const child of children) {
      try {
        if (stillRunning(child)) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  });

  // Compact chat rendering of delivered results (5.2 / D3).
  pi.registerMessageRenderer<ResultDetails>(RESULT_TYPE, (message, _options, theme) => {
    const d = message.details;
    const status: AgentStatus = d?.status ?? "done";
    const meta = STATUS_META[status];
    const label = d ? `${d.type} — ${d.task}` : "subagent";
    let text = `${theme.fg(meta.color, meta.glyph)} ${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", label)} ${theme.fg(meta.color, status)}`;
    if (d) {
      const u = usageLine(d.usage);
      if (u) text += `\n${theme.fg("dim", u)}`;
    }
    return new Text(text, 0, 0);
  });

  // Selector traversal (4.1) and open (4.2) / abort (4.3).
  pi.registerShortcut(Key.alt(","), {
    description: "Subagents: select previous indicator",
    handler: () => guard(() => moveSelector(-1)),
  });
  pi.registerShortcut(Key.alt("."), {
    description: "Subagents: select next indicator",
    handler: () => guard(() => moveSelector(1)),
  });
  pi.registerShortcut(Key.alt("o"), {
    description: "Subagents: open replay of selected agent",
    handler: (ctx) => {
      // Overlay must be invoked synchronously from the hotkey handler (D5).
      try {
        const record = selectedRecord();
        if (!record || ctx.mode !== "tui") return; // parent [⊤] is a no-op (4.2)
        void ctx.ui.custom<undefined>(
          (tui, theme, _kb, done) => new ReplayOverlay(tui, theme, record, done),
          { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
        );
      } catch {
        /* contained */
      }
    },
  });
  pi.registerShortcut(Key.alt("x"), {
    description: "Subagents: abort selected in-flight agent",
    handler: () =>
      guard(() => {
        const record = selectedRecord();
        // No-op on the parent, finished agents, or a record with no live child (4.3/D11).
        if (!record || record.finalized || isTerminalStatus(record.status) || !record.child) return;
        record.abortRequested = true;
        record.status = "aborted";
        try {
          record.child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        const child = record.child;
        setTimeout(() => {
          try {
            if (child && stillRunning(child)) child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, SIGKILL_ESCALATION_MS).unref();
        repaintIndicator();
      }),
  });

  pi.registerTool<typeof SubagentParams, { dispatched?: unknown; results?: unknown }>({
    name: "subagents",
    label: "Subagents",
    description: [
      "Dispatch independent work to isolated background subagent processes that run concurrently with you.",
      "In interactive mode this returns immediately with a dispatch acknowledgement; each subagent's result arrives later as an automatic follow-up message — do not wait inline.",
      "Agent types: explore, plan, designer, reviewer, librarian, oracle, task, quick_task.",
    ].join(" "),
    promptSnippet: "subagents — background parallel delegation; dispatch returns immediately, results arrive as follow-up messages.",
    promptGuidelines: [
      "Use subagents for independent subtasks; each assignment must be self-contained and subagents must skip project-wide gates/formatters.",
      "In interactive mode dispatch is non-blocking: continue other work; results are delivered automatically as follow-up turns. Track/replay/abort agents from the indicator line (alt+, / alt+. select, alt+o replay, alt+x abort).",
    ],
    parameters: SubagentParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: SubagentParamsType, signal, _onUpdate, ctx) {
      if (params.tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks supplied." }], details: { results: [] } };
      }
      const records = params.tasks.map((task) => makeRecord(params.agent, task, params.context));
      for (const record of records) {
        registry.set(record.id, record);
        guard(() => appendDispatchEntry(pi, record));
      }
      guard(repaintIndicator);

      // D2: dispatch-and-return only in the interactive TUI. Everywhere else run
      // blocking and return aggregated results (background delivery would be
      // lost when the non-interactive process exits at end of turn).
      if (ctx.mode === "tui") {
        for (const record of records) startAndFinalize(record, ctx.cwd);
        const names = records.map((r) => `${r.type}:${r.task}`).join(", ");
        const ack = `Dispatched ${records.length} background subagent(s): ${names}. They run detached; results will arrive automatically as follow-up messages. Track them on the indicator line below the prompt (alt+, / alt+. select, alt+o replay, alt+x abort). Continue other work — do not wait inline.`;
        return {
          content: [{ type: "text", text: ack }],
          details: { dispatched: records.map((r) => ({ id: r.id, type: r.type, task: r.task })) },
        };
      }

      await mapLimit(records, MAX_CONCURRENCY, async (record) => {
        await runChild(record, ctx.cwd, () => guard(repaintIndicator), signal);
        finalize(record, { deliver: false });
        guard(repaintIndicator);
      });
      const failed = records.some(isFailed);
      return {
        content: [{ type: "text", text: renderBlocking(records) }],
        details: { results: records.map((r) => ({ id: r.id, type: r.type, task: r.task, status: r.status })) },
        terminate: failed,
      };
    },
  });
}
