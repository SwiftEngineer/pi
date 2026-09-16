## MODIFIED Requirements

### Requirement: Background dispatch
The subagent tool MUST spawn one isolated `pi` child process per task. In interactive TUI mode it MUST return a dispatch acknowledgement immediately, without waiting for any child to finish, so the parent agent remains interactive during subagent execution. In non-interactive modes it MUST instead execute blocking: await all children and return their aggregated results as the tool result.

Each dispatched agent MUST run with a durable, resumable session: the child is spawned with a deterministic session id equal to the agent's registry id and a dedicated private session directory (not the project session dir), so that the same spawn invocation creates the session on first dispatch and resumes it on any later engagement. The extension MUST guarantee at most one live child process per agent record at any time, and the dispatch entry MUST record the spawned child's process id so the single-writer guarantee can be enforced across parent restarts.

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

#### Scenario: Durable per-agent session
- **WHEN** a subagent is dispatched
- **THEN** its child runs with a persistent session identified by the agent's id in a private session directory under the OS temp dir, and the session survives the child's exit so the agent can be re-engaged later; the session directory is not the project session dir and does not appear in the operator's session picker.

#### Scenario: Single live child per agent
- **WHEN** any engagement path (dispatch, re-engagement, or interrupt-and-resume) spawns a child for an agent record
- **THEN** any prior child of that record has already terminated (killed and awaited) before the new spawn, sends on the same record serialize rather than interleave, and — for a re-engagement after a parent restart — the prior child's recorded process id has been probed and found not to be running, so two processes never append to the same session concurrently.

### Requirement: Automatic result delivery
When a subagent engagement completes (each turn of the agent's life), its result MUST be delivered to the parent agent automatically as a custom follow-up message — `pi.sendMessage` with `{ triggerTurn: true, deliverAs: "followUp" }`, unconditionally — with no operator action required and no idle/busy branching. The full result text MUST reach the parent's LLM context; the chat display MUST render as a compact block via a registered message renderer. The delivered content's LLM-visible header MUST include the agent's registry id, so the parent can address the agent in a later re-engagement. An agent MAY deliver multiple times over its lifetime, once per engagement — except that an engagement terminated by a send-initiated interruption delivers no intermediate diagnostics (see Parent-initiated interruption).

#### Scenario: Deliver when idle
- **WHEN** a subagent engagement finishes and the parent is idle
- **THEN** the delivery triggers a new parent turn (the `followUp` option is ignored while idle).

#### Scenario: Queue when busy
- **WHEN** a subagent engagement finishes and the parent is mid-turn
- **THEN** the delivery is queued as a follow-up and processed after the parent's current turn. The unconditional `followUp` option means no delivery can be lost to a race between checking idleness and sending.

#### Scenario: Failed or aborted agent
- **WHEN** a subagent engagement fails or the agent is aborted
- **THEN** its failure diagnostics are delivered the same way, and its status reflects failed or aborted.

#### Scenario: Delivered header carries the agent id
- **WHEN** any result is delivered to the parent
- **THEN** the LLM-visible content begins with a header naming the agent's type, id, and status (e.g. `[subagent task sa-8fk2 — done] <task>`), providing the handle required for re-engagement.

#### Scenario: Re-engaged agent delivers again
- **WHEN** an agent that already delivered once is re-engaged and its new turn completes
- **THEN** the new result is delivered as a fresh follow-up message from the same agent id, without disturbing the earlier delivery.

### Requirement: Persistence and restore
Agent records MUST persist as session entries via `pi.appendEntry` — a dispatch entry at spawn (recording the agent's id and the spawned child's process id) and a completion entry (status, captured messages, usage) at every engagement's terminal state, one per engagement — and MUST be restored from `ctx.sessionManager.getEntries()` on every session start, so completed-agent history survives reloads and session switches. Persistence is session-scoped: no shared state file, so concurrent pi instances and other projects are unaffected. A dispatch entry with no matching completion entry restores as aborted ("lost"), and such a record may be re-engaged only after the send tool verifies its durable session file exists (it may never have been created, or may have been reclaimed).

#### Scenario: Restore on session start
- **WHEN** a session starts for any reason (startup, reload, new, resume, fork)
- **THEN** the registry is rebuilt from the session's dispatch and completion entries and the indicator line reflects restored agents.

- **WHEN** an agent is dispatched or one of its engagements reaches a terminal state (done, failed, aborted)
- **THEN** the corresponding entry is appended to the session: exactly one dispatch entry per agent (including the first child's pid), one small engagement entry per resume spawn (including that child's pid, so an engagement that never completes still leaves a probeable pid), and one completion entry per engagement. Intermediate status changes are not persisted.

#### Scenario: Lost agents restore as aborted and conditionally re-engagable
- **WHEN** the session contains a dispatch entry with no matching completion entry (e.g. pi crashed or was killed while the agent ran)
- **THEN** the agent restores with status aborted and is identifiable as lost rather than completed, and the parent may re-engage it only if the send tool's existence check finds its durable session file — the send MUST fail explicitly with "durable session missing" otherwise, never silently create a fresh blank session.

#### Scenario: Multi-engagement history survives reload
- **WHEN** an agent completed two or more engagements before a reload
- **THEN** restoration folds the engagement completion entries with the latest entry winning (each entry embeds the full cumulative message log and cumulative usage, so the newest entry is the record's current state), the full transcript and usage remain visible in the replay viewer without duplication, and earlier entries remain available as delivery history.

## ADDED Requirements

### Requirement: Agent re-engagement
A parent-facing tool (`subagents_send`) MUST let the parent send a new prompt to an existing agent identified by its registry id. For an agent in a terminal state (done, failed, aborted, or restored-as-lost), the tool MUST first verify the agent's durable session file exists in the private session directory and MUST fail the send with an explicit error if it does not (the platform's create-or-open semantics would otherwise silently start a blank session), then spawn a resume child attached to that session — preserving the agent's registry record, id, transcript, and accumulated usage — with the new message as the engagement's prompt, and return a dispatch acknowledgement in interactive TUI mode (the result auto-delivers per the delivery requirement). In non-interactive modes the resume child MUST run inline and its result MUST return as the tool result. A send targeting an in-flight agent without the interrupt option MUST be rejected with an error and MUST NOT modify the agent. Sends MUST execute sequentially and MUST claim the target record synchronously before spawning, and a send on a restored agent whose recorded child process is still running MUST be refused. Resume engagements MUST NOT pass `--model`: the session's stored model carries forward.

#### Scenario: Re-engage a completed agent
- **WHEN** the parent calls the send tool with the id of a done agent and a follow-up message (e.g. reviewer feedback for the implementer)
- **THEN** the durable session is verified, a resume child starts on the agent's existing session with the message as its prompt, the registry record retains its original identity, the indicator shows the agent in flight again, and the transcript grows in place.

#### Scenario: Re-engage a failed or aborted agent
- **WHEN** the parent sends a corrective message to a failed or aborted agent
- **THEN** the resume child starts on the same session, so the agent sees its prior partial work and the correction together.

#### Scenario: Re-engage a lost agent after a pi restart
- **WHEN** a session is restored with a lost (dispatched-but-never-completed) agent, its recorded child process is not running, and its durable session file still exists
- **THEN** the parent may re-engage it via the send tool; the resume child continues from the session's last persisted state.

#### Scenario: Missing durable session fails explicitly
- **WHEN** the send tool targets a terminal or lost agent whose session file cannot be found in the private session directory (never created because the child died before its first assistant message, reclaimed by the OS, or the working directory differs)
- **THEN** the send fails with "durable session missing — cannot re-engage" and no child is spawned; a blank session with the agent's id is never silently created.

- **WHEN** the send tool targets a restored agent whose persisted entries record a child pid that is still running (an orphan left by a parent crash — recorded by the dispatch entry or the latest engagement entry)
- **THEN** the send is refused with an error naming the possibly-live child, so a second writer never opens the same session file.

#### Scenario: A record whose session went missing once stays refused
- **WHEN** a previous resume engagement failed because the child recreated a blank session, and the send tool targets that agent again (its session file with the agent's id now exists — the blank one the child created)
- **THEN** the send is refused with an explicit re-dispatch error; the existence scan alone never silently re-enables the agent, whose original context is gone.

#### Scenario: Concurrent sends serialize
- **WHEN** the parent issues multiple send tool calls in a single turn, or a send races an operator abort
- **THEN** the sends execute sequentially and each claims its target record synchronously before spawning, so no record ever ends up with two live children or two pending engagements.

#### Scenario: Resume preserves the agent's model
- **WHEN** an agent is re-engaged
- **THEN** the resume spawn passes no `--model` argument, and the child resolves the model from the agent's session (the model it ran with at dispatch), not from the harness default or the parent's current selection.

#### Scenario: Running agent rejects a plain send
- **WHEN** the send tool targets an agent whose child process is still live and `interrupt` is not set
- **THEN** the tool call fails with an error explaining that the agent is running and that `interrupt: true` (or waiting for the result) is required, and the agent is unaffected.

#### Scenario: Unknown id fails informatively
- **WHEN** the send tool receives an id that matches no tracked agent
- **THEN** the tool call fails with an error listing the currently known agent ids.

#### Scenario: Send outside the TUI runs inline
- **WHEN** the send tool is invoked in a non-interactive mode
- **THEN** the resume child runs synchronously and its final result text is returned directly as the tool result.

### Requirement: Parent-initiated interruption
The send tool's `interrupt` option MUST atomically redirect an in-flight agent: the live child is terminated (SIGTERM with bounded SIGKILL escalation, as in manual abort), the termination is awaited, and a resume child is spawned on the agent's durable session with the new message as a corrective prompt. The agent's transcript and identity are preserved across the interruption; work persisted before the kill remains in context (with interrupted turns repaired at the provider layer per platform behavior), and the record's status transitions reflect the kill and the subsequent engagement. The interrupted (killed) engagement MUST NOT deliver aborted diagnostics to the parent — its completion entry still persists, and the redirected engagement's result is delivered on completion; operator-initiated aborts keep delivering diagnostics as before.

#### Scenario: Interrupt and redirect a running agent
- **WHEN** the parent calls the send tool with `interrupt: true` on an in-flight agent
- **THEN** the live child is terminated with the established escalation behavior, the resume child starts on the same session with the corrective message, and the operator observes the agent pass through aborted back into thinking/working under the same indicator.

#### Scenario: Interruption preserves prior context
- **WHEN** the resumed child processes the corrective message
- **THEN** its LLM context contains the agent's full prior session history (including a synthetic error result for any tool call killed mid-flight) followed by the corrective message.

#### Scenario: Interrupted engagement delivers no aborted diagnostics
- **WHEN** an in-flight agent is killed by a send-initiated interruption
- **THEN** no "aborted" result message is delivered for the killed engagement (the completion entry is still persisted), and the next delivery the parent sees is the redirected engagement's result.

#### Scenario: Interrupt on a terminal agent falls back to re-engagement
- **WHEN** the send tool is called with `interrupt: true` on an agent that is not in flight
- **THEN** the behavior is identical to a plain send (there is nothing to kill).

#### Scenario: Operator abort unaffected
- **WHEN** the operator aborts the selected agent via the existing hotkey
- **THEN** the behavior matches v1 (child terminated, status aborted, diagnostics delivered); the aborted agent additionally remains re-engagable via the send tool.
