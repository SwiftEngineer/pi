/**
 * The virtual-pager engine for the sub-agent view.
 *
 * A "channel" (the main agent, or one sub-agent) is shown by slicing a window of
 * pre-rendered display lines into the frame, so switching and scrolling are
 * O(viewport) regardless of how massive the channel's history is. This module is
 * intentionally pure/UI-agnostic (operates on `string[]` line buffers and a
 * small {@link ScrollState}), so it is fully exercisable headlessly by the smoke
 * harness — important because the live TUI can't be verified until merge.
 *
 * - {@link renderBlocks} turns a sub-agent's structured transcript blocks into
 *   styled, width-wrapped display lines (the main channel reuses pi's own
 *   natively-rendered transcript lines instead).
 * - {@link composeFrame} composites `[ scrollback window ] + [ pinned chrome ] +
 *   [ strip ]` into exactly `height` rows, with a loud "viewing history" banner
 *   when scrolled off the live tail.
 *
 * @see ./transcript.ts for the block model. @see ./split.ts for the frame hook.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptBlock } from "./transcript.ts";

/** Per-channel scroll position. `followTail` pins the view to the latest output. */
export interface ScrollState {
  /** Top display-line index, used only when not following the tail. */
  top: number;
  /** When true, the view stays pinned to the bottom (newest) as content grows. */
  followTail: boolean;
}

export function newScrollState(): ScrollState {
  return { top: 0, followTail: true };
}

/** Largest valid top offset for `total` lines in a `viewport`-row window. */
export function maxTop(total: number, viewport: number): number {
  return Math.max(0, total - viewport);
}

/** The effective top line index for the current state. */
export function resolveTop(state: ScrollState, total: number, viewport: number): number {
  if (state.followTail) return maxTop(total, viewport);
  return Math.min(Math.max(0, state.top), maxTop(total, viewport));
}

/** How many lines are hidden below the viewport (0 ⇒ pinned to the tail). */
export function linesBelow(state: ScrollState, total: number, viewport: number): number {
  return maxTop(total, viewport) - resolveTop(state, total, viewport);
}

/** Scroll by `delta` lines (negative = up). Re-pins to the tail at the bottom. */
export function scrollLines(state: ScrollState, delta: number, total: number, viewport: number): void {
  const limit = maxTop(total, viewport);
  const next = Math.min(Math.max(0, resolveTop(state, total, viewport) + delta), limit);
  state.top = next;
  state.followTail = next >= limit;
}

/** Jump to the top of the history (oldest). */
export function scrollToTop(state: ScrollState, total: number, viewport: number): void {
  state.top = 0;
  state.followTail = total <= viewport;
}

/** Jump to the live tail (newest) and resume following it. */
export function scrollToBottom(state: ScrollState): void {
  state.followTail = true;
  state.top = 0;
}

/** Fit a line to an exact column budget (ellipsis on overflow), ANSI-aware. */
function fitLine(line: string, width: number): string {
  return truncateToWidth(line, width, "…", true);
}

/** Force a block of lines to exactly `height` rows, keeping the pinned bottom. */
function normalizeHeight(lines: string[], height: number): string[] {
  if (lines.length === height) return lines;
  if (lines.length > height) return lines.slice(lines.length - height);
  const out = lines.slice();
  while (out.length < height) out.push("");
  return out;
}

export interface ComposeParts {
  /** The active channel's full display-line buffer (native transcript or wrapped sub-agent lines). */
  windowLines: string[];
  /** Pinned bottom chrome (editor + powerline footer), rendered natively — passed through verbatim. */
  chromeLines: string[];
  /** The pinned sub-agent status strip — passed through verbatim, always at the very bottom. */
  stripLines: string[];
  width: number;
  height: number;
  scroll: ScrollState;
  /** Builds the loud "viewing history" banner shown when scrolled up. */
  banner?: (linesBelow: number, width: number) => string;
}

/**
 * Composite the final frame: a scrollable window of the active channel above a
 * permanently-pinned chrome+strip region. Always returns exactly `height` rows.
 *
 * The cursor marker only ever lives in `chromeLines` (the editor), which is
 * always rendered — so the hardware cursor is never lost, even when scrolled up.
 */
export function composeFrame(parts: ComposeParts): string[] {
  const { windowLines, chromeLines, stripLines, width, height, scroll } = parts;
  const reserved = chromeLines.length + stripLines.length;
  const viewport = Math.max(1, height - reserved);
  const total = windowLines.length;
  const top = resolveTop(scroll, total, viewport);
  const below = maxTop(total, viewport) - top;

  const content: string[] = [];
  for (let i = 0; i < viewport; i++) {
    content.push(fitLine(windowLines[top + i] ?? "", width));
  }
  // Loud not-live banner overlays the bottom window row (closest to the prompt).
  if (below > 0 && parts.banner) {
    content[viewport - 1] = fitLine(parts.banner(below, width), width);
  }

  return normalizeHeight([...content, ...chromeLines, ...stripLines], height);
}

/** Render a sub-agent's transcript blocks into styled, width-wrapped lines. */
export function renderBlocks(blocks: readonly TranscriptBlock[], width: number, theme: Theme): string[] {
  const wrapWidth = Math.max(1, width);
  const out: string[] = [];
  let first = true;
  for (const block of blocks) {
    if (!first) out.push("");
    first = false;
    for (const line of renderBlock(block, wrapWidth, theme)) out.push(line);
  }
  return out;
}

function renderBlock(block: TranscriptBlock, width: number, theme: Theme): string[] {
  switch (block.kind) {
    case "user":
      return wrapTextWithAnsi(`${theme.fg("accent", "❯")} ${block.text}`, width);
    case "thinking":
      return wrapTextWithAnsi(theme.fg("dim", block.text), width);
    case "text":
      return wrapTextWithAnsi(block.text, width);
    case "toolcall": {
      const head = `${theme.fg("warning", "→")} ${theme.bold(block.label ?? "tool")}`;
      const line = block.text ? `${head} ${theme.fg("dim", block.text)}` : head;
      return wrapTextWithAnsi(line, width);
    }
    case "toolresult": {
      const mark = block.isError ? theme.fg("error", "←") : theme.fg("success", "←");
      const head = `${mark} ${theme.fg("muted", block.label ?? "result")}${block.isError ? theme.fg("error", " ✗") : ""}`;
      const lines = [head];
      if (block.text) {
        for (const line of wrapTextWithAnsi(theme.fg("dim", block.text), width)) lines.push(line);
      }
      return lines;
    }
    case "meta":
      return wrapTextWithAnsi(theme.fg("dim", `— ${block.text}`), width);
  }
}

/**
 * A width-keyed cache of a sub-agent's wrapped display lines. Re-wraps lazily
 * only when the blocks or terminal width change, so steady-state slicing stays
 * O(viewport). This is the sub-agent equivalent of the main channel's
 * natively-rendered transcript lines.
 */
export class WrappedBuffer {
  #blocks: readonly TranscriptBlock[] = [];
  #width = -1;
  #revision = -1;
  #appliedRevision = -2;
  #lines: string[] = [];

  constructor(private readonly getTheme: () => Theme) {}

  /** Point the buffer at the latest blocks. Cheap; re-wrapping is deferred. */
  setBlocks(blocks: readonly TranscriptBlock[], revision: number): void {
    this.#blocks = blocks;
    this.#revision = revision;
  }

  /** The wrapped lines at `width`, rebuilding only when blocks/width changed. */
  lines(width: number): string[] {
    if (width !== this.#width || this.#revision !== this.#appliedRevision) {
      this.#lines = renderBlocks(this.#blocks, width, this.getTheme());
      this.#width = width;
      this.#appliedRevision = this.#revision;
    }
    return this.#lines;
  }
}
