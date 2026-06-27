// type.mjs — drive the editor by typing text one character at a time.
//
// typeText(ptyProc, screen, perf, text)
//   Writes `text` to the PTY one character at a time. After each character we
//   wait for the headless screen to change (cheap snapshot compare) and record
//   an echo-latency sample into perf ("keystrokeEcho" series). Returns the
//   number of characters written.
//
// Newline semantics (verified against pi-tui editor.js):
//   - "\n" (LF, single char) hits the editor's newLine branch -> inserts a
//     newline into the buffer. Safe: it does NOT submit.
//   - "\r" (CR) matches tui.input.submit -> SUBMITS the prompt. typeText never
//     writes "\r". Use submit() for that (test-only; triggers a real turn).

const ECHO_TIMEOUT_MS = 2000;
const ECHO_POLL_MS = 5;

export async function typeText(ptyProc, screen, perf, text) {
  const chars = [...text]; // iterate by code point, not UTF-16 unit
  let written = 0;

  for (const ch of chars) {
    await screen.flush();
    const before = snapshot(screen);

    const t0 = Date.now();
    ptyProc.write(ch);

    // Wait for the screen to reflect the keystroke (echo). We poll a cheap
    // snapshot rather than a full text compare.
    const deadline = t0 + ECHO_TIMEOUT_MS;
    let changed = false;
    for (;;) {
      await screen.flush();
      const after = snapshot(screen);
      if (after !== before) {
        changed = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(ECHO_POLL_MS);
    }

    const echoMs = Date.now() - t0;
    if (changed && perf) perf.sample("keystrokeEcho", echoMs);
    written++;
  }

  await screen.flush();
  return written;
}

// submit(ptyProc) — press Enter (CR) to submit the current editor contents.
// EXISTS FOR THE TEST AGENT. Submitting a non-empty editor starts a real agent
// turn (an LLM call in a live run). Never called by typeText or by probes.
export function submit(ptyProc) {
  ptyProc.write("\r");
}

// A cheap, stable fingerprint of current screen state. We join the viewport
// (the region that echoes keystrokes) AND fold in the cursor position, so we
// detect the editor updating without paying for full scrollback stringification
// each poll.
//
// The cursor is load-bearing: viewportLines() trims each row's trailing
// whitespace (translateToString(true)), so a keystroke that only adds trailing
// blanks — a space at end of line, or the empty line from a second "\n" — leaves
// the trimmed viewport text UNCHANGED. Without the cursor those keystrokes would
// never register as an echo and each would stall the full ECHO_TIMEOUT_MS. The
// cursor advances on every accepted keystroke (column for text, row for
// newlines), so it makes trailing-whitespace edits observable.
function snapshot(screen) {
  const buf = screen.term.buffer.active;
  return `${buf.baseY + buf.cursorY}:${buf.cursorX}|${screen.viewportLines().join("\n")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
