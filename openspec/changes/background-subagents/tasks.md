## 1. Foundation: port the official subagent capture core

- [x] 1.1 Vendor the message-stream parsing, usage accounting, and SIGTERM abort (with 5 s SIGKILL escalation) from `examples/extensions/subagent` into `extensions/subagents/`; extend the parser to consume start events (`message_start`, `tool_execution_start`) — `--mode json` streams every session event, not just `message_end`/`tool_result_end`
- [x] 1.2 Port agent-role definitions (explore, plan, designer, reviewer, librarian, oracle, task, quick_task) with the type-glyph mapping (D4); verify every glyph renders single-width and recolorable in target terminals
  - Glyphs live in `extensions/subagents/agents.ts`. Verified programmatically: every chosen glyph is a single code point and lacks the `Emoji_Presentation` Unicode property (so it renders as recolorable text, not double-width emoji); the dropped ⚡ (U+26A1) correctly carries it. Final single-width confirmation in the specific target terminals still warrants a human eyeball, but the property-level acceptance check passes.
- [x] 1.3 Remove `extensions/task/index.ts` and its `package.json` `pi.extensions` entry
- [x] 1.4 Update `extensions/system-prompt.ts`: rename the `task/subagent` mention (line 22), teach the dispatch-ack + follow-up-delivery contract, and omit the delegation guidance line entirely when `SWIFT_PI_SUBAGENT` is set (D10)

## 2. Registry and dispatch

- [x] 2.1 Implement a module-scope agent registry (id, type, task, status, messages[], usage, spawnedAt)
- [x] 2.2 Implement dispatch-and-return for `ctx.mode === "tui"`: spawn detached children with `SWIFT_PI_SUBAGENT=1` in their environment, register, append the dispatch session entry (D8), return ack immediately
- [x] 2.3 Implement the blocking fallback for non-TUI modes (D2): same child-runner core, await all children, return aggregated results as the tool result
- [x] 2.4 Guard the whole extension on `SWIFT_PI_SUBAGENT` (D10): when set, register nothing (no tool, widget, shortcuts, or delivery wiring)
- [x] 2.5 Wire child-stdout handlers to derive status (waiting/thinking/working/done/failed/aborted) from stream events, using start events for thinking/working transitions
- [x] 2.6 Centralize all background work behind one `try/catch`-guarded dispatcher reading the live `ctx`/`pi` reference (D6/D7)

## 3. Live indicator UI

- [x] 3.1 Implement the indicator-line renderer (`[type|status]`, parent `[⊤]`, colored by status, hidden when empty) via `setWidget({ placement: "belowEditor" })`; clear the widget when the registry is empty
- [x] 3.2 Repaint on every status change (TUI coalesces renders; no persistence on intermediate status changes — only terminal records are written, per D8)
- [x] 3.3 Implement the replay-viewer overlay via `ctx.ui.custom`, showing the full message log of the selected agent
- [x] 3.4 Hotkey-reminder line beneath the indicators (dim; abort key only while an agent is in flight; hidden with the widget when no agents are tracked); the delivered-result renderer no longer repeats the hint

## 4. Selector and hotkeys

- [x] 4.1 `registerShortcut` move-left and move-right with wrap-around (pick non-conflicting keys) — `alt+,` (prev) and `alt+.` (next)
- [x] 4.2 `registerShortcut` open-action on a non-conflicting key (parent `[⊤]` is a no-op) — `alt+o`
- [x] 4.3 `registerShortcut` abort-action on a non-conflicting key (D11): SIGTERM → SIGKILL the selected in-flight agent, status → aborted, append completion entry, deliver diagnostics; no-op on finished agents and the parent — `alt+x`
- [x] 4.4 Keep the selector position sane across repaints (clamp/restore) — `clampSelector()` runs on every repaint

## 5. Delivery and persistence

- [x] 5.1 On completion, deliver via `pi.sendMessage({ customType: "subagent_result", content, display: true, details }, { triggerTurn: true, deliverAs: "followUp" })` — always `followUp`, no `isIdle()` branch (D3); failed/aborted deliver diagnostics the same way; verify the custom message reaches LLM context (fallback: `sendUserMessage` with `followUp`)
- [x] 5.2 Register a message renderer (`registerMessageRenderer("subagent_result", …)`) showing a compact block: agent, status, usage, replay hint
- [x] 5.3 Persist terminal records as session entries (D8): dispatch entry at spawn, completion entry (status, messages, usage) at any terminal state, via `pi.appendEntry`
- [x] 5.4 Restore on `session_start` from `ctx.sessionManager.getEntries()`; dispatch entries without a matching completion entry restore as aborted ("lost — pi exited while running"); repaint the indicator line

## 6. Lifecycle safety

- [x] 6.1 Re-bind module-scope `current = { ctx, pi }` in the `session_start` handler for all reasons
- [x] 6.2 In `session_shutdown`, terminate live children and append their aborted-completion entries (bounded, awaited)
- [x] 6.3 Verify no background callback can propagate an uncaught exception — every background entry point (child stdout/stderr/close/error, `startAndFinalize`, `session_start`, `session_shutdown`, all four shortcut handlers, repaint, delivery) is routed through the `guard()` try/catch or a local try/catch

## 7. Harness collateral

- [x] 7.1 Update `scripts/smoke.mjs`: extend the `pi` stub (`registerShortcut`, `registerMessageRenderer`, `sendMessage`, `sendUserMessage`, `appendEntry` as needed at load time), replace the `extensions/task/index.ts` search-target paths (lines 46, 58), and rename `task` in the required-tool list (line 65)
  - Also updated the extension load list (line ~37) which referenced `extensions/task/index.ts`; the search/ast smoke targets now point at `extensions/subagents/agents.ts` (which contains `AGENT_PROMPTS`).
- [ ] 7.2 Refresh e2e fixtures via `session-to-fixture.mjs` — recorded request payloads embed the tool list, so the rename breaks request matching
  - NOT DONE — requires a live recorded pi session that cannot be produced non-interactively here (no LLM/network in this environment), and hand-editing the fixture to fake it is disallowed.
  - Analysis (why the existing suite is not actually broken by the rename): `e2e/fixtures/default/script.json`'s only assistant tool calls are `bash`, `search`, `read` — there is no `task`/`subagent` tool call. `e2e/runner/session-diff.mjs` compares only user text, assistant content (text/thinking + toolCall name/args), provider/model/api, and toolResults — it does NOT compare the registered tool list or the system prompt, and the faux provider replays recorded assistant messages regardless of the request. The `task` strings inside the fixture are recorded file *content* (deep-research `SKILL.md` and `smoke.mjs` text the session read), carried verbatim, and are unaffected by this code change.
  - What a human must run to genuinely refresh it: record a fresh interactive/`-p` pi session that exercises the renamed `subagents` tool, then `node e2e/tools/session-to-fixture.mjs <session-id-or-path> --name default --force`, and re-run `npm run test:e2e`.

## 8. Verification

- [x] 8.1 Typecheck (`npm run check`) and smoke (`npm run smoke`) — both pass.
- [ ] 8.2 Manual: dispatch 3 agents; confirm parent interactivity, live indicators, traversal, replay, abort hotkey, auto-delivery, reload-restore (including lost-agent → aborted)
  - Requires a human in a real TUI with a live model; cannot be driven headlessly here. A headless harness (see final report) exercised the underlying behaviors against a stub child pi: dispatch returns an ack immediately (parent stays interactive), the indicator repaints on status change and on restore, restore rebuilds the registry from session entries, a dispatch entry with no completion restores as `aborted` (⊘), and completion auto-delivers as a `deliverAs:"followUp"` `subagent_result` message with `triggerTurn:true`. The live indicator visuals, keystroke traversal, the `ctx.ui.custom` replay overlay rendering, and the abort hotkey in a real terminal still need a human pass.
- [ ] 8.3 Manual: run the harness via `pi -p` and confirm the blocking fallback returns aggregated results; confirm a child (`SWIFT_PI_SUBAGENT=1`) exposes no delegation tool
  - Substantively verified headlessly (not via a literal `pi -p` live-model run): with `ctx.mode === "json"` the tool awaits the child and returns the aggregated result inline (`### <task> — completed\n<final text>`), and loading the extension with `SWIFT_PI_SUBAGENT=1` registers zero tools/shortcuts/renderers/handlers (tool absent from the child's registry). A literal `pi -p` invocation against a live model was not performed.
