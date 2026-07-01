/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/subagent-view/scrollback.ts. Adaptations:
 *  1. Value imports `truncateToWidth`/`wrapTextWithAnsi` come from
 *     `../_shared/textwidth.ts` (not `@earendil-works/pi-tui`, unavailable under
 *     PiJS — §5.4). `import type { Theme }` is erased at runtime.
 *  2. ⚠ `WrappedBuffer` used typed `#private` fields with initializers
 *     (`#blocks: readonly TranscriptBlock[] = []`), which the QuickJS TS loader
 *     corrupts ("undefined private field" at load). Converted to
 *     `private`-modifier fields declared type-only and initialized in the
 *     constructor — the proven-safe pattern from `_shared/text.ts`/`registry.ts`.
 *
 * Only `maxTop` is on the shipped overlay's render path; `WrappedBuffer` /
 * `renderBlocks` / `composeFrame` exist to keep `view-state.ts` importable and
 * for the (dropped) split-pane pager, and are not exercised by the overlay.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "../_shared/textwidth.ts";
import type { TranscriptBlock } from "./transcript.ts";

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
  windowLines: string[];
  chromeLines: string[];
  stripLines: string[];
  width: number;
  height: number;
  top: number;
  banner?: (linesBelow: number, width: number) => string;
}

/**
 * Composite the final frame: a scrollable window of the active channel above a
 * permanently-pinned chrome+strip region. Retained for parity; the overlay-only
 * port does not call this (the split-pane path is dropped).
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
 * only when the blocks or terminal width change.
 *
 * ⚠ PiJS: all `#private` fields converted to `private`-modifier declarations
 * (type-only) + constructor initialization (loader corrupts typed `#` fields).
 */
export class WrappedBuffer {
  private blocks: readonly TranscriptBlock[];
  private trimmedCount: number;
  private width: number;
  private revision: number;
  private appliedRevision: number;
  private appliedTrimmed: number;
  private lineCache: string[];
  /** Display-line index where each (local) block begins, at the current width. */
  private blockStarts: number[];

  constructor(private readonly getTheme: () => Theme) {
    this.blocks = [];
    this.trimmedCount = 0;
    this.width = -1;
    this.revision = -1;
    this.appliedRevision = -2;
    this.appliedTrimmed = -1;
    this.lineCache = [];
    this.blockStarts = [];
  }

  /** Point the buffer at the latest blocks. Cheap; re-wrapping is deferred. */
  setBlocks(blocks: readonly TranscriptBlock[], revision: number, trimmedCount = 0): void {
    this.blocks = blocks;
    this.revision = revision;
    this.trimmedCount = trimmedCount;
  }

  private rebuild(width: number): void {
    const theme = this.getTheme();
    const w = Math.max(1, width);
    const out: string[] = [];
    const starts: number[] = [];
    if (this.trimmedCount > 0) {
      const label = `... ${this.trimmedCount} earlier message${this.trimmedCount === 1 ? "" : "s"} trimmed ...`;
      for (const line of renderBlock({ kind: "meta", text: label }, w, theme)) out.push(line);
    }
    for (let i = 0; i < this.blocks.length; i++) {
      if (i > 0) out.push(""); // blank separator between blocks
      starts.push(i === 0 ? 0 : out.length);
      for (const line of renderBlock(this.blocks[i]!, w, theme)) out.push(line);
    }
    this.lineCache = out;
    this.blockStarts = starts;
    this.width = width;
    this.appliedRevision = this.revision;
    this.appliedTrimmed = this.trimmedCount;
  }

  /** The wrapped lines at `width`, rebuilding only when blocks/width/trim changed. */
  lines(width: number): string[] {
    if (width !== this.width || this.revision !== this.appliedRevision || this.trimmedCount !== this.appliedTrimmed) {
      this.rebuild(width);
    }
    return this.lineCache;
  }

  /** Display-line index where local block `index` starts, at `width`. */
  blockStart(index: number, width: number): number {
    this.lines(width);
    if (this.blockStarts.length === 0) return 0;
    const clamped = Math.min(Math.max(0, index), this.blockStarts.length - 1);
    return this.blockStarts[clamped]!;
  }

  /** The (local block, line-within-block) that display line `line` falls in, at `width`. */
  blockAtLine(line: number, width: number): { block: number; offset: number } {
    this.lines(width);
    const starts = this.blockStarts;
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
