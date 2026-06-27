// screen.mjs — headless xterm wrapper.
//
// Wraps @xterm/headless so the runner can feed raw PTY bytes and read the
// settled terminal state (viewport + full scrollback) as plain strings.
//
// Notes on xterm internals that matter here:
//  - Terminal.write(data, cb) is ASYNCHRONOUS. xterm buffers writes and parses
//    them on a microtask/timer. The optional callback fires once the chunk has
//    been fully parsed. We track a pending-write count and expose flush() so
//    predicates only read state after all queued bytes have been applied.
//  - buffer.active.getLine(i).translateToString(true) collapses trailing
//    whitespace on a row; passing `true` trims the row's trailing blanks.
//  - xterm silently swallows escape sequences it does not implement, including
//    the synchronized-output pair \x1b[?2026h / \x1b[?2026l and the kitty
//    keyboard-protocol / DA queries pi emits at startup. That means we can feed
//    the raw stream verbatim without pre-filtering.

// @xterm/headless ships as CommonJS whose named `Terminal` is only reachable
// through the default export under Node ESM interop (the CJS lexer exposes
// only `default`/`module.exports` at the top level).
import xterm from "@xterm/headless";
const { Terminal } = xterm;

export function createScreen({ cols = 120, rows = 40 } = {}) {
  const term = new Terminal({
    cols,
    rows,
    scrollback: 5000,
    allowProposedApi: true,
  });

  // Track in-flight writes so flush() can await a settled state.
  let pending = 0;
  const drainWaiters = [];

  function onWriteDone() {
    pending--;
    if (pending === 0) {
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const resolve of waiters) resolve();
    }
  }

  function feed(data) {
    pending++;
    term.write(data, onWriteDone);
  }

  function flush() {
    if (pending === 0) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  // Read every row currently in the active buffer (scrollback + viewport).
  function allText() {
    const buf = term.buffer.active;
    const total = buf.length;
    const lines = [];
    for (let i = 0; i < total; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines;
  }

  // Read only the visible viewport rows (top .. top+rows-1).
  function viewportLines() {
    const buf = term.buffer.active;
    const top = buf.viewportY; // absolute row index of the top visible row
    const lines = [];
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(top + i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines;
  }

  // Collapse all runs of whitespace to a single space and trim the ends.
  function normalize(s) {
    return String(s).replace(/\s+/g, " ").trim();
  }

  // Wrap-tolerant substring test: normalize both sides so a needle that the
  // terminal soft-wrapped across rows still matches (rows are joined by space).
  function textIncludes(needle) {
    const haystack = normalize(allText().join(" "));
    return haystack.includes(normalize(needle));
  }

  return {
    term,
    feed,
    flush,
    allText,
    viewportLines,
    normalize,
    textIncludes,
  };
}
