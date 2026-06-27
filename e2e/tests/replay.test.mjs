// replay.test.mjs — the single node:test e2e test for the Pi harness (plan §5).
//
// One top-level test drives the REAL interactive `pi` TUI under a PTY, replaying
// a recorded session through the hermetic faux provider + tool-stub extension
// (e2e/extension/replay.ts). Everything asserted is derived from the fixture
// `script.json` — there are NO fixture-specific literals here, so swapping
// fixtures is `PI_E2E_SCRIPT=… node --test e2e/tests/` with zero test edits.
//
// Subtests (each an `await t.test(...)`, run in order, independent so a failure
// in one still lets the rest run and the finally block still writes artifacts):
//   startup · prompt echo · first render after submit · agent runs and completes
//   · screen content · clean shutdown · session diff · perf budgets
//
// Artifacts (always written in `finally`, even on crash): perf-report.json,
// final-screen.txt, raw-pty.log, tui-write.log, session.jsonl copy, and the
// tail of $HOME/.pi/agent/pi-debug.log covering this run.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnPi } from "../runner/pty.mjs";
import { waitFor } from "../runner/wait.mjs";
import { isReady, isWorking, isIdle } from "../runner/detect.mjs";
import { typeText, submit } from "../runner/type.mjs";
import { loadReplaySession, diffAgainstScript } from "../runner/session-diff.mjs";
import { budgetKeyToMetric } from "../runner/perf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const scriptPath =
  process.env.PI_E2E_SCRIPT ?? path.join(repoRoot, "e2e", "fixtures", "default", "script.json");
const artifactsDir =
  process.env.PI_E2E_ARTIFACTS ?? path.join(repoRoot, "e2e", "artifacts");
const extensionPath = path.join(repoRoot, "e2e", "extension", "replay.ts");

// ---- helpers (fixture-agnostic) --------------------------------------------

// Concatenate the text of a recorded content block array.
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

// A distinctive, always-rendered slice of a recorded tool RESULT: the first
// non-empty line, normalized and clamped. Used as the screen-verification
// fallback for tool calls whose ARGUMENTS pi's TUI never draws (tools without a
// renderCall render only their bold name — verified in pi-coding-agent
// tool-execution.js createCallFallback), so the argument-based screenHint can
// never appear even though the call plainly ran and its result is on screen.
function resultFirstLine(rec, normalize) {
  const text = contentText(rec?.content);
  const firstLine = text.split("\n").find((l) => normalize(l).length > 0) ?? "";
  return normalize(firstLine).slice(0, 30);
}

function statSizeOr0(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// ---- the test --------------------------------------------------------------

test(`replay: ${JSON.parse(fs.readFileSync(scriptPath, "utf8")).meta.name}`, async (t) => {
  const script = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  const meta = script.meta;
  const budgets = script.perfBudgets ?? {};
  const finalText = script.expected?.finalAssistantText ?? "";

  // Wipe/create the artifacts dir for a clean run. Remove the CONTENTS rather
  // than the directory itself: under Docker PI_E2E_ARTIFACTS is a bind-mount, so
  // rmdir-ing the mountpoint would throw EBUSY.
  fs.mkdirSync(artifactsDir, { recursive: true });
  for (const entry of fs.readdirSync(artifactsDir)) {
    fs.rmSync(path.join(artifactsDir, entry), { recursive: true, force: true });
  }

  // Checkpoint the shared pi-debug.log so we can copy only THIS run's tail.
  const piDebugLog = path.join(os.homedir(), ".pi", "agent", "pi-debug.log");
  const debugCheckpoint = statSizeOr0(piDebugLog);

  const handle = spawnPi({
    scriptPath,
    artifactsDir,
    extensionPath,
    model: `${meta.provider}/${meta.modelId}`,
    thinkingLevel: meta.thinkingLevel,
    // fresh scratch workspace cwd (spawnPi creates <artifactsDir>/workspace)
  });
  const { screen, perf } = handle;

  // Watchdog: the whole run may take at most 2×totalRunMs + the startup budget
  // before we force-kill the pty and fail (never hang CI).
  const watchdogMs = 2 * (budgets.totalRunMs ?? 90000) + (budgets.startupToReadyMs ?? 15000);
  const watchdog = handle.withWatchdog(watchdogMs);

  // Shared state populated as the run progresses (read in `finally`).
  const runState = {
    spinnerObserved: false,
    screenHintFallbacks: [], // tool-call ids verified via result text, not args
    sessionFile: null,
    diff: null,
  };

  const runEverything = async () => {
    // ---- startup ----
    await t.test("startup", async () => {
      const ms = await waitFor(() => isReady(screen), {
        timeoutMs: 2 * (budgets.startupToReadyMs ?? 15000),
        intervalMs: 25,
        label: "isReady",
        onTimeout: () => screen.viewportLines().join("\n"),
      });
      perf.measure("startupToReadyMs", "spawn");
      assert.ok(
        ms <= 2 * (budgets.startupToReadyMs ?? 15000),
        `pi became ready in ${ms}ms`,
      );
    });

    // ---- per user input: echo, submit, first render, completion ----
    const inputs = script.userInputs ?? [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i].text ?? "";
      const isLast = i === inputs.length - 1;
      const sfx = inputs.length > 1 ? ` #${i}` : "";

      // Type the input (keystroke echo latencies are sampled into perf).
      await typeText(handle.ptyProc, screen, perf, input);
      await screen.flush();

      await t.test(`prompt echo${sfx}`, () => {
        const firstLine = screen.normalize(input.split("\n")[0]).slice(0, 40);
        const viewport = screen.normalize(screen.viewportLines().join(" "));
        assert.ok(
          viewport.includes(firstLine),
          `typed prompt not echoed in editor.\n  needle: ${JSON.stringify(firstLine)}`,
        );
      });

      // Fast parallel spinner sampler (never fails the test — see plan §5).
      const beforeSubmit = screen.viewportLines().join("\n");
      const poller = setInterval(() => {
        if (isWorking(screen)) runState.spinnerObserved = true;
      }, 10);

      perf.mark("submit");
      const submitTs = Date.now();
      submit(handle.ptyProc);

      try {
        await t.test(`first render after submit${sfx}`, async () => {
          await waitFor(
            async () => {
              await screen.flush();
              return screen.viewportLines().join("\n") !== beforeSubmit;
            },
            { timeoutMs: budgets.submitToFirstRenderMs ? 5 * budgets.submitToFirstRenderMs : 15000, intervalMs: 10, label: "firstRender" },
          );
          perf.measure("submitToFirstRenderMs", "submit");
        });

        await t.test(`agent runs and completes${sfx}`, async () => {
          await waitFor(
            async () => {
              await screen.flush();
              // Completion signal is isIdle + (for the final input) the expected
              // final assistant text on screen — the load-bearing signals per
              // plan §5. Requiring finalText also defuses any momentary
              // post-submit "idle" before the turn actually starts.
              return isIdle(screen) && (!isLast || !finalText || screen.textIncludes(finalText));
            },
            {
              timeoutMs: budgets.totalRunMs ?? 90000,
              intervalMs: 25,
              label: "runComplete",
              onTimeout: () => screen.viewportLines().join("\n"),
            },
          );
        });
      } finally {
        clearInterval(poller);
        perf.sample("turn", Date.now() - submitTs);
      }
    }

    perf.measure("totalRunMs", "spawn");

    // ---- rendered screen content ----
    await t.test("screen content", () => {
      // Each tool call must leave a visible trace: its argument-based screenHint
      // on screen, OR (for tools whose args pi never renders) its recorded
      // result text on screen.
      const missing = [];
      for (const tc of script.expected?.toolCalls ?? []) {
        if (screen.textIncludes(tc.screenHint)) continue;
        const slice = resultFirstLine(script.toolResults?.[tc.id], screen.normalize);
        if (slice && screen.textIncludes(slice)) {
          runState.screenHintFallbacks.push({ id: tc.id, name: tc.name, hint: tc.screenHint, matchedResult: slice });
          continue;
        }
        missing.push({ id: tc.id, name: tc.name, hint: tc.screenHint });
      }
      assert.deepEqual(
        missing,
        [],
        `tool-call screen hints not found on screen:\n${missing.map((m) => `  - ${m.name} ${m.id}: ${JSON.stringify(m.hint)}`).join("\n")}`,
      );

      // Final assistant text must be visible in the VIEWPORT (not just scrollback).
      if (finalText) {
        const viewport = screen.normalize(screen.viewportLines().join(" "));
        assert.ok(
          viewport.includes(screen.normalize(finalText)),
          `final assistant text not visible in viewport: ${JSON.stringify(finalText)}`,
        );
      }

      // Optional hand-added extras.
      for (const needle of script.expected?.screenContains ?? []) {
        assert.ok(screen.textIncludes(needle), `expected screenContains entry not found: ${JSON.stringify(needle)}`);
      }
    });

    // ---- /context command: the ported context-usage panel (last interactive step) ----
    // Types `/context` and asserts the bordered breakdown renders: title, legend
    // labels, and at least one grid glyph (proving the special-character grid drew).
    // A slash command accepted from the autocomplete submits in one Enter
    // (pi-tui editor.js: for a "/"-prefixed prefix, confirm falls through to
    // submit), and the command renders without starting a turn, so pi stays idle
    // and the editor clears for the ctrl+d shutdown below.
    await t.test("context command", async () => {
      await typeText(handle.ptyProc, screen, perf, "/context");
      await screen.flush();
      submit(handle.ptyProc);

      await waitFor(
        async () => {
          await screen.flush();
          return screen.textIncludes("Context Usage") && screen.textIncludes("Estimated usage by category");
        },
        {
          timeoutMs: 15000,
          intervalMs: 25,
          label: "contextPanel",
          onTimeout: () => screen.viewportLines().join("\n"),
        },
      );

      assert.ok(screen.textIncludes("Context Usage"), "context panel title not rendered");
      assert.ok(screen.textIncludes("Estimated usage by category"), "context legend header not rendered");
      assert.ok(screen.textIncludes("System prompt"), "context legend category 'System prompt' not rendered");
      assert.ok(screen.textIncludes("Free space"), "context legend 'Free space' not rendered");
      // The grid is drawn from special glyphs (draughts kings / square-four-corners /
      // squared-saltire) — at least one must be on screen.
      assert.ok(
        ["⛁", "⛃", "⛶", "⛝"].some((glyph) => screen.textIncludes(glyph)),
        "context grid glyphs not rendered",
      );

      // The command must not have started a turn; pi should be idle and ready.
      assert.ok(isIdle(screen), "pi not idle after /context");
    });

    // ---- clean shutdown ----
    await t.test("clean shutdown", async () => {
      const result = await handle.shutdown({ timeoutMs: 5000 });
      assert.ok(result.exited, `pi did not exit within 5s (shutdown path: ${result.path})`);
      assert.equal(
        result.path,
        "ctrl-d",
        `expected a clean ctrl+d exit from an empty editor, got escalation path: ${result.path}`,
      );
    });

    // ---- session diff ----
    await t.test("session diff", () => {
      const loaded = loadReplaySession(handle.paths.sessionsDir);
      runState.sessionFile = loaded.sessionFile;
      const { mismatches, warnings } = diffAgainstScript(loaded.entries, script);
      runState.diff = { mismatches, warnings };
      if (warnings.length) {
        for (const w of warnings) console.warn(w);
      }
      assert.deepEqual(
        mismatches,
        [],
        `replayed session diverged from the script:\n${mismatches.join("\n")}`,
      );
    });

    // ---- perf budgets: one assertion per declared budget ----
    await t.test("perf budgets", () => {
      const report = perf.report({
        budgets,
        fullRedrawCount: handle.fullRedrawCount(),
        extra: { spinnerObserved: runState.spinnerObserved },
      });
      const metrics = report.metrics;
      for (const [key, limit] of Object.entries(budgets)) {
        const metricKey = budgetKeyToMetric(key);
        const value = metrics[metricKey];
        assert.ok(
          value !== undefined,
          `perf budget "${key}" has no corresponding measured metric "${metricKey}"`,
        );
        assert.ok(
          value <= limit,
          `perf budget "${key}" exceeded: measured ${value} > budget ${limit} (metric ${metricKey})`,
        );
      }
    });
  };

  // Race the whole run against the watchdog so a hang force-kills the pty and
  // fails loudly instead of hanging node:test.
  try {
    await Promise.race([runEverything(), watchdog.promise]);
  } finally {
    watchdog.cancel();

    // ---- artifacts: ALWAYS written, even on crash ----
    try {
      const report = perf.report({
        budgets,
        fullRedrawCount: handle.fullRedrawCount(),
        extra: { spinnerObserved: runState.spinnerObserved },
      });
      report.fixture = meta.name;
      report.scriptPath = scriptPath;
      report.watchdogMs = watchdogMs;
      report.screenHintFallbacks = runState.screenHintFallbacks;
      if (runState.diff) report.sessionDiff = runState.diff;
      perf.write(path.join(artifactsDir, "perf-report.json"), report);
    } catch (err) {
      process.stderr.write(`artifact perf-report.json failed: ${err?.message ?? err}\n`);
    }

    // Normalized viewport dump.
    try {
      fs.writeFileSync(path.join(artifactsDir, "final-screen.txt"), screen.viewportLines().join("\n") + "\n");
    } catch (err) {
      process.stderr.write(`artifact final-screen.txt failed: ${err?.message ?? err}\n`);
    }

    // Copy the produced session .jsonl (raw-pty.log + tui-write.log are already
    // streamed to artifactsDir by the runner).
    try {
      let src = runState.sessionFile;
      if (!src) {
        // Locate it if the diff subtest never ran.
        try {
          src = loadReplaySession(handle.paths.sessionsDir).sessionFile;
        } catch {
          src = null;
        }
      }
      if (src && fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(artifactsDir, "session.jsonl"));
      }
    } catch (err) {
      process.stderr.write(`artifact session.jsonl failed: ${err?.message ?? err}\n`);
    }

    // Copy the tail of pi-debug.log covering this run.
    try {
      const size = statSizeOr0(piDebugLog);
      const start = Math.min(debugCheckpoint, size);
      const len = size - start;
      let tail = "";
      if (len > 0) {
        const fd = fs.openSync(piDebugLog, "r");
        try {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          tail = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.writeFileSync(path.join(artifactsDir, "pi-debug.log"), tail);
    } catch (err) {
      process.stderr.write(`artifact pi-debug.log failed: ${err?.message ?? err}\n`);
    }

    // Ensure the pty is dead so node:test can exit.
    try {
      if (!handle.exited) {
        handle.kill();
        await handle.waitForExit(2000);
      }
    } catch {
      /* best effort */
    }
  }
});
