// detect.mjs — recognize pi TUI states from the headless screen.
//
// States the runner cares about:
//   Ready   — the editor input box is drawn and accepting input.
//   Working — pi is mid-turn (spinner + "Working..." status line).
//   Idle    — Ready and not Working.
//
// PATTERNS are centralized so recalibration after a pi upgrade is one edit.
// Each pattern is documented with the ACTUAL rendered frame excerpt it matches,
// captured under this PTY at 120x40.
//
// Key calibration finding: the TUI does NOT fill the terminal. When there is
// little content the editor box sits near the TOP of the 40-row viewport (rows
// 11/13 in the observed frame below), NOT at the bottom. So detection must find
// the editor box wherever it is, identifying it as the LAST pair of nearby
// horizontal-rule rows — it is always the bottom-most rendered element, just
// above the cwd line and the "…% • model • thinking" status line.
//
// Observed READY frame (empty editor, plain `pi --approve`, 120x40):
//   01|  pi v0.80.2
//   02|  escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
//   ...
//   11| ────────────────────────────────────────────────────────────  (120x "─")  <- editor top rule
//   12|                                                                             <- empty body
//   13| ────────────────────────────────────────────────────────────  (120x "─")  <- editor bottom rule
//   14| /tmp/.../artifacts-1/workspace                                              <- cwd line
//   15| 0.0%/1.0M (auto)                                     glm-5.2 • high          <- status line

export const PATTERNS = {
  // Editor box border. pi-tui editor.js render() emits top/bottom borders as
  // `horizontal.repeat(width)` with horizontal = "─" (U+2500) (editor.js:372,
  // 409, 461). At width=120 that is 120 "─". When scrolled the rule begins
  // "─── ↑ N more ─..." / "─── ↓ N more ─..." which still contains a long run
  // of "─", so we match a RUN of >=40 (avoids short rules inside tool boxes,
  // and the full editor rule is always 120 wide here).
  editorRule: /─{40,}/,

  // Working spinner. pi-tui loader.js DEFAULT_FRAMES are braille dots
  // ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] (loader.js:2).
  spinner: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,

  // Working status text. interactive-mode.js defaultWorkingMessage = "Working..."
  // and while a turn runs it appends " (<key> to interrupt)" (interactive-mode.js:159,1459).
  // Anchored on "Working..." and "to interrupt" (the ready-screen hint reads
  // "escape interrupt", NOT "to interrupt", so this does not false-positive).
  working: /Working\.\.\.|to interrupt/,
};

// Max editor body height. maxVisibleLines = max(5, floor(rows*0.3)) = 12 at
// rows=40, plus the two rules -> the editor's two rules are <= 13 rows apart.
const MAX_EDITOR_SPAN = 13;

// Indices of rows matching the editor rule.
function ruleRowIndices(rows) {
  const idx = [];
  for (let i = 0; i < rows.length; i++) {
    if (PATTERNS.editorRule.test(rows[i])) idx.push(i);
  }
  return idx;
}

// Locate the editor box: the last pair of rule rows within MAX_EDITOR_SPAN of
// each other. Returns { top, bottom } indices into `rows`, or null.
function findEditorBox(rows) {
  const rules = ruleRowIndices(rows);
  if (rules.length < 2) return null;
  const bottom = rules[rules.length - 1];
  // Nearest preceding rule that is within span.
  for (let k = rules.length - 2; k >= 0; k--) {
    const span = bottom - rules[k];
    if (span >= 1 && span <= MAX_EDITOR_SPAN) {
      return { top: rules[k], bottom };
    }
    if (span > MAX_EDITOR_SPAN) break;
  }
  return null;
}

// Ready = the editor box (top + bottom rule) is present in the viewport.
export function isReady(screen) {
  return findEditorBox(screen.viewportLines()) !== null;
}

// Working = a spinner or the "Working..." status line is visible in the
// viewport (the live status area, not stale scrollback).
export function isWorking(screen) {
  const rows = screen.viewportLines();
  for (const line of rows) {
    if (PATTERNS.working.test(line) || PATTERNS.spinner.test(line)) return true;
  }
  return false;
}

// Idle = editor is ready and pi is not mid-turn.
export function isIdle(screen) {
  return isReady(screen) && !isWorking(screen);
}

// isEditorEmpty — the content rows strictly between the editor's top and bottom
// rules contain no visible text (only the cursor / whitespace). Used by
// shutdown to decide whether a bare ctrl+d will cleanly exit.
export function isEditorEmpty(screen) {
  const rows = screen.viewportLines();
  const box = findEditorBox(rows);
  if (!box) return false; // no editor -> treat as not-empty (be conservative)
  for (let i = box.top + 1; i < box.bottom; i++) {
    if (screen.normalize(rows[i]).length > 0) return false;
  }
  return true;
}
