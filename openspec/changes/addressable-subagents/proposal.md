## Why

`background-subagents` (v1) ships one-shot subagents: each child runs `pi --mode json -p --no-session`, one assignment in, one result out, process exits, context destroyed. Two consequences the parent cannot work around:

1. **No re-engagement.** The implement→review→fix loop — the most natural delegation pattern — forces a fresh agent per fix iteration, re-paying discovery cost, or a lossy parent-side summary paste. The implementer's context of what it just built is destroyed at exit.
2. **No correction.** When a subagent goes down the wrong path, the parent's only recourse is to absorb the failure and redispatch from scratch. The abort hotkey kills the agent; there is no way to kill it *and* redirect it with its partial work intact.

v1's design deferred both as explicit non-goals ("steering/interrupting beyond kill/abort", "no messaging during execution") pending a daemon + IPC model. Investigation shows that model is unnecessary: Pi's session machinery (`--session-id` / `--session-dir`) already supports deterministic, resumable agent sessions, and pi-ai's provider payload builder already repairs interrupted histories (synthetic tool results for orphaned tool calls, skipping aborted assistant messages) — so "kill a child mid-turn, then resume its session with a corrective prompt" is safe with zero extension-side repair logic.

We give every subagent a durable session and the parent two new verbs — **re-engage** a finished agent and **interrupt-and-redirect** a running one — while keeping v1's entire architecture (registry, stream capture, delivery, hotkeys, persistence) intact. No daemons, no RPC protocol, no parked processes. Every context gap (missing session file, live orphaned child) fails loudly rather than silently.

## What Changes

- **Children persist durable sessions.** Drop `--no-session`; spawn with `--session-id <agent id>` and a private `--session-dir` under the OS temp dir, and record the child's pid in the dispatch entry. The same spawn shape creates the session on first dispatch and resumes it on every later engagement (verified: `--session-id` opens the existing session when present, else creates one with that exact id).
- **New `subagents_send` tool** for the parent:
  - `{ id, message }` on a terminal agent (done / failed / aborted / lost-restored) → **verifies the durable session file exists** (the platform's create-or-open semantics would otherwise silently start a blank session — a killed-before-first-response child, OS tmp reclaim, or a cwd mismatch all leave no usable file), then spawns a resume child whose prompt is `message`; the agent continues with its full prior context under the same registry record and id, **without `--model`** (the session's stored model carries forward).
  - `{ id, message, interrupt: true }` on an in-flight agent → SIGTERMs the live child (existing escalation path), awaits close, then resumes the session with `message` as the corrective prompt. The killed engagement persists its completion entry but delivers **no** intermediate "aborted" diagnostics — the next delivery the parent sees is the redirected engagement's result.
  - `{ id, message }` on a running agent without `interrupt` → rejected with an error (no queueing). Rejections are race-free: the tool declares sequential execution mode and claims the target record synchronously before spawning; a restored agent whose recorded child pid is still alive is refused (an orphaned child may still be writing its session file).
  - TUI mode: dispatch-and-return ack; the result auto-delivers as a follow-up (v1 contract). Non-TUI blocking mode: the resume child runs inline and its result returns as the tool result.
- **Turn-shaped agent records.** A registry record now spans multiple engagements: transcripts accumulate, the status machine repeats per engagement, engagement-scoped fields reset on every engagement start (including un-terminalizing restored-lost records), and each engagement completion appends a completion entry (one per engagement, full cumulative log; restore folds latest-entry-wins) and delivers the result. The indicator keeps v1's status set; a resumed agent re-enters thinking/working.
- **Delivered results carry the agent id** in the LLM-visible header (`[subagent task sa-8fk2 — done] …`) — the handle the parent needs to address a re-engagement. Without it the feature is unreachable.
- **System-prompt guidance** teaches the send contract and the review-loop pattern (including a cap on fix iterations before reporting back).

## Capabilities

### Modified Capabilities

- `subagents`: re-engagement of subagents across turns via durable per-agent sessions, parent-initiated interrupt-and-redirect, per-turn result delivery, and per-turn completion persistence. (Delta applies on top of the `background-subagents` change's spec, which must land first.)

## Impact

- **Depends on:** `background-subagents` landing first (currently 27/30; remaining items — e2e fixture refresh and manual verification — are orthogonal to this change and can proceed in parallel).
- **Code:** `extensions/subagents/index.ts` (spawn flags, pid recording, send tool, per-turn finalize/delivery with delivery suppression, per-turn completion entries, restore updates); `extensions/system-prompt.ts` (send contract + review-loop guidance); `scripts/smoke.mjs` (add `subagents_send` to the required-tool list only). `extensions/subagents/agents.ts` unchanged.
- **Dependencies:** none new.
- **Behavior / contract:** three visible changes for the parent — a second tool, per-turn deliveries (an agent may deliver more than once; send-initiated interruptions deliver no aborted diagnostics), and ids in delivered headers. Children now write session files to a private tmp dir (bounded disk growth, OS-cleaned; no pruning in this change). Abort semantics unchanged: the operator hotkey still kills; the killed agent merely becomes re-engagable instead of dead.
- **Compatibility:** verified upstream behaviors this change relies on (do not re-litigate, but guard in tasks): `--session-id` create-or-open semantics (`main.js` `createSessionManager`), session-id charset (`assertValidSessionId`), lazy session-file creation (`_persist` writes nothing until the first assistant message), pi-ai's orphaned-tool-call repair in `transformMessages` (synthetic `isError` results; aborted assistant messages skipped), per-tool `executionMode: "sequential"` support (`agent-loop.js` `executeToolCalls`), and resumed print-mode children streaming only the new engagement's events. Non-TUI e2e/blocking path: send runs inline like the v1 blocking fallback.
