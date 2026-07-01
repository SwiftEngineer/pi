/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/subagent-view/view-state.ts. Pure selection/scroll
 * logic ports 1:1. Adaptations:
 *  1. Value import `WrappedBuffer`/`maxTop` from `./scrollback.ts`;
 *     `import type { Theme }` erased at runtime.
 *  2. ⚠ ALL `#private` fields/methods → `private`-modifier members declared
 *     type-only + initialized in the constructor. The QuickJS TS loader corrupts
 *     on a typed `#field = value` declaration ("undefined private field" at
 *     load); the same fix is applied in `registry.ts`/`scrollback.ts`.
 *
 * For the OVERLAY-ONLY port the scroll/anchor machinery is effectively dead
 * (the strip renders with total=0/viewport=1), but `SubagentViewState` is still
 * the object `statusStripLines` consumes for selection + unread state, so it is
 * ported whole.
 *
 * ── original module docstring ────────────────────────────────────────────────
 * View-state controller for the sub-agent pager: which channel is selected,
 * per-channel scroll position, unread tracking, and the spinner frame. The main
 * agent is channel 0; sub-agents follow in registry order.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentRegistry, SubagentSnapshot } from "./registry.ts";
import { maxTop, WrappedBuffer } from "./scrollback.ts";

export const MAIN_CHANNEL = "main";

/** A resize-stable scroll position. */
type Anchor =
  | { kind: "tail" }
  | { kind: "block"; blockAbs: number; offset: number }
  | { kind: "fromBottom"; lines: number };

interface ScrollState {
  anchor: Anchor;
}

function newScrollState(): ScrollState {
  return { anchor: { kind: "tail" } };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/** Encode an agent's output progress so we can detect "new since last viewed". */
function revisionOf(agent: SubagentSnapshot): number {
  // Include trimmed blocks so the count stays monotonic across memory-cap trims.
  return (agent.trimmedBlocks + agent.blocks.length) * 1_000_000 + agent.text.length + agent.thinking.length;
}

export class SubagentViewState {
  spinnerFrame = 0;

  private selected: string;
  private readonly scroll: Map<string, ScrollState>;
  private readonly buffers: Map<string, WrappedBuffer>;
  private readonly seenRev: Map<string, number>;
  private readonly newOutput: Set<string>;

  // Cached from the last render so the input handler can scroll without
  // recomputing the frame geometry.
  private lastViewport: number;
  private lastTotal: number;
  private lastWidth: number;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly getTheme: () => Theme,
  ) {
    this.selected = MAIN_CHANNEL;
    this.scroll = new Map();
    this.buffers = new Map();
    this.seenRev = new Map();
    this.newOutput = new Set();
    this.lastViewport = 1;
    this.lastTotal = 0;
    this.lastWidth = 1;
  }

  get selectedId(): string {
    return this.selected;
  }

  isMainSelected(): boolean {
    return this.selected === MAIN_CHANNEL;
  }

  /** Channel ids in display order: main first, then sub-agents. */
  channelIds(): string[] {
    return [MAIN_CHANNEL, ...this.registry.list().map((agent) => agent.id)];
  }

  selectedIndex(): number {
    const index = this.channelIds().indexOf(this.selected);
    return index < 0 ? 0 : index;
  }

  private scrollState(id: string): ScrollState {
    let state = this.scroll.get(id);
    if (!state) {
      state = newScrollState();
      this.scroll.set(id, state);
    }
    return state;
  }

  buffer(id: string): WrappedBuffer {
    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = new WrappedBuffer(this.getTheme);
      this.buffers.set(id, buffer);
    }
    return buffer;
  }

  /** Select a channel by id. Clears its unread flag. Returns false if unknown. */
  select(id: string): boolean {
    if (!this.channelIds().includes(id)) return false;
    this.selected = id;
    this.newOutput.delete(id);
    this.markSeen(id);
    return true;
  }

  /** Cycle selection by `delta` over [main, ...sub-agents] (wrapping). */
  cycle(delta: number): void {
    const ids = this.channelIds();
    if (ids.length === 0) return;
    const next = (((this.selectedIndex() + delta) % ids.length) + ids.length) % ids.length;
    const id = ids[next];
    if (id) this.select(id);
  }

  selectMain(): void {
    this.select(MAIN_CHANNEL);
  }

  hasNewOutput(id: string): boolean {
    return this.newOutput.has(id);
  }

  /** Record the active channel's frame geometry so input handlers can scroll. */
  rememberGeometry(total: number, viewport: number, width: number): void {
    this.lastTotal = total;
    this.lastViewport = Math.max(1, viewport);
    this.lastWidth = Math.max(1, width);
  }

  /**
   * One page = the visible scrollback viewport minus one line of overlap, so
   * consecutive PgUp/PgDn presses leave a shared line between pages.
   */
  pageRows(): number {
    const overlap = Math.max(1, this.lastViewport - 1);
    return Math.max(1, Math.min(overlap, this.lastTotal));
  }

  /** Last rendered geometry, for the `PI_SUBAGENT_DEBUG` diagnostic log. */
  lastGeometry(): { total: number; viewport: number; pageRows: number } {
    return { total: this.lastTotal, viewport: this.lastViewport, pageRows: this.pageRows() };
  }

  /** Resolve the anchor to a concrete top display-line for the given geometry. */
  windowTop(id: string, total: number, viewport: number, width: number): number {
    const limit = maxTop(total, viewport);
    const anchor = this.scrollState(id).anchor;
    switch (anchor.kind) {
      case "tail":
        return limit;
      case "fromBottom":
        return clamp(limit - anchor.lines, 0, limit);
      case "block": {
        const buffer = this.buffers.get(id);
        if (!buffer) return limit;
        const local = anchor.blockAbs - this.trimmedBlocks(id);
        return clamp(buffer.blockStart(local, width) + anchor.offset, 0, limit);
      }
    }
  }

  private trimmedBlocks(id: string): number {
    return this.registry.list().find((agent) => agent.id === id)?.trimmedBlocks ?? 0;
  }

  /** Re-anchor the selected channel to a concrete top line (tail when at bottom). */
  private setTop(id: string, top: number): void {
    const state = this.scrollState(id);
    const limit = maxTop(this.lastTotal, this.lastViewport);
    if (top >= limit) {
      state.anchor = { kind: "tail" };
      return;
    }
    const clamped = Math.max(0, top);
    if (id === MAIN_CHANNEL) {
      state.anchor = { kind: "fromBottom", lines: limit - clamped };
      return;
    }
    const buffer = this.buffers.get(id);
    if (!buffer) {
      state.anchor = { kind: "fromBottom", lines: limit - clamped };
      return;
    }
    const { block, offset } = buffer.blockAtLine(clamped, this.lastWidth);
    state.anchor = { kind: "block", blockAbs: this.trimmedBlocks(id) + block, offset };
  }

  scrollActive(delta: number): void {
    const id = this.selected;
    const current = this.windowTop(id, this.lastTotal, this.lastViewport, this.lastWidth);
    this.setTop(id, current + delta);
  }

  scrollActiveToTop(): void {
    this.setTop(this.selected, 0);
  }

  scrollActiveToBottom(): void {
    this.scrollState(this.selected).anchor = { kind: "tail" };
  }

  /** True while the active channel is scrolled off its live tail. */
  activeIsScrolled(): boolean {
    const top = this.windowTop(this.selected, this.lastTotal, this.lastViewport, this.lastWidth);
    return maxTop(this.lastTotal, this.lastViewport) - top > 0;
  }

  /**
   * Recompute unread flags after a registry change: a sub-agent that produced
   * new output while it was NOT the selected channel is marked unread.
   */
  noteRegistryChange(): void {
    for (const agent of this.registry.list()) {
      const rev = revisionOf(agent);
      const seen = this.seenRev.get(agent.id) ?? -1;
      if (rev <= seen) continue;
      if (agent.id === this.selected) this.seenRev.set(agent.id, rev);
      else this.newOutput.add(agent.id);
    }
    this.prune();
  }

  private markSeen(id: string): void {
    if (id === MAIN_CHANNEL) return;
    const agent = this.registry.list().find((candidate) => candidate.id === id);
    if (agent) this.seenRev.set(id, revisionOf(agent));
  }

  /** Drop per-channel state for sub-agents that no longer exist. */
  private prune(): void {
    const live = new Set(this.channelIds());
    for (const map of [this.scroll, this.buffers, this.seenRev]) {
      for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key);
    }
    for (const key of [...this.newOutput]) if (!live.has(key)) this.newOutput.delete(key);
    if (!live.has(this.selected)) this.selected = MAIN_CHANNEL;
  }

  /** Reset to a clean slate for a new agent run. */
  reset(): void {
    this.selected = MAIN_CHANNEL;
    this.spinnerFrame = 0;
    this.scroll.clear();
    this.buffers.clear();
    this.seenRev.clear();
    this.newOutput.clear();
    this.lastViewport = 1;
    this.lastTotal = 0;
    this.lastWidth = 1;
  }
}
