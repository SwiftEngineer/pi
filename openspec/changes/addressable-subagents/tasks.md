## 1. Durable agent sessions on dispatch

- [x] 1.1 In `runChild`, replace `--no-session` with `--session-dir <tmp>/swift-pi-subagent-sessions` and `--session-id <record.id>` (D2). Resume lookups scan for the `<timestamp>_<id>.jsonl` naming pattern (existence is checked by dir scan, not direct path — see design Context). Keep `--append-system-prompt` staging and dispatch-time `--model` handling unchanged
  - Done; `SESSION_DIR` created eagerly before spawn so the D8 scan always has a dir. Dispatch-time `--model` now guarded to the first engagement only (D10).
- [x] 1.2 Reuse `record.id` as the session id verbatim (it satisfies `assertValidSessionId`'s start/end-alphanumeric rule); keep the "no record ever has two live children" debug check on spawn as a regression tripwire only — enforcement is D9, not this assert
  - Done; tripwire fires *before* spawn (a post-spawn check would be too late — the second child would already exist) and marks the record failed.
- [x] 1.3 Record the spawned child's pid in the dispatch session entry (extend `DispatchData`); this is the cross-restart leg of the single-writer invariant (D9c)
  - Done, then extended after review (finding 2): the entry is written from an `onSpawned` hook, each resume spawn additionally appends a small engagement entry carrying the *new* child's pid (a completion entry alone only covers completed engagements, so a crash mid-resume used to leave the orphan probe blind), and restore probes the latest pid across all entry kinds.
- [x] 1.4 Blocking fallback (non-TUI) dispatch path: same flags; verify aggregated results still work when the child creates/resumes a session
  - Done; harness group 7 asserts inline dispatch and inline send in `print` mode (no follow-up deliveries).

## 2. Turn-shaped records, delivery, and persistence

- [x] 2.1 Convert the once-only `finalized` flag to per-engagement finalize: each engagement's terminal state appends a completion entry (full message log, v1 schema) and, in TUI mode, delivers a `subagent_result` followUp (D4). Accept a `deliver` override so a send-initiated kill can finalize with `deliver: false` (D11)
  - Done; `runEngagement` finalizes per engagement with `deliver = opts.deliver && !record.suppressNextDelivery`, then clears the suppression flag.
- [x] 2.2 Include the registry id in `resultHeaderText` (`[subagent <type> <id> — <status>] <task>`) and in the dispatch ack if not already present (D5)
  - Done; ack keeps v1's id-bearing `details`, now additionally documented in the tool description.
- [x] 2.3 Extend restore (`session_start`): fold per-agent completion entries **latest-entry-wins** (each entry embeds the full cumulative log and usage — do not concatenate or re-sum); enumerate the per-engagement field reset (`finalized → false`, `status → waiting`, `stderr → ""`, `abortRequested → false`, `stopReason/errorMessage → undefined`) for restored-lost records so a later engagement can finalize; mark lost records re-engagable *pending* the existence check (D8), never unconditionally (F6/F7 fixes)
  - Done. Design refinement: the reset lives in `beginEngagement(record, prompt)`, applied at *every* engagement start (dispatch's first engagement included) rather than once at restore — same guarantee, one code path. Restore itself only folds latest-entry-wins and carries pid/restored.
- [x] 2.4 Verify delivered results and replay rendering look right for a multi-engagement agent: replay overlay shows the accumulated transcript once (no duplication from folding — turn separators welcome but optional polish); delivered renderer unchanged apart from the header
  - Transcript growth across a re-engagement is now asserted headlessly (harness group 2 asserts `record.messages.length` grows — it did not before the review, finding 5f); folding is replacement, so `record.messages` holds the cumulative log exactly once. Visual confirmation in a real terminal rides on 5.3.

## 3. `subagents_send` tool

- [x] 3.1 Register the tool (TypeBox params: `id`, `message`, optional `interrupt`) under the same `SWIFT_PI_SUBAGENT` gate as dispatch; declare `executionMode: "sequential"` (the agent loop runs any batch containing a sequential tool fully sequentially — agent-loop.js `executeToolCalls`); claim the target record synchronously *before* the handler's first await (transition status to waiting, mark engagement active) so a send cannot interleave with the operator hotkey or the interrupt path's aborted-status window (D9a/D9b); description teaches the contract and notes cwd-scoped re-engagement (D3)
  - Done, and made sound after review (finding 1): all pre-spawn validation is synchronous, the in-flight check consults `record.child || record.run` (covering the claimed-but-unspawned window), and the engagement's prompt is captured by the caller and passed to the child spawner as an argument instead of being re-read from the mutable record after the staging awaits.
- [x] 3.2 Terminal-target path: verify the durable session exists — dir scan of the private session dir for `*_<record.id>.jsonl`; miss → fail "durable session missing — cannot re-engage" (D8). Apply the per-engagement field reset from 2.3 to the live record, re-stage the role prompt temp file from `AGENT_PROMPTS[type]` (D6), spawn the resume child **without `--model`** (D10), prompt = message. TUI returns an ack; non-TUI awaits inline and returns the result text
  - Done; role-prompt re-staging is free (runChild already stages per spawn). Id collision impossible: ids are exactly two dashes (`sa-<base36>-<base36>`), so no id is a suffix of another.
- [x] 3.3 Rejection paths: running target without `interrupt` → tool error (no state change); unknown id → tool error listing known ids; restored-lost target whose dispatch-entry pid is still alive (`process.kill(pid, 0)`) → refuse "orphaned child may still be writing its session" (D9c)
  - Done; the probe applies to any *restored* record (not just lost) and takes the latest known pid; EPERM counts as alive (fails safe). Harness group 6.
- [x] 3.4 Interrupt path: SIGTERM the live child via the v1 escalation mechanics, await its close and finalize it with `deliver: false` (D11 — the killed engagement persists its completion entry but delivers no aborted diagnostics), then run the terminal-target path with the corrective message; on a non-in-flight target, `interrupt: true` behaves as a plain send (D3)
  - Done; shared `killChildEscalating` with the operator hotkey; the interrupt path awaits `record.run` and then falls through to the same D8/D9c checks + resume.

## 4. Harness collateral

- [x] 4.1 Update `extensions/system-prompt.ts`: delegation guidance gains the send contract — results carry agent ids; `subagents_send` re-engages (route reviewer feedback to the implementer) or redirects with `interrupt: true`; sends within a turn run sequentially; cap fix iterations (2–3) before reporting residual issues (D7). Keep the line omitted under `SWIFT_PI_SUBAGENT`
  - Done; tool-routing line also names `subagents_send` for the parent only.
- [x] 4.2 Update `scripts/smoke.mjs`: add `subagents_send` to the required-tool list. No search-target or spawn-path changes needed — the search/ast targets are `AGENT_PROMPTS` in `extensions/subagents/agents.ts`, which this change does not touch (the harness stub deletes the `SWIFT_PI_SUBAGENT` gate, so the new tool registers fine)
  - Done and passing.
- [x] 4.3 e2e note: like v1 task 7.2, fixture refresh needs a human-recorded session exercising the new tool; confirm the existing suite is not broken by these changes (session-diff compares messages, not tool lists)
  - Confirmed by analysis (same reasoning as archived v1 task 7.2): `e2e/fixtures/default/script.json`'s tool calls are bash/search/read only, and `session-diff.mjs` compares user/assistant content, provider/model, and toolResults — never the tool list or spawn args. Fixture refresh for the new tool remains human work.

## 5. Verification

- [x] 5.1 Typecheck (`npm run check`) and smoke (`npm run smoke`)
  - Both clean; smoke registers `subagents` and `subagents_send`.
- [x] 5.2 Headless harness against a stub child pi: dispatch records pid and creates a session-file spawn invocation; send on a done agent resumes with the same record/id and appends to the transcript; send on a running agent without interrupt is rejected; interrupt kills then resumes; the killed engagement delivers no aborted diagnostics but persists its completion entry; a re-engaged agent both delivers **and persists** its second engagement (finalized reset actually happens); missing session file fails the send; live recorded pid refuses send on a restored record; resume spawn omits `--model`; restore folds multi-engagement history latest-entry-wins without duplication
  - Done: `scripts/subagents-harness.mjs` + `scripts/test-stub-subagent-pi.mjs` (`npm run test:subagents`), 12 groups, all passing. Covers the listed checks plus: the D2/D8 belt-and-braces (resume child reporting "creating a new session" fails loudly), non-TUI inline paths, a same-tick double send (pre-spawn window rejection, prompt unclobbered), an interrupt racing the pre-spawn window (pending engagement aborted + redirected, no aborted diagnostic), a restored-lost record re-engaging on a dead recorded pid (D9c success path), and a restored record poisoned by `resumeSessionMissing` refusing sends. Not harness-verifiable: the operator-hotkey abort path, `session_shutdown` teardown, and `executionMode: "sequential"` serialization (the fake API discards it; verified by reading agent-loop.js). Both human tasks below remain genuinely necessary.
- [ ] 5.3 Manual TUI pass (human): implement → review → send feedback to the implementer; observe one agent id delivering twice, indicator transitions through a kill-resume, replay shows the full multi-turn transcript, and an operator-abort (`alt+x`) followed by a send re-engages the aborted agent
- [ ] 5.4 Manual `pi -p` pass (human): send runs inline and returns the result as the tool result; `SWIFT_PI_SUBAGENT=1` children expose neither `subagents` nor `subagents_send`

## 6. Review dispositions (GLM 5.3 post-implementation review)

Independent review of the implementation against design/spec; findings triaged as follows. 1–4 and 6–9 fixed; 5 partially (the cases that guard the fixed bugs are now covered; the rest documented as not-harness-verifiable); 10 and 11 addressed as noted.

- **1 (major, fixed):** second send in the pre-spawn window dropped its message and clobbered the pending prompt. In-flight check now consults `record.child || record.run`; the prompt is captured before the first await and passed to the spawner; regression-tested (group 6b) — rejection, and the first engagement's argv prompt is intact.
- **2 (major, fixed):** resume children's pids were never persisted, so the cross-restart orphan probe was blind to mid-resume crashes. Every resume spawn appends an engagement entry carrying the new pid; restore probes the latest pid across dispatch/engagement/completion entries; tested (group 6d, dead-pid success + probe uses engagement pid).
- **3 (major, fixed):** the D8 belt-and-braces failure was one-shot — a second send "self-healed" onto the blank session. `resumeSessionMissing` is persisted on the failed engagement's completion entry, restored with the record, and refuses all further sends; tested (group 6e: refusal despite an existing file).
- **4 (minor, fixed):** an engagement claimed but unspawned at `session_shutdown` used to spawn an unkillable orphan. `shuttingDown` flag + runChild's pre-spawn `abortRequested` re-check end the pending engagement without spawning.
- **5 (minor, partially addressed):** added restored-lost coverage (6d), D9c success path (6d), pre-spawn double-send (6b), transcript-growth assertion (group 2), and the poison-refusal restore case (6e). Operator-hotkey and `session_shutdown` behavior stay manual (5.3/5.4); `executionMode` is unverifiable against the fake API (documented).
- **6 (minor, fixed):** tasks.md overstatements corrected (1.3, 2.4, 3.1, 5.2 notes now match what the code/harness actually do).
- **7 (nit, fixed):** a kill landing on an already-exited child no longer relabels the engagement aborted; `killChildEscalating` checks `stillRunning` before any state change.
- **8 (nit, fixed):** D11 suppression is attributed inside `killChildEscalating` (`suppressDelivery` opt) — an operator abort racing a send keeps its diagnostics.
- **9 (nit, fixed):** `sessionFileExists` distinguishes ENOENT (genuine miss) from scan errors; the send reports "cannot verify" rather than misdiagnosing a permissions failure as "session missing".
- **10 (nit, noted):** shared tmpdir session dir weakens cross-instance isolation; accepted with a new Risks entry in design.md (pre-existing platform hazard; no code change).
- **11 (nit, partially fixed):** claimed-but-unspawned engagements are now abortable via alt+x (flag-based, no spawn happens); the replay assignment display inconsistency was resolved by restoring the assignment from the latest engagement entry, so live and reloaded records show the same latest prompt.
