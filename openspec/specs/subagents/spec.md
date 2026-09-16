# subagents Specification

## Purpose
TBD - created by archiving change background-subagents. Update Purpose after archive.
## Requirements
### Requirement: Background dispatch
The subagent tool MUST spawn one isolated `pi` child process per task. In interactive TUI mode it MUST return a dispatch acknowledgement immediately, without waiting for any child to finish, so the parent agent remains interactive during subagent execution. In non-interactive modes it MUST instead execute blocking: await all children and return their aggregated results as the tool result.

#### Scenario: Dispatch returns immediately
- **WHEN** the parent calls the subagent tool with one or more tasks in interactive TUI mode
- **THEN** each task is spawned as a detached child process, a registry entry is created per task, and the tool returns a short dispatch acknowledgement naming the dispatched agents — all without blocking on child completion.

#### Scenario: Parent stays interactive
- **WHEN** subagents are running
- **THEN** the operator may submit new messages to the parent agent and receive responses in new turns, independent of subagent progress.

#### Scenario: Blocking fallback outside the TUI
- **WHEN** the subagent tool is invoked while the harness runs in a non-interactive mode (`json`, `print`, or `rpc`)
- **THEN** the tool awaits all spawned children and returns their aggregated results directly as the tool result, because non-interactive processes exit when the turn ends and background delivery would be lost.

#### Scenario: Dispatch-level model selection
- **WHEN** the tool is called with a dispatch-level `model` ("provider/model-id", or a bare `model-id` resolved against the available models) and tasks without their own model
- **THEN** every spawned child for that dispatch runs that model, passed to the child as `--model`.

#### Scenario: Per-task model override
- **WHEN** a task entry carries its own `model`
- **THEN** that task's child runs the task's model, overriding the dispatch-level value.

#### Scenario: Unknown model fails fast
- **WHEN** a requested model does not resolve to an available model
- **THEN** the tool call fails with an error naming the unresolvable reference and listing available models, and no child is spawned and no dispatch entry is persisted.

#### Scenario: No model requested
- **WHEN** neither the dispatch nor any task specifies a model
- **THEN** children resolve their model exactly as a plain `pi` invocation would (the harness default), and the parent's current in-session selection is not propagated.

### Requirement: No nested delegation
Subagent child processes MUST NOT have access to the delegation tool. Children are spawned with a subagent marker (`SWIFT_PI_SUBAGENT=1`) in their environment; when the marker is set, the extension MUST register no tool, UI, or shortcuts, and the harness system prompt MUST omit its delegation guidance.

#### Scenario: Subagent cannot see the tool
- **WHEN** the harness loads in a process whose environment carries the subagent marker
- **THEN** the delegation tool is absent from the registered tool list and from the system prompt, so the child's model cannot invoke or reference it.

#### Scenario: Marker propagates through the blocking fallback
- **WHEN** children are spawned via the non-interactive blocking fallback
- **THEN** those children also carry the subagent marker and cannot delegate further.

### Requirement: Live status tracking
Each dispatched agent MUST carry a status derived from its child JSON event stream, updated in real time, with states: waiting, thinking, working, done, failed, and aborted. The child stream includes start events (`message_start`, `tool_execution_start`), and status transitions MUST use them rather than waiting for end events.

#### Scenario: Status reflects stream events
- **WHEN** a child starts an assistant message, starts a tool execution, completes, fails, or is aborted
- **THEN** the agent's status becomes thinking, working, done, failed, or aborted respectively; a child that has spawned but emitted nothing is waiting.

#### Scenario: Status changes drive the UI
- **WHEN** any agent's status changes
- **THEN** the indicator line is repainted to reflect the new status. Intermediate status changes are not persisted; persistence happens only on dispatch and terminal states.

### Requirement: Indicator line
A line rendered below the prompt input MUST display one indicator per tracked agent plus a leading indicator for the parent, colored by status using only plain recolorable Unicode glyphs, with a dim hotkey-reminder line beneath it. Both lines are shown only while agents are tracked.

#### Scenario: Indicator format
- **WHEN** the indicator line is rendered
- **THEN** each subagent appears as a two-symbol bracketed token `[type|status]` where `type` identifies the agent role and `status` reflects the current state, and the parent appears as `[⊤]`; the widget is hidden entirely when no subagents are tracked.

#### Scenario: Hotkey reminder
- **WHEN** the indicator line is visible
- **THEN** a dim reminder line beneath it lists the selector, replay, and abort hotkeys, including the abort key only while at least one agent is in flight; the reminder disappears with the indicator line when no subagents are tracked.

#### Scenario: Glyph recolorability
- **WHEN** indicators are rendered
- **THEN** every glyph used (type and status) is a single-codepoint Unicode symbol that accepts ANSI color; no emoji or other fixed-color glyph is used.

### Requirement: Selector traversal
Two registered hotkeys MUST move a single selector one indicator left and one indicator right across the indicator line, wrapping at the ends.

#### Scenario: Move selector
- **WHEN** the operator presses the move-right or move-left hotkey
- **THEN** the selector advances to the next or previous indicator, wrapping from last to first and vice versa, and the indicator line is repainted to highlight the newly selected indicator.

### Requirement: Session replay viewer
Opening the currently selected agent MUST display its full captured message stream — from the initial assignment through every assistant turn and tool result to the final message — in a keyboard-focused overlay. While the captured stream is still growing, the overlay MUST follow the live tail: the viewport stays pinned to the newest lines unless the operator scrolls up, and scrolling back to the bottom re-engages the live tail.

#### Scenario: Open selected agent
- **WHEN** the operator triggers open on a selected subagent indicator
- **THEN** an overlay (`ctx.ui.custom`) renders that agent's complete message log, including tool calls and their results, and remains until the operator dismisses it.

#### Scenario: Live tail while in flight
- **WHEN** new transcript lines arrive while the overlay is open on an in-flight agent and the viewport is at the bottom
- **THEN** the viewport stays anchored to the newest lines as they arrive, with no operator input required.

#### Scenario: Scrolling up freezes the tail
- **WHEN** the operator pages or lines up while the overlay is open
- **THEN** the viewport stays fixed on the lines being read even as new transcript lines arrive; the new lines accumulate below the fold and the feed keeps updating.

#### Scenario: Returning to the bottom resumes the tail
- **WHEN** the operator pages or lines down until the viewport reaches the bottom of the transcript, or presses the end key
- **THEN** the live tail re-engages and the viewport stays pinned to the newest lines again.

#### Scenario: Open on parent indicator
- **WHEN** the selected indicator is the parent `[⊤]`
- **THEN** no agent-specific overlay opens (the parent's session is the normal chat view).

### Requirement: Automatic result delivery
When a subagent completes, its result MUST be delivered to the parent agent automatically as a custom follow-up message — `pi.sendMessage` with `{ triggerTurn: true, deliverAs: "followUp" }`, unconditionally — with no operator action required and no idle/busy branching. The full result text MUST reach the parent's LLM context; the chat display MUST render as a compact block via a registered message renderer.

#### Scenario: Deliver when idle
- **WHEN** a subagent finishes and the parent is idle
- **THEN** the delivery triggers a new parent turn (the `followUp` option is ignored while idle).

#### Scenario: Queue when busy
- **WHEN** a subagent finishes and the parent is mid-turn
- **THEN** the delivery is queued as a follow-up and processed after the parent's current turn. The unconditional `followUp` option means no delivery can be lost to a race between checking idleness and sending.

#### Scenario: Failed or aborted agent
- **WHEN** a subagent fails or is aborted
- **THEN** its failure diagnostics are delivered the same way, and its status reflects failed or aborted.

### Requirement: Manual abort
A registered hotkey MUST abort the currently selected in-flight agent: the child is terminated (SIGTERM, escalating to SIGKILL after a bounded delay), the status becomes aborted, a completion entry is persisted, and diagnostics are delivered like any terminal result.

#### Scenario: Abort a running agent
- **WHEN** the operator presses the abort hotkey while an in-flight agent is selected
- **THEN** the child process is terminated, the agent's status becomes aborted, and abort diagnostics are delivered to the parent.

#### Scenario: Abort is a no-op otherwise
- **WHEN** the abort hotkey is pressed while the selection is the parent `[⊤]` or an agent already in a terminal state
- **THEN** nothing happens.

### Requirement: Persistence and restore
Agent records MUST persist as session entries via `pi.appendEntry` — a dispatch entry at spawn and a completion entry (status, captured messages, usage) at any terminal state — and MUST be restored from `ctx.sessionManager.getEntries()` on every session start, so completed-agent history survives reloads and session switches. Persistence is session-scoped: no shared state file, so concurrent pi instances and other projects are unaffected.

#### Scenario: Restore on session start
- **WHEN** a session starts for any reason (startup, reload, new, resume, fork)
- **THEN** the registry is rebuilt from the session's dispatch and completion entries and the indicator line reflects restored agents.

#### Scenario: Persist on dispatch and terminal state
- **WHEN** an agent is dispatched or reaches a terminal state (done, failed, aborted)
- **THEN** the corresponding entry is appended to the session. Intermediate status changes are not persisted.

#### Scenario: Lost agents restore as aborted
- **WHEN** the session contains a dispatch entry with no matching completion entry (e.g. pi crashed or was killed while the agent ran)
- **THEN** the agent restores with status aborted and is identifiable as lost rather than completed.

### Requirement: Lifecycle safety
The extension MUST re-bind its live Pi context/UI reference on every session start, MUST never hold a stale context across sessions, and MUST clean up child processes on shutdown.

#### Scenario: Re-bind on session start
- **WHEN** a session starts for any reason
- **THEN** the extension's live context and API references are refreshed from the `session_start` handler; background callbacks use only those refreshed references.

#### Scenario: Kill on shutdown
- **WHEN** a session shuts down (quit, reload, new, resume, fork)
- **THEN** all live child processes are terminated and their aborted-completion entries are appended to the session before shutdown proceeds.

#### Scenario: Background callback error containment
- **WHEN** a background callback (child stdout handler, completion handler) encounters an error, including a stale-context throw
- **THEN** the error is caught and contained and never propagates as an uncaught exception.

