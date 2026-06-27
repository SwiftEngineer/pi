# pi harness e2e suite

Hermetic end-to-end replay of a real, recorded `pi` TUI session. It drives the
actual interactive terminal UI over a real PTY, but nothing an LLM or a tool
would normally do actually happens — the whole run is deterministic and
network-free.

## 1. What this is

**Architecture, one paragraph:** a converter turns a recorded Pi session
(JSONL) into a `script.json` fixture. A test-only extension
(`e2e/extension/replay.ts`) is loaded with `pi -e`; it registers pi-ai's
`createFauxCore()` **over the recorded provider name** (e.g. `zai`), preloaded
with the recorded `AssistantMessage`s — so `--model <provider>/<id>` binds to
the faux provider and streams back exactly what was recorded, preserving tool
call ids. Before each recorded tool call executes, the extension neuters its
input in place (e.g. `bash` → `{command: "true"}`) so the real tool runs as a
harmless no-op, then replaces the `tool_result` with the recorded
content/details/isError. The TUI never knows the difference — it renders the
recorded arguments (from the assistant message) and the recorded results. The
whole thing is driven from outside by a real `pi` process under a `node-pty`
pseudo-terminal, with keystrokes written to the PTY and the screen read back
and asserted via `@xterm/headless`.

**What IS exercised:** the real TUI input/render pipeline (typing, echo,
submit, scrolling, redraws), the real agent loop (streaming, tool-call
dispatch, turn sequencing), session persistence (the replayed session is
parsed back and diffed against the fixture), extension loading (`pi -e`,
`registerProvider`, `tool_call`/`tool_result` hooks), and tool plumbing (tools
really execute, just against neutered/harmless input).

**What is NOT exercised:** real LLM calls (the provider is fully faked), real
tool *effects* (inputs are neutered before execution), tool-policy blocking
decisions (neutered calls never hit a block path — `tool_result` doesn't fire
for blocked calls, so blocking can't be stubbed this way), and network (the
suite is designed to run with `--network none` in Docker; the faux provider
never makes a request).

## 2. Running

**Docker (intended default):**

```sh
npm run test:e2e
```

This builds an image with the pinned `pi` from `distribution.json` installed,
runs the suite with `--network none`, and bind-mounts `e2e/artifacts/` out so
you don't need a rebuild to inspect results or swap fixtures. *(The Dockerfile
and `run.sh` that back this script may be landing separately — if `npm run
test:e2e` isn't wired up yet in your checkout, use host mode below.)*

**Host mode (fallback, also what you use to debug interactively):**

```sh
node --test e2e/tests/*.test.mjs
```

Requires a global `pi` matching the pinned version in `distribution.json`
(currently `@earendil-works/pi-coding-agent@0.84.3`) — check with `pi
--version`. Also requires `e2e/`'s own dependencies (`node-pty`,
`@xterm/headless`) installed: `cd e2e && npm ci`.

**Artifacts** are always written to `e2e/artifacts/` (wiped and recreated at
the start of each run), even if the test crashes or the watchdog fires. On a
failure, look in this order:

1. **`final-screen.txt`** — the normalized TUI viewport at the moment the run
   ended. Fastest way to see what the screen actually looked like.
2. **`raw-pty.log`** — the raw byte stream from the PTY (includes escape
   sequences). Use this when `final-screen.txt` looks wrong/garbled and you
   need to see exactly what pi wrote, or when startup never got far enough to
   produce a coherent screen.
3. **`perf-report.json`** — check the `budgetChecks` section first (one entry
   per budget, each with `value`/`limit`/`ok`) to see which budget broke and
   by how much; `sessionDiff.mismatches` here also mirrors the session-diff
   subtest's failure.
4. **`session.jsonl`** — the actual replayed session, copied out. Compare
   against the fixture's `responses`/`toolResults` if the session-diff subtest
   failed and the summary in `perf-report.json` isn't enough detail.

Other artifacts: `tui-write.log` (what pi-tui wrote to the terminal, from
`PI_TUI_WRITE_LOG`) and `pi-debug.log` (the tail of `PI_DEBUG_REDRAW=1`'s
redraw log covering just this run — useful for `fullRedrawMax` budget
breaches).

## 3. Fixture refresh / adding a fixture

Follow these steps in order. An agent or engineer with shell access and no
other context should be able to complete this end to end.

**a. Record a real session.** Run `pi` interactively in some repo and do
whatever you want the fixture to cover. The converter enforces v1 constraints
— design the session around them:

- **Single model** for the whole session (no mid-session model switch).
- **No `/compact` and no branching** (no compaction or branch-summary entries
  in the chain).
- **Tool calls limited to the allowlist**: `bash`, `read`, `grep`, `find`,
  `ls`, `search`, `ast_grep`. Anything else (`write`, `edit`, `todo_write`,
  images, etc.) fails the conversion.
- Ideally **end the session with a final assistant TEXT answer** (a clean
  `stop`). If the last turn is mid-tool-call or otherwise doesn't stop
  cleanly, the converter drops unresolved trailing steps and synthesizes a
  final text step for you (override its text with `--final-text`).

**b. Find the session id.**

```sh
ls ~/.pi/agent/sessions/
```

Sessions live under `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`.
Any unique substring of the filename works as the converter's argument — the
full UUID, just the leading segment, whatever disambiguates it from other
files.

**c. Run the converter.**

```sh
node e2e/tools/session-to-fixture.mjs <session-id-or-path> \
  [--name default] \
  [--session-dir DIR] \
  [--out e2e/fixtures] \
  [--final-text "E2E replay complete."] \
  [--force]
```

Flags:

| Flag | Default | Effect |
| --- | --- | --- |
| `<session-id-or-path>` | *(required, positional)* | An existing file path (used as-is), or a substring matched against `.jsonl` basenames under `--session-dir`. Zero or more-than-one match is a hard error with the candidates listed. |
| `--name` | `default` | Fixture name; output goes to `<out>/<name>/script.json`. |
| `--session-dir` | `~/.pi/agent/sessions` | Root to search for session files (scans this dir plus one level of subdirectories). |
| `--out` | `e2e/fixtures` | Output root. |
| `--final-text` | `"E2E replay complete."` | Text used for the synthesized final step, if one is needed. |
| `--force` | off | Overwrite an existing `script.json` at the target path. Without it, the converter refuses to clobber an existing fixture. |

**v1 hard errors** (the converter exits non-zero with a clear message — you
must re-record without triggering these):

- Multi-model session (more than one `model_change` entry in the chain).
- `/compact` used (a `compaction` entry in the chain).
- Branching (`branch_summary` entry in the chain).
- Image content in a user message.
- A non-final assistant response with `stopReason` `"error"` or `"aborted"`
  (a broken turn mid-chain, not just a truncated tail — truncated tails are
  auto-repaired, see below).
- A tool call outside the allowlist `{bash, read, grep, find, ls, search,
  ast_grep}`.
- No assistant responses at all in the session chain.
- An ambiguous or missing session id/path.

**d. Review the printed summary and the generated `script.json`.** The CLI
prints turn count, tool-call breakdown, dropped-step count, and output size —
eyeball that against what you expect from the recording. Then open the
fixture file itself. Top-level keys:

- **`meta`** — provenance and replay parameters: session id/file, timestamps,
  pinned `piVersion`, `cwd`, `provider`/`modelId`/`api`, `thinkingLevel`,
  whether `reasoning` (thinking blocks) was present, `contextWindow`/
  `maxTokens` (looked up from pi's model catalog, falling back to generic
  defaults with a warning if the model isn't found), and repair bookkeeping
  (`synthesizedFinal`, `droppedTrailingSteps`, `droppedToolCalls`).
- **`userInputs`** — what the runner types into the editor and submits, one
  entry per user turn (v1 fixtures typically have exactly one).
- **`responses`** — the verbatim recorded `AssistantMessage`s, fed straight
  into `faux.setResponses()`. This is the replay script's core payload.
- **`toolResults`** — recorded tool outputs keyed by `toolCallId`
  (`toolName`, `content`, `details`, `isError`), injected back in place of
  whatever the neutered tool call would have produced.
- **`expected`** — assertions the test derives everything from: `turns`
  (response count), `toolCalls` (ordered list of `{name, id, screenHint}` —
  `screenHint` is a ≤40-char sanitized snippet the test expects to find
  somewhere on screen — the test also accepts a match against the first line
  of that call's recorded *result* text as a fallback, for tools whose
  arguments pi's TUI never renders), `finalAssistantText` (must be visible in
  the viewport at the end), and `screenContains` (empty by default — an
  escape hatch for hand-added extra substrings you want asserted).
- **`perfBudgets`** — see §5.

**e. Run the suite against the new fixture:**

```sh
PI_E2E_SCRIPT=e2e/fixtures/<name>/script.json node --test e2e/tests/*.test.mjs
```

No test code changes needed — everything the test asserts is derived from the
fixture file. Optionally set `PI_E2E_ARTIFACTS=<dir>` to redirect artifacts
somewhere other than `e2e/artifacts/`.

**f. Set real perf budgets.** The converter writes generous placeholder
budgets. After a clean run, open `e2e/artifacts/perf-report.json` →
`metrics`, and set each `perfBudgets` value in `script.json` to roughly **3×**
the measured value (enough headroom for CI/container jitter, tight enough to
catch real regressions).

**Making a new fixture the default:** either convert directly with `--name
default --force` (overwriting `e2e/fixtures/default/script.json`), or point
the test's fallback path at your fixture — the default `scriptPath` in
`e2e/tests/replay.test.mjs` is `e2e/fixtures/default/script.json` unless
`PI_E2E_SCRIPT` is set, so the simplest change is copying/renaming your
fixture directory to `default`.

## 4. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Screen shows an assistant error with `"No more faux responses queued"` | The fixture has fewer `responses` than the replayed conversation needs — usually because the fixture and the test's `userInputs`/turn expectations drifted out of sync (e.g. you hand-edited `script.json`, or the recording was truncated more than the converter's repair could account for). Reconvert from a fresh recording rather than hand-patching. |
| `startup` subtest times out waiting for `isReady` | The extension almost always failed to load or threw during setup (e.g. `PI_E2E_SCRIPT` unset/unreadable/unparsable, or a `registerProvider` error). Check the **top** of `raw-pty.log` — extension load errors print before the TUI ever draws the editor box. |
| Converter exits with a hard error (compaction / multi-model / disallowed tool / images / mid-chain error stopReason) | Re-record the session avoiding that constraint — see §3a. These are v1 limitations, not bugs; there is no `--force`-style override for them. |
| `node-pty` fails to build (`npm ci` / `npm install` in `e2e/`) | It's a native addon (node-gyp). You need `python3`, `make`, and a C++ compiler (`g++`) on PATH. The Dockerfile installs these; on a bare host install them via your package manager. |
| `detect.mjs` state detection (ready/working/idle) silently drifts after a `pi` version bump | The regexes in `PATTERNS` (top of `e2e/runner/detect.mjs`) are calibrated against actual rendered frames at 120×40 and will need re-calibration if pi-tui's rendering changes (border style, spinner frames, status text). Set `PI_TUI_DEBUG=1` when running `pi` (host mode) to dump every logical frame to `/tmp/tui/render-*.log`, inspect the `newLines` section of a representative frame, and update the patterns/comments in `detect.mjs` to match. |
| Debugging outside Docker, TUI mode | `PI_E2E_SCRIPT=e2e/fixtures/default/script.json pi -e e2e/extension/replay.ts --model zai/glm-5.2 --thinking high --approve` (swap in your fixture's `meta.provider`/`meta.modelId`/`meta.thinkingLevel`). Runs the real interactive TUI against the faux provider so you can watch it by eye. |
| Debugging outside Docker, headless/non-interactive | Same idea with `--mode json -p "<prompt>"` instead of running interactively: `PI_E2E_SCRIPT=e2e/fixtures/default/script.json pi --mode json -e e2e/extension/replay.ts --model zai/glm-5.2 --thinking high -p "<recorded first user message>"`. Useful for a quick sanity check of the extension/faux wiring without a PTY. |

**Critical pitfall:** never load a second `-e` extension alongside
`replay.ts` (e.g. don't add `-e some-other-extension.ts` on the same command
line). Doing so hangs `pi` — always run replay with exactly one `-e
e2e/extension/replay.ts`.

## 5. Perf budgets

Each fixture carries its own `perfBudgets` in `script.json` (see §3d/§3f); the
test derives one pass/fail assertion per budget key, and a full
`perf-report.json` is **always** written to the artifacts dir, pass or fail.

| Budget key | Meaning |
| --- | --- |
| `startupToReadyMs` | Time from spawning `pi` to the editor box first rendering (ready to accept input). |
| `keystrokeEchoP95Ms` | 95th-percentile latency between writing a character to the PTY and seeing it echoed on screen. |
| `submitToFirstRenderMs` | Time from pressing Enter to the first screen change (turn has visibly started). |
| `totalRunMs` | Wall-clock time for the whole run (all user turns, start to finish). |
| `meanTurnMs` | Average per-turn duration (submit → idle-with-expected-content). |
| `fullRedrawMax` | Max allowed count of full-screen redraws (from `PI_DEBUG_REDRAW=1`'s log) — a proxy for rendering efficiency; spikes here usually mean something is thrashing the TUI's diff/redraw logic. |
| `stdoutBytesMax` | Max total bytes written by pi to the PTY over the run — a rough proxy for output volume/verbosity regressions. |

Budgets should be generous enough to absorb CI/container jitter but tight
enough to catch a real regression — see §3f for the "≈3× measured" rule of
thumb when setting them from a fresh `perf-report.json`.
