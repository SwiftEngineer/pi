## Why

The harness ships a single delegation tool, `extensions/task/index.ts`, that spawns child `pi` processes and **blocks the parent agent's turn** until all of them finish. While blocked the operator cannot converse with the parent, there is no visibility into in-flight subagent progress, and only each child's final text is retained. As delegation grows, the blocking model and the absence of observability become the limiting factor.

We want subagents to behave as long-lived, observable **background workers** so the operator keeps a live, two-way conversation with the parent throughout, can watch each agent's progress, and can replay any agent's full session on demand.

## What Changes

- **Replace** the blocking `task` tool with a new background-dispatch subagent tool, **rebased on Pi's bundled `examples/extensions/subagent`** (full message-stream capture, usage accounting, SIGTERM abort handling). The old `extensions/task/index.ts` is deleted.
- **Dispatch-and-return in interactive mode**: the tool spawns detached child processes and returns a short acknowledgement immediately. The parent stays interactive (Feature 1). In non-interactive modes (`json`/`print`/`rpc`, e.g. direct `pi -p` use and the e2e suite) the tool **falls back to blocking execution** and returns aggregated results as the tool result — print mode exits when the turn ends, so background dispatch there would orphan children.
- **No nested delegation**: children are spawned with `SWIFT_PI_SUBAGENT=1`; when set, the extension registers nothing and the system prompt omits delegation guidance, so subagents cannot even see the tool.
- An in-memory **registry** tracks each agent's status and full message log, derived from the child's JSON event stream (which includes `message_start`/`tool_execution_start`, enabling precise thinking/working states).
- An **indicator line** below the prompt (`ctx.ui.setWidget`, `placement: "belowEditor"`) shows a colored, two-symbol indicator per agent plus the parent, updated live (Feature 2).
- **Hotkeys** (`pi.registerShortcut`) move a selector across indicators, open the selected agent in a full **session-replay overlay** (`ctx.ui.custom`), and **abort** the selected in-flight agent (Features 2 & 3).
- On completion, each agent's result is **auto-delivered** to the parent as a custom follow-up message (`pi.sendMessage`, always `deliverAs: "followUp"`, compact custom rendering) — no operator acknowledgement required, no idle/busy branching.
- Terminal agent records **persist as session entries** (`pi.appendEntry`: dispatch + completion) and are restored from `ctx.sessionManager.getEntries()` on `session_start`, so completed-agent history survives reloads and session switches; dispatch entries without completions restore as aborted.

## Capabilities

### New Capabilities

- `subagents`: Delegation of work to isolated **background** subagent processes that run concurrently with the parent, with live status tracking, an interactive indicator/traversal UI, on-demand session replay, automatic result delivery, and crash-safe lifecycle management across reloads and session switches.

### Modified Capabilities

_(None — no prior spec exists. The `task` tool being removed had no spec.)_

## Impact

- **Code:** delete `extensions/task/index.ts`; add `extensions/subagents/` (entry + supporting modules); update `package.json` `pi.extensions`; update harness system-prompt guidelines (`extensions/system-prompt.ts:22` mentions `task/subagent`, and the delegation line becomes conditional on `SWIFT_PI_SUBAGENT`); update `scripts/smoke.mjs` (stub `registerShortcut`/`registerMessageRenderer`/`sendMessage`/`appendEntry`, replace `extensions/task/index.ts` path references, rename the required tool).
- **Dependencies:** none new — uses only existing Pi extension + TUI APIs.
- **Behavior / contract:** in interactive mode the subagent tool returns a **dispatch ack** rather than final results; results arrive later as **follow-up turns** (custom messages). The system prompt must teach this contract. Subagents are **not** auto-aborted on parent interrupt (they are detached); abort is explicit via a hotkey on the selected indicator. Subagents themselves have **no delegation tool** (nesting removed — previously possible with `task`).
- **Compatibility:** any prompt/skill/reference to the `task` tool must move to the new tool. The e2e fixtures embed the tool list in recorded request payloads, so renaming the tool requires a fixture refresh (`session-to-fixture.mjs`).
