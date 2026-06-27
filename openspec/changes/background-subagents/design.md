## Context

The harness currently ships `extensions/task/index.ts`: a blocking tool that spawns N child `pi` processes, awaits them all via a concurrency-limited map, extracts only each child's final assistant text, and returns one aggregated blob. The parent agent is stuck mid-turn for the entire duration; there is no progress visibility, no per-agent history, and no way to interact with the parent meanwhile.

Pi's core exposes a powerful extension API (verified against the `dist` type defs and examples): `registerTool` with `onUpdate`/`renderResult`, `pi.registerShortcut(keyId, …)`, `ctx.ui.setWidget(key, content, { placement })`, `ctx.ui.custom(factory, { overlay })`, `ctx.ui.setStatus`, `theme.fg(color, text)`, and `pi.sendUserMessage(content, { deliverAs })`. Pi's bundled `examples/extensions/subagent/` already solves the unglamorous hard parts (full message-stream parsing via `message_end`/`tool_result_end`, usage accounting, SIGTERM abort, rich render).

A focused runtime investigation confirmed the behaviors the background model depends on:

| Question | Finding (high confidence, source-grounded) |
|---|---|
| `setWidget`/`setStatus` from a detached child-stdout handler | **Safe.** No turn/render assertion; mutate state + `requestRender()`. |
| Rapid `setWidget` calls | **Safe.** TUI coalesces same-tick calls and throttles to ~60 fps (16 ms). |
| `sendUserMessage`/`sendMessage` delivery semantics | `deliverAs` is consulted **only while streaming** (`agent-session.js` `prompt()`/`sendCustomMessage()`); when idle it is ignored and a new turn starts. Always passing `followUp` is therefore race-free. Busy without `deliverAs` throws internally, but the `pi.*` wrappers catch and route to the extension-error channel — the delivery would be **silently lost**, another reason to always pass `followUp`. |
| How do `custom`-role messages reach the LLM? | `convertToLlm()` maps them to `user` role with `content` intact; `display` + `registerMessageRenderer` control chat rendering; the message is auto-persisted as a `CustomMessageEntry` with `details`. |
| What does `--mode json` emit? | **Every** session event (`print-mode.js` serializes all of `session.subscribe`): `message_start`, `message_update`, `tool_execution_start/end`, `message_end`, … — richer than the example's `message_end`-only parsing. |
| Do children load harness extensions? | **Yes** — the harness is installed globally, so `pi --mode json -p` children bind the same extensions. Print mode **exits as soon as the turn's `prompt()` resolves**, so a child that dispatch-and-returns would orphan its grandchildren (see D2/D10). |
| Is `ctx.ui` / `pi` recreated per session? | **Yes**, on every `session_start` (all five reasons). Old refs go stale. |
| Stale-context use | **Throws** via `assertActive`. An uncaught throw in a background callback **crashes the process**. |
| `session_shutdown` handler | **Async and awaited**; can kill children + flush state. No framework timeout — keep bounded. Extension-spawned children are **not** auto-tracked. |
| Where does `getAgentDir()` point? | The **global** `~/.pi/agent` — a state file there would be shared across all projects and all concurrent pi instances (clobbering, cross-project bleed). Motivates session-entry persistence (D8). |

## Goals / Non-Goals

**Goals:**
- Non-blocking subagent dispatch; parent remains interactive (Feature 1).
- Live, colored, two-symbol per-agent indicators below the prompt (Feature 2).
- Hotkey-driven selector traversal (Feature 3).
- On-demand full session replay per agent (Feature 2).
- Automatic result delivery (no operator ack).
- Explicit operator abort of an individual in-flight agent.
- Crash-safe lifecycle across reloads and session switches.

**Non-Goals:**
- **Nested delegation.** Subagents must not see or use the delegation tool at all (D10). The old `task` tool allowed recursive spawning; removing it is deliberate.
- **In-flight agent survival across reload/session-switch.** Children are killed on shutdown; only the historical record is restored. A daemon + IPC re-attach model is explicitly out of scope for v1.
- Steering/interrupting an in-flight subagent's stream beyond kill/abort.
- Subagent-to-subagent or subagent-to-parent messaging during execution.
- Persisting/relaying the parent's own conversation.

## Decisions

**D1 — Rebase from the official `subagent` example, then extend.** Port its message-capture, usage, and abort handling; add the registry, widget, hotkeys, persistence, and delivery layer. Delete `extensions/task/index.ts`. *Rationale:* the proven ~70% (stream parsing, render, abort) comes for free; only the novel ~30% is new work.

**D2 — Dispatch-and-return in interactive TUI; blocking fallback everywhere else.** When `ctx.mode === "tui"`, the tool returns a dispatch ack immediately. In any other mode (`json`, `print`, `rpc`) it runs the **blocking** path: await all children, return aggregated results as the tool result (today's contract). *Rationale:* print mode exits as soon as the turn's `prompt()` resolves — dispatch-and-return there would orphan children and lose results (verified in `print-mode.js`). The blocking fallback keeps direct `pi -p` harness use and the e2e suite working. Both paths share the same child-runner core; only the return/delivery wrapper differs.

**D3 — Automatic delivery via a custom follow-up message, always `deliverAs: "followUp"`.** On completion, deliver via `pi.sendMessage({ customType: "subagent_result", content: <full result text>, display: true, details: {...} }, { triggerTurn: true, deliverAs: "followUp" })`, with a `registerMessageRenderer` showing a compact styled block (agent, status, usage, replay hint). **No `isIdle()` branch:** `deliverAs` is only consulted while streaming — when idle it is ignored and `triggerTurn` starts a new turn. *Rationale:* an `isIdle()` check introduces a TOCTOU race (operator submits between check and send → the internal throw is swallowed into the extension-error channel and the delivery is lost). Custom messages reach the LLM as `user`-role content but render compactly in chat instead of a wall of text masquerading as operator input; the delivered message is also auto-persisted with its `details`.

**D4 — Indicator grammar: `[type|status]`, parent `[⊤]`, recolorable glyphs only.**

```
   type        glyph        status     glyph   color
   ─────       ─────        ─────      ─────   ─────
   parent      ⊤            waiting    ·       dim
   explore     ⌕            thinking   ∾       accent
   plan        ∡            working    ▶       warning
   designer    ◬            done       ✓       success
   reviewer    ∴            failed     ✗       error
   librarian   ⌘            aborted    ⊘       warning
   oracle      ✦
   task        ▦
   quick_task  ▸            (was ⚡ — dropped: emoji resists ANSI recolor)
```

*(Reviewer was ⚖ — dropped for the same reason as ⚡: U+2696 carries the Emoji property and renders double-width/fixed-color in some terminals. ∴ U+2234 is pure text. Acceptance check: verify every glyph renders single-width and recolorable in the target terminals.)*

**D5 — Live UI via `setWidget({ placement: "belowEditor" })`; replay overlay via `ctx.ui.custom`.** The indicator line is a below-editor widget repainted on every status change, with a dim hotkey-reminder line beneath it (abort listed only while an agent is in flight); both share the widget's visibility (present only while agents are tracked). The replay viewer is a keyboard-focused overlay. Dialog/focus methods are invoked **only** from a synchronous hotkey handler, never from a background callback.

**D6 — Re-bind on every `session_start`; single module-level live reference.** A module-scope `current = { ctx, pi }` is overwritten in the `session_start` handler (fires for all five reasons). Background callbacks read only `current`, never a captured local. *Mandatory:* captured `ctx`/`pi` throw via `assertActive` after any reload/switch.

**D7 — Background callbacks never throw.** Every child-stdout / completion / timeout callback body is wrapped in `try/catch`; an uncaught throw there crashes the process. All background work is centralized behind one guarded dispatcher.

**D8 — Persist via session entries (`pi.appendEntry`), not a state file.** Two append-only entry kinds: a **dispatch entry** at spawn (agent id, type, task, spawnedAt) and a **completion entry** at any terminal state (status, captured messages, usage, diagnostics). On `session_start`, rebuild the registry from `ctx.sessionManager.getEntries()`; a dispatch entry with no matching completion entry is shown as **aborted** ("lost — pi exited while running"). *Rationale:* `getAgentDir()` is global, so a state file there is clobbered by concurrent pi instances and bleeds across projects. Session entries are append-only (crash-safe, no debounce), session-scoped, follow resume/fork semantics for free, and require no new files. Intermediate status changes are **not** persisted — in-flight agents never survive shutdown, so only terminal records matter.

**D9 — Kill children on `session_shutdown` (async, bounded).** Children are not auto-tracked; the extension terminates them and appends their aborted-completion entries in the awaited `session_shutdown` handler, kept bounded (no framework timeout).

**D10 — Subagents never see the delegation tool.** The dispatcher spawns children with `SWIFT_PI_SUBAGENT=1` in their environment. When that variable is set, the extension registers **nothing** (no tool, no widget, no shortcuts, no delivery wiring) and `extensions/system-prompt.ts` omits its delegation guidance line. Because Pi builds the tool schema and prompt from registered tools, the tool is invisible to the child's LLM — nesting is prevented at the capability level, not by instruction. Direct non-interactive harness use (env var absent) still gets the tool via D2's blocking fallback, and any children it spawns carry the env var.

**D11 — Explicit abort of the selected agent.** A registered hotkey aborts the currently selected in-flight agent: SIGTERM with a 5 s SIGKILL escalation (same as the capture core), status → aborted, completion entry appended, diagnostics delivered per D3. Selecting a finished agent or the parent makes abort a no-op. *Rationale:* detachment removes the old implicit abort (parent ESC no longer kills children); without an explicit surface, the spec's `aborted` state would be unreachable and a runaway agent unkillable short of quitting pi.

## Risks / Trade-offs

- **Result arrives as a new turn, not the original tool result.** The parent sees a dispatch ack, then results land as follow-up turns. The system prompt must teach this contract so the parent doesn't wait inline. *(Mitigation: explicit prompt guidelines.)*
- **Nested delegation is removed.** Under the old `task` tool, children could recursively delegate; under D10 they cannot. Deliberate: uncontrolled fan-out from detached background children has no visibility or budget story in v1.
- **In-flight agents lost on reload.** Acceptable for v1; operators are notified via the restored-as-aborted records (D8). Daemon survival is a larger future effort.
- **Stale-context crash if a defensive pattern is missed.** Any background callback forgetting `try/catch` or using a captured `ctx` can crash Pi. *(Mitigation: centralize behind one guarded dispatcher; review.)*
- **Delivery ordering under concurrency.** Multiple agents finishing while idle: the first triggers a turn, the rest queue as follow-ups (serialized). Deterministic and acceptable.
- **Session-file growth.** Completion entries embed full message logs, so heavy delegation grows the session file. Acceptable: the replay data lives with the conversation it belongs to; delivered payloads remain size-capped as in the official example.
- **`custom`-message delivery contract.** D3 assumes custom messages reach the LLM as `user`-role content (verified in `convertToLlm()`); if an edge case surfaces during implementation, `sendUserMessage(..., { deliverAs: "followUp" })` is the drop-in fallback with the same race-free semantics.
- **`[⊤]` open-action is a no-op.** Selecting/opening the parent does nothing agent-specific. Minor UX wart; acceptable for v1.
- **Token cost of full capture.** Per-agent full message capture increases retained detail; the replay overlay can summarize, and delivered payloads are size-capped as in the official example.
