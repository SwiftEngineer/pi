/**
 * View-state controller for the sub-agent pager: which channel is selected,
 * per-channel scroll position, unread tracking, and the spinner
 * frame. The main agent is channel 0; sub-agents follow in registry order.
 *
 * Kept separate from the lifecycle wiring (index.ts) and the frame composition
 * (split.ts) so it can be exercised headlessly by the smoke harness.
 *
 * @see ./scrollback.ts for the scroll primitives and WrappedBuffer.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentRegistry, SubagentSnapshot } from "./registry.ts";
import { newScrollState, type ScrollState, scrollLines, scrollToBottom, scrollToTop, WrappedBuffer } from "./scrollback.ts";

export const MAIN_CHANNEL = "main";

/** Encode an agent's output progress so we can detect "new since last viewed". */
function revisionOf(agent: SubagentSnapshot): number {
  return agent.blocks.length * 1_000_000 + agent.text.length + agent.thinking.length;
}

export class SubagentViewState {
  #selectedId: string = MAIN_CHANNEL;
  spinnerFrame = 0;

  readonly #scroll = new Map<string, ScrollState>();
  readonly #buffers = new Map<string, WrappedBuffer>();
  readonly #seenRev = new Map<string, number>();
  readonly #newOutput = new Set<string>();

  // Cached from the last render so the input handler can scroll without
  // recomputing the frame geometry.
  #lastViewport = 1;
  #lastTotal = 0;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly getTheme: () => Theme,
  ) {}

  get selectedId(): string {
    return this.#selectedId;
  }

  isMainSelected(): boolean {
    return this.#selectedId === MAIN_CHANNEL;
  }

  /** Channel ids in display order: main first, then sub-agents. */
  channelIds(): string[] {
    return [MAIN_CHANNEL, ...this.registry.list().map((agent) => agent.id)];
  }

  selectedIndex(): number {
    const index = this.channelIds().indexOf(this.#selectedId);
    return index < 0 ? 0 : index;
  }

  scrollState(id: string): ScrollState {
    let state = this.#scroll.get(id);
    if (!state) {
      state = newScrollState();
      this.#scroll.set(id, state);
    }
    return state;
  }

  buffer(id: string): WrappedBuffer {
    let buffer = this.#buffers.get(id);
    if (!buffer) {
      buffer = new WrappedBuffer(this.getTheme);
      this.#buffers.set(id, buffer);
    }
    return buffer;
  }

  /** Select a channel by id. Clears its unread flag. Returns false if unknown. */
  select(id: string): boolean {
    if (!this.channelIds().includes(id)) return false;
    this.#selectedId = id;
    this.#newOutput.delete(id);
    this.#markSeen(id);
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
    return this.#newOutput.has(id);
  }

  /** Record the active channel's frame geometry so input handlers can scroll. */
  rememberGeometry(total: number, viewport: number): void {
    this.#lastTotal = total;
    this.#lastViewport = Math.max(1, viewport);
  }

  /**
   * One page = the visible scrollback viewport minus one line of overlap, so
   * consecutive PgUp/PgDn presses leave a shared line between pages and never
   * skip content. Capped at the line count so we never page past the buffer.
   */
  pageRows(): number {
    const overlap = Math.max(1, this.#lastViewport - 1);
    return Math.max(1, Math.min(overlap, this.#lastTotal));
  }

  /** Last rendered geometry, for the `PI_SUBAGENT_DEBUG` diagnostic log. */
  lastGeometry(): { total: number; viewport: number; pageRows: number } {
    return { total: this.#lastTotal, viewport: this.#lastViewport, pageRows: this.pageRows() };
  }

  scrollActive(delta: number): void {
    scrollLines(this.scrollState(this.#selectedId), delta, this.#lastTotal, this.#lastViewport);
  }

  scrollActiveToTop(): void {
    scrollToTop(this.scrollState(this.#selectedId), this.#lastTotal, this.#lastViewport);
  }

  scrollActiveToBottom(): void {
    scrollToBottom(this.scrollState(this.#selectedId));
  }

  /** True while the active channel is scrolled off its live tail. */
  activeIsScrolled(): boolean {
    const state = this.scrollState(this.#selectedId);
    if (state.followTail) return false;
    const limit = Math.max(0, this.#lastTotal - this.#lastViewport);
    return Math.min(Math.max(0, state.top), limit) < limit;
  }

  /**
   * Recompute unread flags after a registry change: a sub-agent that produced
   * new output while it was NOT the selected channel is marked unread.
   */
  noteRegistryChange(): void {
    for (const agent of this.registry.list()) {
      const rev = revisionOf(agent);
      const seen = this.#seenRev.get(agent.id) ?? -1;
      if (rev <= seen) continue;
      if (agent.id === this.#selectedId) this.#seenRev.set(agent.id, rev);
      else this.#newOutput.add(agent.id);
    }
    this.#prune();
  }

  #markSeen(id: string): void {
    if (id === MAIN_CHANNEL) return;
    const agent = this.registry.list().find((candidate) => candidate.id === id);
    if (agent) this.#seenRev.set(id, revisionOf(agent));
  }

  /** Drop per-channel state for sub-agents that no longer exist. */
  #prune(): void {
    const live = new Set(this.channelIds());
    for (const map of [this.#scroll, this.#buffers, this.#seenRev]) {
      for (const key of [...map.keys()]) if (!live.has(key)) map.delete(key);
    }
    for (const key of [...this.#newOutput]) if (!live.has(key)) this.#newOutput.delete(key);
    if (!live.has(this.#selectedId)) this.#selectedId = MAIN_CHANNEL;
  }

  /** Reset to a clean slate for a new agent run. */
  reset(): void {
    this.#selectedId = MAIN_CHANNEL;
    this.spinnerFrame = 0;
    this.#scroll.clear();
    this.#buffers.clear();
    this.#seenRev.clear();
    this.#newOutput.clear();
    this.#lastViewport = 1;
    this.#lastTotal = 0;
  }
}
