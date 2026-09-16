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
 * Re-engagement (addressable-subagents, D1–D11 in
 * openspec/changes/addressable-subagents/design.md): every agent runs on a
 * durable session (`--session-id <record id>` in a private session dir), so
 * `subagents_send` can resume a finished/failed/aborted agent with full prior
 * context or kill-and-redirect an in-flight one. Delivered headers carry the
 * agent id (D5); records are turn-shaped with per-engagement completion
 * entries (D4); single-writer is enforced, not asserted (D9). Design decisions
 * D1–D11 in openspec/changes/background-subagents/design.md remain binding
 * where not superseded; inline references point at the relevant one.
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
const ENGAGEMENT_ENTRY = "subagent_engagement";
const SIGKILL_ESCALATION_MS = 5_000;
const SHUTDOWN_GRACE_MS = 300;
const SESSION_DIR = path.join(os.tmpdir(), "swift-pi-subagent-sessions");
// Pi session files are named `<timestamp>_<sessionId>.jsonl`; the resume
// existence check (D8) must therefore scan for the suffix, not probe a path.
const SESSION_FILE_SUFFIX = ".jsonl";
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
  /** Child process id, from the live spawn or the persisted entries. */
  pid: number | undefined;
  /** True when this record was rebuilt from session entries, not spawned this session. */
  restored: boolean;
  /** Send-initiated kill in progress: the killed engagement must not deliver (D11). */
  suppressNextDelivery: boolean;
  /** A resume child reported it created a fresh session (D2/D8 hard failure). */
  resumeSessionMissing: boolean;
  /** Promise of the engagement currently in flight, if any. */
  run: Promise<void> | undefined;
}

interface DispatchData {
  id: string;
  type: string;
  task: string;
  assignment: string;
  spawnedAt: number;
  /** Model requested at dispatch time, when any (normalized "provider/model-id"). */
  model?: string | undefined;
  /** Child process pid at spawn, for the cross-restart orphan probe (D9). */
  pid: number | undefined;
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
  pid: number | undefined;
  /** Set when this engagement failed because the durable session was missing (D8). */
  resumeSessionMissing?: true;
}

/**
 * Persisted per resume spawn (D9c): carries the resume child's pid so a parent
 * crash mid-re-engagement still leaves the orphan visible to the cross-restart
 * pid probe — completion entries alone only cover *completed* engagements.
 */
interface EngagementData {
  id: string;
  /** The engagement's prompt (the send message). */
  message: string;
  pid: number | undefined;
  at: number;
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

/**
 * True between session_shutdown entry and the next session_start. A send's
 * claimed-but-unspawned engagement at shutdown must not spawn an orphan child
 * after the shutdown handler has already finalized and torn down (review
 * finding 4) — runChild's pre-spawn abort check consults this via the
 * shutdown handler setting abortRequested, and this flag covers the race
 * where the flag was set after the record was already claimed.
 */
let shuttingDown = false;

/** Verification hook for the headless harness (scripts/subagents-harness.mjs). */
export const __registry = registry;
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
 * Child-runner core (shared by dispatch, send, and blocking paths). Spawns one
 * child pi, streams its `--mode json` events, and mutates `record` live:
 *   - message_start (assistant)  → status "thinking"
 *   - tool_execution_start       → status "working"
 *   - message_end (assistant)    → capture message + usage/model/stopReason
 *   - message_end (toolResult)   → capture tool result for replay
 * The child runs on a durable session (D2): `--session-id <record id>` in a
 * private session dir — create on first dispatch, resume on later engagements.
 * Resume spawns omit `--model` (D10) and treat the "creating a new session"
 * stderr warning as a hard failure (D8). Calls `opts.onSpawned(pid)` right
 * after a successful spawn. Resolves when the child closes, having set a
 * terminal status. Never rejects.
 */
function runChild(
  record: AgentRecord,
  cwd: string,
  onUpdate: () => void,
  signal: AbortSignal | undefined,
  opts: { resume: boolean; message?: string | undefined; onSpawned?: (pid: number) => void },
): Promise<void> {
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

      // D2: the child runs on a durable session keyed by the record id. Create
      // the dir eagerly so the D8 existence scan has something to scan.
      await fsp.mkdir(SESSION_DIR, { recursive: true }).catch(() => {});
      // An abort that landed while staging (operator hotkey on a claimed-but-
      // unspawned engagement, a send interrupt, or session shutdown) must not
      // spawn a child nobody is waiting to kill — the pending engagement ends
      // here, and the trailing finalize applies D11 suppression as usual.
      if (record.abortRequested) {
        record.status = "aborted";
        void fsp.rm(temp.dir, { recursive: true, force: true }).catch(() => {});
        resolve();
        return;
      }
      const args = [
        "--mode",
        "json",
        "-p",
        "--session-dir",
        SESSION_DIR,
        "--session-id",
        record.id,
        "--append-system-prompt",
        temp.file,
      ];
      // D10: the dispatch-time model request (validated "provider/model-id")
      // applies on the first engagement only; resume children omit --model so
      // the session's stored model carries forward.
      if (!opts.resume && record.model) args.push("--model", record.model);
      // The engagement's prompt is captured by the caller before its first
      // await; a late read of record.assignment here would race a concurrent
      // beginEngagement overwriting it (review finding 1).
      args.push(opts.message ?? record.assignment);
      // D9 regression tripwire: a record must never gain a second live child.
      // Enforcement is D9 (sequential mode + synchronous claim + pid probe);
      // this only catches a future refactor that breaks the invariant.
      if (record.child !== undefined) {
        record.status = "failed";
        record.errorMessage = "internal: second live child attempted for one record";
        void fsp.rm(temp.dir, { recursive: true, force: true }).catch(() => {});
        resolve();
        return;
      }
      const invocation = piInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SWIFT_PI_SUBAGENT: "1" },
      });
      record.child = child;
      if (child.pid !== undefined) {
        record.pid = child.pid;
        opts.onSpawned?.(child.pid);
      }
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

      // Node emits BOTH 'error' and 'close' on spawn failure (e.g. ENOENT), so
      // finish must run exactly once.
      let finished = false;
      const finish = (code: number | null, signalName?: string) => {
        if (finished) return;
        finished = true;
        guard(() => {
          if (buffer.trim()) processLine(buffer);
          if (record.abortRequested) record.status = "aborted";
          else if (code === 0 && record.stopReason !== "error" && record.stopReason !== "aborted") record.status = "done";
          else {
            // External signal death arrives as close(null, signal); children we
            // killed ourselves during abort are handled by the branch above.
            record.status = "failed";
            if (signalName) record.errorMessage = `killed by ${signalName}`;
          }
          // D2/D8: on a resume engagement this stderr warning fires only when
          // the durable session was missing, so the child answered from a blank
          // context. That result must not pass as a normal continuation.
          if (opts.resume && !record.abortRequested && record.stderr.includes("creating a new session with that id")) {
            record.status = "failed";
            record.resumeSessionMissing = true;
            record.errorMessage =
              "Durable session missing: the resume child created a new blank session, so prior subagent context was absent. Re-dispatch instead of re-engaging.";
          }
        });
        signal?.removeEventListener("abort", abort);
        record.child = undefined;
        void cleanup().finally(resolve);
      };

      child.on("close", (code, signalName) => finish(code, signalName ?? undefined));
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
  // Byte-aware walk over code points: accumulate UTF-8 width and stop before
  // the first one that would exceed the budget. O(n) — the old per-code-unit
  // Buffer.byteLength loop was O(n²).
  let end = 0;
  let kept = 0;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    const paired = code >= 0xd800 && code < 0xdc00 && text.charCodeAt(end + 1) >= 0xdc00;
    // A surrogate pair is one 4-byte code point; an unpaired surrogate renders
    // as U+FFFD (3 bytes).
    const width = paired ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (kept + width > OUTPUT_LIMIT) break;
    kept += width;
    end += paired ? 2 : 1;
  }
  return `${text.slice(0, end)}\n\n[Output truncated: ${bytes - kept} bytes omitted.]`;
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
  // D5: the id in the LLM-visible header is the handle the parent needs to
  // address a re-engagement via subagents_send.
  return `[subagent ${record.type} ${record.id} — ${record.status}] ${record.task}`;
}

// ─── persistence (D8) ─────────────────────────────────────────────────────────

function appendDispatchEntry(pi: ExtensionAPI, record: AgentRecord): void {
  const data: DispatchData = {
    id: record.id,
    type: record.type,
    task: record.task,
    assignment: record.assignment,
    spawnedAt: record.spawnedAt,
    model: record.model,
    pid: record.pid,
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
    pid: record.pid,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    stderr: truncate(record.stderr),
    lost: record.lost,
    ...(record.resumeSessionMissing ? { resumeSessionMissing: true as const } : {}),
  };
  pi.appendEntry<CompletionData>(COMPLETION_ENTRY, data);
}

/** D9c: persisted at every resume spawn so the orphan probe sees the latest child. */
function appendEngagementEntry(pi: ExtensionAPI, record: AgentRecord): void {
  const data: EngagementData = {
    id: record.id,
    message: record.assignment,
    pid: record.pid,
    at: Date.now(),
  };
  pi.appendEntry<EngagementData>(ENGAGEMENT_ENTRY, data);
}

// ─── delivery (D3) ────────────────────────────────────────────────────────────
//
// Always deliverAs "followUp", unconditionally — no isIdle() branch. When idle
// the option is ignored and triggerTurn starts a new turn; when busy the
// message is queued. (The busy-send throw belongs to sendUserMessage/prompt,
// which require an explicit deliverAs/streamingBehavior; sendMessage never
// throws — when streaming without deliverAs it defaults to "steer", so passing
// "followUp" here is a deliberate routing choice, not a throw guard.)

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

/**
 * Live transcript overlay. Follows the transcript tail by default; scrolling up
 * freezes the viewport so new lines append below the fold, and scrolling back to
 * the bottom (down / pageDown / end) re-engages the live tail.
 */
class ReplayOverlay implements Component, Focusable {
  focused = false;
  private scroll = 0;
  /** Live-tail mode: true while the window is pinned to the newest lines. */
  private follow = true;
  private cachedWidth = -1;
  private cachedBody: string[] = [];
  private cachedMessagesKey = "";

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
    // The record mutates while the overlay is open (new transcript messages,
    // status changes), so the cache key must cover those too — width alone
    // would freeze the body until a resize.
    const messagesKey = `${this.record.status}:${this.record.messages.length}`;
    if (width === this.cachedWidth && messagesKey === this.cachedMessagesKey) return this.cachedBody;
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
    this.cachedMessagesKey = messagesKey;
    return this.cachedBody;
  }

  private maxScroll(width: number): number {
    return Math.max(0, this.buildBody(width).length - this.viewHeight());
  }

  handleInput(data: string): void {
    const width = this.cachedWidth > 0 ? this.cachedWidth : 80;
    const max = this.maxScroll(width);
    const page = Math.max(1, this.viewHeight() - 1);
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, Key.alt("o"))) {
      this.done(undefined);
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.follow = false;
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll = Math.min(max, this.scroll + 1);
      this.follow = this.scroll >= max;
    } else if (matchesKey(data, "pageUp")) {
      this.follow = false;
      this.scroll = Math.max(0, this.scroll - page);
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
      this.scroll = Math.min(max, this.scroll + page);
      this.follow = this.scroll >= max;
    } else if (matchesKey(data, "home")) {
      this.follow = false;
      this.scroll = 0;
    } else if (matchesKey(data, "end")) {
      this.scroll = max;
      this.follow = true;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(1, width - 2);
    const body = this.buildBody(inner);
    const height = this.viewHeight();
    const max = Math.max(0, body.length - height);
    // Live tail: while following (or whenever the viewport lands at the bottom),
    // stay pinned to the newest lines as the transcript grows. A frozen
    // (scrolled-up) viewport keeps its offset; new lines append below the fold.
    if (this.follow || this.scroll >= max) {
      this.follow = true;
      this.scroll = max;
    }
    const window = body.slice(this.scroll, this.scroll + height);
    while (window.length < height) window.push("");
    const title = th.fg("toolTitle", th.bold(` Replay: ${this.record.type} `));
    const overflow = body.length > height;
    const followHint = overflow ? (this.follow ? " · live" : " · paused (pgdn to resume)") : "";
    const hint = th.fg(
      "dim",
      ` ${overflow ? `${this.scroll + 1}-${Math.min(this.scroll + height, body.length)}/${body.length} · ` : ""}↑↓ scroll${followHint} · Esc close `,
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

function makeRecord(
  type: string,
  task: { description: string; assignment: string },
  context: string | undefined,
  model: string | undefined,
): AgentRecord {
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
    model,
    stopReason: undefined,
    errorMessage: undefined,
    stderr: "",
    lost: false,
    finalized: false,
    abortRequested: false,
    child: undefined,
    pid: undefined,
    restored: false,
    suppressNextDelivery: false,
    resumeSessionMissing: false,
    run: undefined,
  };
}

/**
 * Normalize a requested model reference to canonical "provider/model-id",
 * validated against the available models. Accepts "provider/model-id" or a
 * bare "model-id" (disambiguated via the available snapshot). Throws before
 * anything is dispatched or persisted when the reference cannot be resolved.
 */
function resolveModelRef(ctx: ExtensionContext, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const registry = ctx.modelRegistry;
  const slash = value.indexOf("/");
  const model =
    slash > 0
      ? registry.find(value.slice(0, slash), value.slice(slash + 1))
      : registry.getAvailable().find((m) => m.id === value);
  if (model) return `${model.provider}/${model.id}`;
  const available = registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  const preview = available.slice(0, 10).join(", ");
  const more = available.length > 10 ? `, … (+${available.length - 10} more)` : "";
  throw new Error(
    `Unknown subagent model "${value}". Use "provider/model-id" (or a bare model id). Available models: ${preview}${more || "none"}.`,
  );
}

// ─── parameters ───────────────────────────────────────────────────────────────

const TaskItem = Type.Object({
  id: Type.String({ description: "CamelCase task id." }),
  description: Type.String({ description: "Short UI label." }),
  assignment: Type.String({ description: "Complete self-contained assignment." }),
  model: Type.Optional(
    Type.String({ description: 'Model override for this task ("provider/model-id" or bare "model-id"). Wins over the dispatch-level model.' }),
  ),
});

const SubagentParams = Type.Object({
  agent: Type.String({ description: "Agent type: explore, plan, designer, reviewer, librarian, oracle, task, or quick_task." }),
  tasks: Type.Array(TaskItem, { description: "Tasks to run as background subagents." }),
  context: Type.Optional(Type.String({ description: "Shared context prepended to every assignment." })),
  model: Type.Optional(
    Type.String({
      description:
        'Model for every task in this dispatch ("provider/model-id" or bare "model-id"). A per-task model wins. Omit: children resolve the harness default model — the currently selected model is NOT inherited.',
    }),
  ),
});

type SubagentParamsType = {
  agent: string;
  tasks: Array<{ id: string; description: string; assignment: string; model?: string }>;
  context?: string;
  model?: string;
};

const SendParams = Type.Object({
  id: Type.String({ description: 'Registry id of the agent to message — from a result header ("[subagent task sa-8fk2 — done] …") or a dispatch acknowledgement.' }),
  message: Type.String({ description: "New prompt for the agent's next engagement (e.g. reviewer feedback, a correction)." }),
  interrupt: Type.Optional(
    Type.Boolean({
      description:
        "Kill the agent's in-flight engagement first (SIGTERM with escalation), then resume its session with this message. Without it, a send to a running agent is rejected.",
    }),
  ),
});

type SendParamsType = {
  id: string;
  message: string;
  interrupt?: boolean;
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

// ─── engagement lifecycle (D4/D8/D9/D11) ─────────────────────────────────────

/**
 * True when the recorded child pid may still be alive. EPERM (exists but not
 * signalable by us) is treated as alive — the orphan probe fails safe.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * D8: the durable session file must exist before any resume spawn. pi's
 * `--session-id` is create-or-open and the session file appears only at the
 * first assistant message, so a missing file must fail the send explicitly —
 * a silent fresh session would promise context that does not exist.
 */
function sessionFileExists(id: string): boolean {
  const suffix = `_${id}${SESSION_FILE_SUFFIX}`;
  let names: string[];
  try {
    names = fs.readdirSync(SESSION_DIR);
  } catch (error) {
    // A dir that was never created is a genuine miss; anything else (EACCES,
    // EMFILE, …) must not be reported as "session missing" — the caller
    // distinguishes the two.
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
    throw error;
  }
  return names.some((f) => f.endsWith(suffix));
}

/**
 * Reset the engagement-scoped fields and point the record at its new prompt.
 * Every engagement start goes through this — including un-terminalizing a
 * restored-lost record; without the `finalized` reset a resumed engagement
 * would never finalize, persist, or deliver (D4).
 */
function beginEngagement(record: AgentRecord, prompt: string): void {
  record.assignment = prompt;
  record.status = "waiting";
  record.stderr = "";
  record.stopReason = undefined;
  record.errorMessage = undefined;
  record.finalized = false;
  record.abortRequested = false;
  record.lost = false;
  record.suppressNextDelivery = false;
  record.resumeSessionMissing = false;
  record.child = undefined;
  record.run = undefined;
}

/** SIGTERM with bounded SIGKILL escalation (shared by hotkey abort and send). */
/**
 * SIGTERM with bounded SIGKILL escalation (shared by operator hotkey abort and
 * send interrupt). Two guard clauses before any state change:
 *  - a record with no live child has nothing to kill;
 *  - a child that already exited (exitCode/signalCode set) is about to close
 *    with its real status — relabeling it "aborted" would misreport a finished
 *    engagement and (via D11) suppress a real result (review finding 7).
 * `suppressDelivery` is D11 attribution: only a send-initiated kill suppresses
 * the intermediate aborted delivery, and only when this call actually
 * initiates it — an operator abort racing a send keeps its diagnostics
 * (review finding 8).
 */
function killChildEscalating(record: AgentRecord, opts?: { suppressDelivery?: boolean }): void {
  const child = record.child;
  if (!child || !stillRunning(child)) return;
  if (opts?.suppressDelivery) record.suppressNextDelivery = true;
  record.abortRequested = true;
  record.status = "aborted";
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
}

/**
 * Run one engagement of an agent: spawn the child, await its close, finalize
 * (persist a completion entry — one per engagement — and, in interactive mode,
 * deliver the result). `deliver` is the caller's default; D11 subtracts a
 * send-initiated kill's intermediate aborted delivery.
 */
function runEngagement(
  record: AgentRecord,
  cwd: string,
  opts: { resume: boolean; deliver: boolean; signal?: AbortSignal | undefined; message?: string },
): Promise<void> {
  const run = (async () => {
    try {
      await runChild(record, cwd, () => guard(repaintIndicator), opts.signal, {
        resume: opts.resume,
        message: opts.message,
        onSpawned: (pid) => {
          record.pid = pid;
          // Exactly one dispatch entry per agent, written once the pid is
          // known (D9c). Every resume spawn additionally appends an engagement
          // entry carrying the new pid — without it, a parent crash mid-resume
          // leaves the orphan invisible to the cross-restart probe (the last
          // completion entry still names the previous, long-dead child).
          const c = current;
          if (!c) return;
          if (!opts.resume) guard(() => appendDispatchEntry(c.pi, record));
          else guard(() => appendEngagementEntry(c.pi, record));
        },
      });
    } catch {
      record.status = "failed";
    }
    finalize(record, { deliver: opts.deliver && !record.suppressNextDelivery });
    record.suppressNextDelivery = false;
    record.run = undefined;
    guard(repaintIndicator);
  })();
  record.run = run;
  return run;
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
    shuttingDown = false;
    guard(() => {
      const dispatches = new Map<string, DispatchData>();
      const completions = new Map<string, CompletionData>();
      const engagements = new Map<string, EngagementData>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom") continue;
        if (entry.customType === DISPATCH_ENTRY) {
          const data = entry.data as DispatchData | undefined;
          if (data?.id) dispatches.set(data.id, data);
        } else if (entry.customType === COMPLETION_ENTRY) {
          const data = entry.data as CompletionData | undefined;
          if (data?.id) completions.set(data.id, data);
        } else if (entry.customType === ENGAGEMENT_ENTRY) {
          const data = entry.data as EngagementData | undefined;
          // Later entries overwrite earlier ones: latest engagement wins.
          if (data?.id) engagements.set(data.id, data);
        }
      }
      for (const [id, d] of dispatches) {
        const comp = completions.get(id);
        const record: AgentRecord = {
          id,
          type: d.type,
          task: d.task,
          assignment: engagements.get(id)?.message ?? d.assignment,
          status: "aborted",
          messages: [],
          usage: newUsage(),
          spawnedAt: d.spawnedAt,
          model: d.model,
          stopReason: undefined,
          errorMessage: undefined,
          stderr: "",
          lost: true,
          finalized: true,
          abortRequested: false,
          child: undefined,
          // Latest known pid across entry kinds: a completion entry covers
          // completed engagements, an engagement entry covers a resume spawn
          // that never completed (parent crash mid-re-engagement, review
          // finding 2), the dispatch entry is the last resort.
          pid: comp?.pid ?? engagements.get(id)?.pid ?? d.pid,
          restored: true,
          suppressNextDelivery: false,
          resumeSessionMissing: comp?.resumeSessionMissing === true,
          run: undefined,
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
    // Block any claimed-but-unspawned engagement from spawning after this
    // handler has finalized and torn down (review finding 4).
    shuttingDown = true;
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
        // No-op on the parent or finished agents. A claimed-but-unspawned
        // engagement (record.run pending, no child yet) is aborted via the
        // flag — runChild's pre-spawn check ends it without ever spawning
        // (review finding 11).
        if (!record || record.finalized || isTerminalStatus(record.status)) return;
        if (record.child) killChildEscalating(record);
        else if (record.run) {
          record.abortRequested = true;
          record.status = "aborted";
        }
        repaintIndicator();
      }),
  });

  pi.registerTool<typeof SubagentParams, { dispatched?: unknown; results?: unknown }>({
    name: "subagents",
    label: "Subagents",
    description: [
      "Dispatch independent work to isolated background subagent processes that run concurrently with you.",
      "In interactive mode this returns immediately with a dispatch acknowledgement; each subagent's result arrives later as an automatic follow-up message — do not wait inline.",
      "Each agent runs on a durable session: re-engage a finished, failed, or aborted agent with subagents_send (results carry the agent id in their header), or redirect an in-flight one with interrupt: true.",
      "Agent types: explore, plan, designer, reviewer, librarian, oracle, task, quick_task.",
      'Optional model: "provider/model-id" runs the whole dispatch on that model; an optional per-task model overrides it per task. Omitted: each agent runs the harness default model — the currently selected model is not inherited. Resume engagements keep the dispatch-time model.',
    ].join(" "),
    promptSnippet:
      "subagents — background parallel delegation; dispatch returns immediately, results arrive as follow-up messages; subagents_send re-engages or redirects an agent by id.",
    promptGuidelines: [
      "Use subagents for independent subtasks; each assignment must be self-contained and subagents must skip project-wide gates/formatters.",
      "In interactive mode dispatch is non-blocking: continue other work; results are delivered automatically as follow-up turns. Track/replay/abort agents from the indicator line (alt+, / alt+. select, alt+o replay, alt+x abort).",
      'Pass model ("provider/model-id") to run agents on a specific model; a per-task model overrides the dispatch-level value. Without it, agents run the harness default model, not your current selection.',
      "Iterate with subagents_send: route reviewer feedback to the implementer's id, or interrupt: true to kill-and-redirect a running agent; cap fix iterations (2–3) before reporting residual issues.",
    ],
    parameters: SubagentParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: SubagentParamsType, signal, _onUpdate, ctx) {
      if (!Object.hasOwn(AGENT_PROMPTS, params.agent)) {
        throw new Error(`Unknown subagent "${params.agent}". Valid agents: ${Object.keys(AGENT_PROMPTS).join(", ")}.`);
      }
      if (params.tasks.length === 0) {
        return { content: [{ type: "text", text: "No tasks supplied." }], details: { results: [] } };
      }
      // Validate every requested model before registering or spawning anything so a
      // bad reference fails the whole call without side effects (precedence:
      // task > dispatch > harness default).
      const records = params.tasks.map((task) =>
        makeRecord(params.agent, task, params.context, resolveModelRef(ctx, task.model ?? params.model)),
      );
      for (const record of records) registry.set(record.id, record);
      guard(repaintIndicator);

      // D2: dispatch-and-return only in the interactive TUI. Everywhere else run
      // blocking and return aggregated results (background delivery would be
      // lost when the non-interactive process exits at end of turn).
      if (ctx.mode === "tui") {
        for (const record of records) void runEngagement(record, ctx.cwd, { resume: false, deliver: true });
        const names = records.map((r) => `${r.type}:${r.task}`).join(", ");
        const ack = `Dispatched ${records.length} background subagent(s): ${names}. They run detached; results will arrive automatically as follow-up messages. Track them on the indicator line below the prompt (alt+, / alt+. select, alt+o replay, alt+x abort). Continue other work — do not wait inline.`;
        return {
          content: [{ type: "text", text: ack }],
          details: { dispatched: records.map((r) => ({ id: r.id, type: r.type, task: r.task })) },
        };
      }

      await mapLimit(records, MAX_CONCURRENCY, async (record) => {
        await runEngagement(record, ctx.cwd, { resume: false, deliver: false, signal });
      });
      // No terminate on failure: it would end the agent loop, so the model
      // could never read the per-task results and retry.
      return {
        content: [{ type: "text", text: renderBlocking(records) }],
        details: { results: records.map((r) => ({ id: r.id, type: r.type, task: r.task, status: r.status })) },
      };
    },
  });

  // D3: parent-facing re-engagement. Sequential execution mode plus the
  // synchronous checks below (before the first spawn) close the check-then-act
  // windows against concurrent sends and the operator hotkey (D9).
  pi.registerTool<typeof SendParams, { sent?: unknown; results?: unknown }>({
    name: "subagents_send",
    label: "Subagents: send",
    description: [
      "Send a new prompt to an existing subagent, identified by the id in its result header or dispatch acknowledgement.",
      "A terminal agent (done/failed/aborted) resumes its durable session with full prior context — transcript, usage, and identity are preserved; the result arrives as a follow-up message like any other engagement (inline in non-interactive mode).",
      "With interrupt: true, an in-flight agent is killed (SIGTERM with escalation) and immediately resumed on its session with the new message as a corrective prompt; the killed engagement delivers no aborted diagnostics.",
      "Without interrupt, a send to a running agent is rejected — wait for its result or pass interrupt: true.",
      "Re-engagement is scoped to the current working directory; a missing durable session file fails the send explicitly instead of silently starting a blank session.",
    ].join(" "),
    promptSnippet:
      "subagents_send — re-engage a finished subagent with full prior context, or kill-and-redirect an in-flight one via interrupt: true.",
    promptGuidelines: [
      "Address agents by the id in their result header (e.g. [subagent task sa-8fk2 — done] …).",
      "Prefer re-engaging over redispatching when an agent needs feedback or correction — it keeps its context; route reviewer feedback to the implementer's id.",
      "Sends run sequentially; cap fix iterations (2–3) before reporting residual issues back instead of ping-ponging.",
    ],
    parameters: SendParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: SendParamsType, signal, _onUpdate, ctx) {
      const record = registry.get(params.id);
      if (!record) {
        const known = [...registry.keys()].join(", ");
        throw new Error(`Unknown subagent id "${params.id}". Known ids: ${known || "none (nothing dispatched this session)"}.`);
      }
      if (!params.message.trim()) throw new Error("message is empty.");

      let redirected = false;
      if (record.child || record.run) {
        // In flight — a live child, or an engagement claimed but not yet
        // spawned (record.run is set synchronously; record.child only after
        // the prompt staging awaits). Without interrupt this is a rejection,
        // not a queue (D3), and the check covers the pre-spawn window too
        // (review finding 1: a second send used to slip through and drop its
        // message while clobbering the first engagement's prompt).
        if (!params.interrupt) {
          throw new Error(
            `Subagent ${record.id} (${record.type}) is still running. Wait for its result, or resend with interrupt: true to kill it and redirect.`,
          );
        }
        redirected = true;
        if (record.child) {
          // D11: the killed engagement persists its completion entry but
          // delivers no aborted diagnostics — the suppression is attributed
          // inside killChildEscalating, so it applies only when this call
          // actually initiates the kill of a live child (review finding 8).
          killChildEscalating(record, { suppressDelivery: true });
        } else {
          // Claimed but not yet spawned: abort the pending engagement at
          // runChild's pre-spawn check; D11 keeps its (empty) aborted entry
          // undelivered.
          record.suppressNextDelivery = true;
          record.abortRequested = true;
          record.status = "aborted";
        }
        guard(repaintIndicator);
        await record.run;
      }

      // D9c: a restored record whose recorded child may still be running must
      // not gain a second writer on its session file. Fails safe on EPERM.
      if (record.restored && record.pid !== undefined && pidAlive(record.pid)) {
        throw new Error(
          `Refusing to re-engage ${record.id}: recorded child process ${record.pid} appears to still be running (orphaned from a previous pi run) and may be writing its durable session.`,
        );
      }
      // D8: a previous resume that recreated a blank session poisons this
      // agent for good — the flag is persisted on that failed engagement's
      // completion entry and restored with the record. The blank file now
      // exists, so the existence scan alone would silently "succeed" (review
      // finding 3).
      if (record.resumeSessionMissing) {
        throw new Error(
          `Cannot re-engage ${record.id}: its durable session went missing on a previous attempt (the resume child recreated a blank one). Dispatch a fresh subagent instead.`,
        );
      }
      // D9c: a restored record whose recorded child may still be running must
      // not gain a second writer on its session file. Fails safe on EPERM.
      if (record.restored && record.pid !== undefined && pidAlive(record.pid)) {
        throw new Error(
          `Refusing to re-engage ${record.id}: recorded child process ${record.pid} appears to still be running (orphaned from a previous pi run) and may be writing its durable session.`,
        );
      }
      // D8: no durable session, no re-engagement — never silently create one.
      // A scan error (permissions, fd exhaustion) is distinct from a miss and
      // must not be misdiagnosed as "session missing" (review finding 9).
      let sessionPresent: boolean;
      try {
        sessionPresent = sessionFileExists(record.id);
      } catch (error) {
        throw new Error(
          `Cannot re-engage ${record.id}: durable session directory could not be scanned (${error instanceof Error ? error.message : String(error)}). Not attempting a resume on an unverifiable session.`,
        );
      }
      if (!sessionPresent) {
        throw new Error(
          `Cannot re-engage ${record.id}: durable session missing (never created — e.g. the agent was killed before its first response — or reclaimed). Dispatch a fresh subagent instead.`,
        );
      }

      // D4: reset the engagement-scoped fields — including un-terminalizing a
      // restored-lost record — or the resumed engagement never finalizes.
      beginEngagement(record, params.message);
      guard(repaintIndicator);

      if (ctx.mode === "tui") {
        void runEngagement(record, ctx.cwd, { resume: true, deliver: true, message: params.message });
        const verb = redirected ? "interrupted and redirected" : "re-engaged";
        const ack = `Sent to subagent ${record.type} ${record.id} (${verb}). It resumes its durable session with your message as the new prompt; its result will arrive automatically as a follow-up message. Do not wait inline.`;
        return {
          content: [{ type: "text", text: ack }],
          details: { sent: { id: record.id, type: record.type, task: record.task, status: record.status } },
        };
      }

      await runEngagement(record, ctx.cwd, { resume: true, deliver: false, signal, message: params.message });
      return {
        content: [{ type: "text", text: resultBody(record) }],
        details: { results: [{ id: record.id, type: record.type, task: record.task, status: record.status }] },
      };
    },
  });
}
