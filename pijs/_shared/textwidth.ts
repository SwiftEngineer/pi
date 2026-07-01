/**
 * PiJS shared DISPLAY-WIDTH helpers (§5.4).
 *
 * `tui-powerline.ts` and `subagent-view/strip.ts` both import
 * `truncateToWidth`/`visibleWidth` from `@earendil-works/pi-tui`, and
 * `subagent-view/scrollback.ts` imports `wrapTextWithAnsi` — none of which are
 * available in the pi_agent_rust QuickJS runtime. They are reimplemented here as
 * pure ANSI-aware wcwidth logic so both consumers share one implementation.
 *
 * This is kept SEPARATE from `./text.ts` (which handles UTF-8 BYTE bounding for
 * the `task`/registry buffers) because display width (columns, ANSI, wide chars)
 * is a different concern from byte length.
 *
 * Scope note: `wrapTextWithAnsi` is needed only to satisfy `scrollback.ts`'s
 * `WrappedBuffer`/`renderBlocks`, which the OVERLAY render path never exercises
 * (the status strip goes through `renderStrip`, which uses only
 * `visibleWidth`/`truncateToWidth`). It is implemented correctly enough for the
 * split pager but is not on the hot path for the shipped overlay.
 */

// Matches a CSI escape sequence (covers SGR color `\x1b[…m` used by the
// powerline and by any theme that emits ANSI). Intentionally broad.
const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;

/** Display columns occupied by a single Unicode code point (wcwidth-lite). */
function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // C0/C1 control characters occupy no columns.
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks / zero-width joiners.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200d ||
    cp === 0xfeff
  ) {
    return 0;
  }
  // East-Asian wide / fullwidth / emoji ranges → 2 columns.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Strip all ANSI escapes from `text`. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** ANSI-aware visible column width of `text`. */
export function visibleWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) {
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * Truncate `text` to at most `maxWidth` visible columns, appending `ellipsis`
 * when content was dropped. ANSI escape sequences are preserved verbatim and
 * counted as zero width. The trailing `_ansiAware` flag is accepted for
 * call-site parity with pi-tui's signature; this implementation is always
 * ANSI-aware.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…", _ansiAware = false): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);

  let out = "";
  let width = 0;
  let index = 0;
  const RESET = "\x1b[0m";
  let sawAnsi = false;

  while (index < text.length) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(text);
    if (match && match.index === index) {
      out += match[0];
      sawAnsi = true;
      index = ANSI_RE.lastIndex;
      continue;
    }
    const cp = text.codePointAt(index) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = codePointWidth(cp);
    if (width + w > budget) break;
    out += ch;
    width += w;
    index += ch.length;
  }

  return out + ellipsis + (sawAnsi ? RESET : "");
}

/**
 * Wrap `text` to `width` columns, ANSI-aware. Newlines force hard breaks. Long
 * unbroken runs are split at the column budget. Active SGR state is not carried
 * across wrap boundaries (adequate for the overlay's non-critical use).
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
  const cols = Math.max(1, width);
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (visibleWidth(rawLine) <= cols) {
      out.push(rawLine);
      continue;
    }
    let line = rawLine;
    while (visibleWidth(line) > cols) {
      const head = truncateToWidth(line, cols, "");
      out.push(head);
      // Remove the already-emitted visible prefix (ANSI-aware) from `line`.
      const consumed = visibleWidth(head);
      line = dropVisiblePrefix(line, consumed);
    }
    if (line.length > 0) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

/** Drop the first `count` visible columns from `text`, preserving remaining ANSI. */
function dropVisiblePrefix(text: string, count: number): string {
  let width = 0;
  let index = 0;
  while (index < text.length && width < count) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(text);
    if (match && match.index === index) {
      index = ANSI_RE.lastIndex;
      continue;
    }
    const cp = text.codePointAt(index) ?? 0;
    const ch = String.fromCodePoint(cp);
    width += codePointWidth(cp);
    index += ch.length;
  }
  return text.slice(index);
}
