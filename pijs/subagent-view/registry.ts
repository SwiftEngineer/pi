/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/subagent-view/registry.ts. Pure in-memory logic ports
 * 1:1. Adaptations:
 *  1. `tailBytes` (the only Buffer user here) moves to `../_shared/text.ts` so
 *     the `task` tool and this registry share one UTF-8 tail implementation
 *     (§5.4). Imported instead of defined inline.
 *  2. The `@earendil-works/pi-agent-core` import is `import type` only (erased at
 *     runtime); the sole runtime value import is the local `./transcript.ts`.
 *  3. The `globalThis.__piSubagentRegistry__` singleton is preserved EXACTLY —
 *     the `task` tool writes it and (in Phase 5) `subagent-view` reads it. Whether
 *     two `pi.extensions` entries share one QuickJS global is still unconfirmed
 *     (§5.5 / §9 #7); if isolated, the two extensions must merge into one entry.
 *     For Phase 4 only `task` touches it, so it works regardless.
 *  4. ⚠ `#private` fields/methods → `private`-modifier members. The Rust QuickJS
 *     loader's TS transpiler corrupts on a type annotation on a private-field
 *     declaration line (`#f: T = v` throws "undefined private field" at load —
 *     empirically verified). Type-only PUBLIC declarations strip fine, so all
 *     fields are declared type-only and initialized in the constructor, and the
 *     former `#methods` use the `private` modifier. Same pattern in
 *     `../_shared/text.ts` (`BoundedText`).
 *
 * ── original module docstring ────────────────────────────────────────────────
 * Shared, in-memory registry of sub-agents spawned by the `task` tool. The
 * `task` extension pushes lifecycle + streaming updates here as it runs child
 * `pi` processes; the `subagent-view` extension subscribes to render the live
 * panel. The two extensions are separate modules, so the registry is a
 * process-wide singleton (stashed on `globalThis`).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageToBlocks, type TranscriptBlock } from "./transcript.ts";
import { tailBytes } from "../_shared/text.ts";

/** Lifecycle state of a single sub-agent. */
export type SubagentState = "pending" | "running" | "done" | "error";

/** Immutable view of a sub-agent, handed to the renderer. */
export interface SubagentSnapshot {
  readonly id: string;
  /** Short UI label (the task description). */
  readonly label: string;
  /** Agent kind, e.g. "explore", "reviewer", "task". */
  readonly agentKind: string;
  readonly state: SubagentState;
  /** Human-readable current activity, e.g. "reasoning" or "using read". */
  readonly phase: string;
  /** Name of the tool the sub-agent is currently running, if any. */
  readonly tool: string | undefined;
  /** Rolling tail of streamed assistant text for the current message. */
  readonly text: string;
  /** Rolling tail of streamed thinking for the current message. */
  readonly thinking: string;
  /** Append-only finalized transcript (most recent history), built from `message_end`. */
  readonly blocks: readonly TranscriptBlock[];
  /** Count of oldest blocks dropped by the per-channel memory cap (0 ⇒ full history). */
  readonly trimmedBlocks: number;
  /** Final result text once the sub-agent finishes. */
  readonly final: string | undefined;
  /** Outcome label once finished, e.g. "completed" / "failed (1)" / "timed out". */
  readonly exitInfo: string | undefined;
  readonly startedAt: number;
  readonly finishedAt: number | undefined;
}

/** Partial live update applied during streaming. */
export interface SubagentLiveUpdate {
  phase?: string;
  /** `null` clears the current tool; `undefined` leaves it unchanged. */
  tool?: string | null;
  /** Text delta appended to the streaming buffer. */
  appendText?: string;
  /** Thinking delta appended to the streaming buffer. */
  appendThinking?: string;
  /** Replaces the streaming text buffer (used at message boundaries). */
  resetText?: boolean;
}

/** Final outcome reported when a sub-agent process settles. */
export interface SubagentFinish {
  state: "done" | "error";
  final?: string | undefined;
  exitInfo?: string | undefined;
}

const MAX_LIVE_TEXT_BYTES = 8 * 1024;

interface SubagentRecord {
  id: string;
  label: string;
  agentKind: string;
  state: SubagentState;
  phase: string;
  tool: string | undefined;
  text: string;
  thinking: string;
  blocks: TranscriptBlock[];
  trimmedBlocks: number;
  final: string | undefined;
  exitInfo: string | undefined;
  startedAt: number;
  finishedAt: number | undefined;
}

/**
 * Per-channel cap on the append-only transcript so a long-running sub-agent
 * can't grow memory without bound. When `blocks` exceeds {@link MAX_BLOCKS} the
 * oldest are dropped down to {@link KEEP_BLOCKS}; the renderer shows a
 * "N earlier messages trimmed" marker via the `trimmedBlocks` count.
 */
const MAX_BLOCKS = 5000;
const KEEP_BLOCKS = 4000;

function snapshot(record: SubagentRecord): SubagentSnapshot {
  return {
    id: record.id,
    label: record.label,
    agentKind: record.agentKind,
    state: record.state,
    phase: record.phase,
    tool: record.tool,
    text: record.text,
    thinking: record.thinking,
    blocks: record.blocks,
    trimmedBlocks: record.trimmedBlocks,
    final: record.final,
    exitInfo: record.exitInfo,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

/**
 * Tracks every sub-agent for the current agent run and which one the user is
 * watching. Emits a change event (coalesced by listeners) on any mutation.
 */
export class SubagentRegistry {
  private records: Map<string, SubagentRecord>;
  /** Insertion order, so the status-symbol row stays stable. */
  private order: string[];
  private currentWatchedId: string | null;
  /** True once the user manually cycles; disables auto-follow. */
  private manualWatch: boolean;
  private listeners: Set<() => void>;

  constructor() {
    this.records = new Map();
    this.order = [];
    this.currentWatchedId = null;
    this.manualWatch = false;
    this.listeners = new Set();
  }

  /** Subscribe to change notifications. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A misbehaving listener must not break registry mutation.
      }
    }
  }

  /** Register a sub-agent before it starts (shows immediately as pending). */
  add(id: string, label: string, agentKind: string): void {
    if (this.records.has(id)) return;
    const now = Date.now();
    this.records.set(id, {
      id,
      label: label || id,
      agentKind,
      state: "pending",
      phase: "queued",
      tool: undefined,
      text: "",
      thinking: "",
      blocks: [],
      trimmedBlocks: 0,
      final: undefined,
      exitInfo: undefined,
      startedAt: now,
      finishedAt: undefined,
    });
    this.order.push(id);
    this.autoSelect();
    this.notify();
  }

  /** Mark a sub-agent as actively running. */
  start(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.state = "running";
    record.phase = "starting";
    record.startedAt = Date.now();
    this.autoSelect();
    this.notify();
  }

  /** Apply a streaming update. */
  update(id: string, patch: SubagentLiveUpdate): void {
    const record = this.records.get(id);
    if (!record || record.state === "done" || record.state === "error") return;
    if (patch.resetText) {
      record.text = "";
      record.thinking = "";
    }
    if (patch.phase !== undefined) record.phase = patch.phase;
    if (patch.tool !== undefined) record.tool = patch.tool ?? undefined;
    if (patch.appendText) record.text = tailBytes(record.text + patch.appendText, MAX_LIVE_TEXT_BYTES);
    if (patch.appendThinking) {
      record.thinking = tailBytes(record.thinking + patch.appendThinking, MAX_LIVE_TEXT_BYTES);
    }
    this.notify();
  }

  /**
   * Append a finalized message to the channel's append-only transcript.
   * Driven by `message_end` (main session) or the reconstructed `message_end`
   * events of a child `pi --mode json` stream (sub-agents). Unlike the live
   * `text`/`thinking` tail, this is never truncated, so full history survives.
   */
  appendMessage(id: string, message: AgentMessage): void {
    const record = this.records.get(id);
    if (!record) return;
    const blocks = messageToBlocks(message);
    if (blocks.length === 0) return;
    record.blocks.push(...blocks);
    this.capBlocks(record);
    // The message is now finalized into history; clear the live streaming tail
    // so it isn't shown twice (once in blocks, once as in-flight text).
    record.text = "";
    record.thinking = "";
    this.notify();
  }

  /**
   * Append a free-standing meta marker (e.g. a retry/compaction notice that
   * isn't carried by a `message_end`) to the channel's transcript.
   */
  appendMeta(id: string, text: string): void {
    const record = this.records.get(id);
    if (!record) return;
    const clean = text.trim();
    if (!clean) return;
    record.blocks.push({ kind: "meta", text: clean });
    this.capBlocks(record);
    this.notify();
  }

  /** Enforce the per-channel block cap, tracking how many were dropped. */
  private capBlocks(record: SubagentRecord): void {
    if (record.blocks.length <= MAX_BLOCKS) return;
    const drop = record.blocks.length - KEEP_BLOCKS;
    record.blocks.splice(0, drop);
    record.trimmedBlocks += drop;
  }

  /** Settle a sub-agent with its final outcome. */
  finish(id: string, outcome: SubagentFinish): void {
    const record = this.records.get(id);
    if (!record) return;
    record.state = outcome.state;
    record.phase = outcome.state === "error" ? "failed" : "done";
    record.tool = undefined;
    record.final = outcome.final;
    record.exitInfo = outcome.exitInfo;
    record.finishedAt = Date.now();
    this.autoSelect();
    this.notify();
  }

  /**
   * Until the user manually cycles, follow the first running sub-agent (the one
   * most likely to be actively streaming), falling back to the first pending or
   * any sub-agent. This keeps the feed on a working agent and only advances when
   * the watched one finishes, rather than jumping on every new start.
   */
  private autoSelect(): void {
    if (this.manualWatch) return;
    this.currentWatchedId = this.preferredId();
  }

  private preferredId(): string | null {
    let firstPending: string | null = null;
    let firstAny: string | null = null;
    for (const id of this.order) {
      const record = this.records.get(id);
      if (!record) continue;
      if (firstAny === null) firstAny = id;
      if (record.state === "running") return id;
      if (record.state === "pending" && firstPending === null) firstPending = id;
    }
    return firstPending ?? firstAny;
  }

  /** All sub-agents in stable insertion order. */
  list(): SubagentSnapshot[] {
    const out: SubagentSnapshot[] = [];
    for (const id of this.order) {
      const record = this.records.get(id);
      if (record) out.push(snapshot(record));
    }
    return out;
  }

  isEmpty(): boolean {
    return this.records.size === 0;
  }

  size(): number {
    return this.records.size;
  }

  counts(): { running: number; finished: number; total: number } {
    let running = 0;
    let finished = 0;
    for (const record of this.records.values()) {
      if (record.state === "done" || record.state === "error") finished++;
      else running++;
    }
    return { running, finished, total: this.records.size };
  }

  /** The sub-agent currently being watched, if any. */
  watched(): SubagentSnapshot | undefined {
    if (this.currentWatchedId === null) return undefined;
    const record = this.records.get(this.currentWatchedId);
    return record ? snapshot(record) : undefined;
  }

  watchedIndex(): number {
    if (this.currentWatchedId === null) return -1;
    return this.order.indexOf(this.currentWatchedId);
  }

  watchedId(): string | null {
    return this.currentWatchedId;
  }

  /** Watch a specific sub-agent by id. Marks the watch as user-driven. */
  setWatched(id: string): void {
    if (!this.records.has(id)) return;
    this.manualWatch = true;
    if (this.currentWatchedId !== id) {
      this.currentWatchedId = id;
      this.notify();
    }
  }

  /** Cycle the watched sub-agent by `delta` (wrapping). */
  cycle(delta: number): void {
    const length = this.order.length;
    if (length === 0) return;
    this.manualWatch = true;
    const current = this.currentWatchedId === null ? -1 : this.order.indexOf(this.currentWatchedId);
    const base = current < 0 ? 0 : current;
    const next = (((base + delta) % length) + length) % length;
    const nextId = this.order[next];
    if (nextId !== undefined && nextId !== this.currentWatchedId) {
      this.currentWatchedId = nextId;
      this.notify();
    }
  }

  /** Remove every sub-agent and reset watch state (new agent run). */
  reset(): void {
    if (this.records.size === 0 && this.currentWatchedId === null && !this.manualWatch) return;
    this.records.clear();
    this.order = [];
    this.currentWatchedId = null;
    this.manualWatch = false;
    this.notify();
  }
}

const GLOBAL_KEY = "__piSubagentRegistry__";
const globalStore = globalThis as unknown as Record<string, SubagentRegistry | undefined>;

/** Process-wide singleton shared by the `task` and `subagent-view` extensions. */
export const subagentRegistry: SubagentRegistry =
  globalStore[GLOBAL_KEY] ?? (globalStore[GLOBAL_KEY] = new SubagentRegistry());
