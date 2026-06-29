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

/**
 * Scroll position is owned by the view-state as a logical {@link Anchor} (a
 * block + line offset, or distance-from-tail) rather than a raw line index, so
 * it survives re-wrapping on terminal resize. This module only provides the
 * line-arithmetic primitive {@link maxTop} and the block↔line mapping on
 * {@link WrappedBuffer}; the anchor resolution lives in view-state.ts.
 */

/** Largest valid top offset for `total` lines in a `viewport`-row window. */
export function maxTop(total: number, viewport: number): number {
  return Math.max(0, total - viewport);
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
  /** Resolved top display-line index of the window (from the view-state's anchor). */
  top: number;
  /** Builds the loud "viewing history" banner shown when scrolled up. */
  banner?: (linesBelow: number, width: number) => string;
}

/**
 * Composite the final frame: a scrollable window of the active channel above a
 * permanently-pinned chrome+strip region. Always returns exactly `height` rows.
 * Every content line is fit to `width` (ANSI-aware), so a too-wide line can
 * never reach pi-tui's renderer and tear down the TUI.
 *
 * The cursor marker only ever lives in `chromeLines` (the editor), which is
 * always rendered — so the hardware cursor is never lost, even when scrolled up.
 */
export function composeFrame(parts: ComposeParts): string[] {
  const { windowLines, chromeLines, stripLines, width, height } = parts;
  const reserved = chromeLines.length + stripLines.length;
  const viewport = Math.max(1, height - reserved);
  const total = windowLines.length;
  const limit = maxTop(total, viewport);
  const top = Math.min(Math.max(0, parts.top), limit);
  const below = limit - top;

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
 *
 * Alongside the lines it tracks the display-line index at which each block
 * starts, so the view-state can express the scroll position as a logical
 * (block, offset) {@link Anchor} that survives re-wrapping on resize. When
 * older history has been trimmed (memory cap) a leading marker line is shown.
 */
export class WrappedBuffer {
  #blocks: readonly TranscriptBlock[] = [];
  #trimmedCount = 0;
  #width = -1;
  #revision = -1;
  #appliedRevision = -2;
  #appliedTrimmed = -1;
  #lines: string[] = [];
  /** Display-line index where each (local) block begins, at the current width. */
  #blockStarts: number[] = [];

  constructor(private readonly getTheme: () => Theme) {}

  /** Point the buffer at the latest blocks. Cheap; re-wrapping is deferred. */
  setBlocks(blocks: readonly TranscriptBlock[], revision: number, trimmedCount = 0): void {
    this.#blocks = blocks;
    this.#revision = revision;
    this.#trimmedCount = trimmedCount;
  }

  #rebuild(width: number): void {
    const theme = this.getTheme();
    const w = Math.max(1, width);
    const out: string[] = [];
    const starts: number[] = [];
    // The "history trimmed" marker is prefixed to the first block's region so
    // that scrolling to the top (block 0, offset 0) reveals it.
    if (this.#trimmedCount > 0) {
      const label = `... ${this.#trimmedCount} earlier message${this.#trimmedCount === 1 ? "" : "s"} trimmed ...`;
      for (const line of renderBlock({ kind: "meta", text: label }, w, theme)) out.push(line);
    }
    for (let i = 0; i < this.#blocks.length; i++) {
      if (i > 0) out.push(""); // blank separator between blocks
      starts.push(i === 0 ? 0 : out.length);
      for (const line of renderBlock(this.#blocks[i]!, w, theme)) out.push(line);
    }
    this.#lines = out;
    this.#blockStarts = starts;
    this.#width = width;
    this.#appliedRevision = this.#revision;
    this.#appliedTrimmed = this.#trimmedCount;
  }

  /** The wrapped lines at `width`, rebuilding only when blocks/width/trim changed. */
  lines(width: number): string[] {
    if (width !== this.#width || this.#revision !== this.#appliedRevision || this.#trimmedCount !== this.#appliedTrimmed) {
      this.#rebuild(width);
    }
    return this.#lines;
  }

  /** Display-line index where local block `index` starts, at `width`. */
  blockStart(index: number, width: number): number {
    this.lines(width);
    if (this.#blockStarts.length === 0) return 0;
    const clamped = Math.min(Math.max(0, index), this.#blockStarts.length - 1);
    return this.#blockStarts[clamped]!;
  }

  /** The (local block, line-within-block) that display line `line` falls in, at `width`. */
  blockAtLine(line: number, width: number): { block: number; offset: number } {
    this.lines(width);
    const starts = this.#blockStarts;
    if (starts.length === 0) return { block: 0, offset: Math.max(0, line) };
    let lo = 0;
    let hi = starts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= line) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { block: ans, offset: Math.max(0, line - starts[ans]!) };
  }
}
