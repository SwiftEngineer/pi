# PiJS Port — Adapter Notes (vertical slice)

These notes accompany the first ported slice: `pijs/tool-policy.ts` and
`pijs/search.ts`, adapted from `extensions/tool-policy.ts` and
`extensions/search.ts` to run under the [pi_agent_rust](https://github.com/Dicklesworthstone/pi_agent_rust)
QuickJS extension runtime ("PiJS") instead of the Node.js Pi host.

The `pijs/` directory is deliberately kept **separate** from `extensions/` so
the Node-targeted and Rust-targeted versions coexist and can be diffed.

## What was verified

Two parallel research passes grounded every API claim in primary source:

1. The canonical pi-mono reference extensions
   (`permission-gate.ts`, `hello.ts`, `todo.ts`, `dynamic-tools.ts`,
   `structured-output.ts`, `pirate.ts`, `tic-tac-toe.ts`, `commands.ts`) plus
   `packages/coding-agent/docs/extensions.md`.
2. The pi_agent_rust runtime itself: `docs/ext-compat.md`,
   `docs/extension-architecture.md`, `docs/capability-prompts.md`,
   `docs/wit/extension.wit`, and the 30k-line `src/extensions_js.rs` /
   `src/extensions.rs` (downloaded and searched locally).

The two sources **agree** on the API surface used by this slice.

Additionally, the ported files were checked locally:

- `npx tsc -p pijs/tsconfig.check.json` passes under `strict` (node 24, tsc 5.9.3).
- The from-scratch glob + gitignore reimplementations were exercised against
  this repository (`/tmp/pijs-glob-test.mjs`, 18 assertions): directory walks
  prune `node_modules/` and `.git/`, glob patterns (`pijs/*.ts`, `**/*.ts`)
  resolve correctly at top level and nested, single-file inputs pass through,
  and gitignore semantics (directory-only, negation, basename-anywhere, the
  literal-file-vs-dir edge case) behave correctly.

## The confirmed PiJS API surface (what this slice relies on)

Registration — exactly as in the Node host:

```js
pi.registerTool({ name, label?, description, parameters, execute });
pi.on(eventName, async (event, ctx) => ({ /* optional decision */ }));
```

- The tool spec fields **read by the Rust host** are `name`, `execute` (both
  required), and `description` / `label` / `parameters` (optional). The host
  does **not** read `promptSnippet`, `promptGuidelines`, or `executionMode`
  (verified by searching `extensions_js.rs` `__pi_register_tool`), so those
  are omitted from the port. (`label` is read; `promptSnippet`/`guidelines`
  are a Node-host-only prompt-injection mechanism — see Open Questions.)
- `execute` is invoked as `execute(toolCallId, input, undefined, undefined, ctx)`:
  the third and fourth arguments (`signal`, `onUpdate`) are **always
  `undefined`** in this runtime. The port keeps the five-arg signature for
  parity but treats `signal`/`onUpdate` as unused.
- `parameters` is validated as JSON Schema (only `type` / `properties` /
  `required` are inspected). Plain JSON Schema objects are used instead of
  typebox `Type.Object`.
- Return shape: `{ content: [{ type: "text", text }], details: {...} }` — same
  as the Node host.

Events — `pi.on("tool_call", handler)`. The `tool_call` event is emitted with
`{ toolName, toolCallId, input }` and a handler may return
`{ block: true, reason }` to abort the call (early-stop semantics in
`__pi_dispatch_event_inner`; a thrown error propagates rather than being
swallowed). Returning `undefined` lets the call proceed. This is exactly the
shape `tool-policy.ts` already used.

## Per-file deltas

### `tool-policy.ts` — near 1:1 port

Pure string/regex logic (`BLOCKED_COMMAND_WORDS`, `shellWords`, `basename`,
`bashViolation`) is unchanged. The only change is dropping the
`@earendil-works/pi-coding-agent` type import; the `pi` argument is
duck-typed. The event name (`tool_call`) and the `{ block: true, reason }`
return shape are confirmed identical.

### `search.ts` — three structural adaptations

1. **Dependencies removed.** `glob` and `ignore` are npm packages that do not
   function in the QuickJS sandbox (`glob` is a virtual stub; `ignore` is not
   stubbed at all — Tier-4 extensions pass only 33% of the conformance corpus).
   Both are reimplemented in pure JS using only `node:fs`, `node:path`, and
   `node:buffer` (all fully supported per the hostcall matrix). The
   reimplementation handles the shapes this tool actually receives: a file
   path, a directory path, and a glob with `*` / `**` / `?`; plus a practical
   gitignore subset (comments, `!` negation, leading-`/` anchoring, trailing-`/`
   directory-only, `*`/`**`/`?` wildcards, no-slash basename-anywhere matching).
2. **Schema.** Plain JSON Schema object instead of typebox.
3. **Cancellation.** The original wires `AbortController` + `setTimeout` to an
   abort `signal` and stops early when the host aborts. In this runtime
   `signal` is always `undefined` and QuickJS has no Node event loop, so that
   machinery is inert. Timeout is enforced by the inline `Date.now() > deadline`
   check (runtime-agnostic and already present). Hard cancellation (e.g. an
   over-running search) is the host's responsibility via the
   `ExtensionRegion` structured-concurrency budget.

   The behavior-defining bounded-output logic — `truncateLine`, `utf8Head`,
   `lineRanges`, `formatBytes`, the per-file / global / inline-byte caps, and
   the notice messages — is ported verbatim.

`cwd` is resolved inside `execute` from `ctx.cwd` when present, otherwise from
the native `pi.process.cwd()` hostcall (confirmed exposed). Both reflect the
session working directory; preferring the context value and falling back to the
native call is legitimate runtime adaptation, not error suppression.

## Open questions / assumptions to verify under a real `pi` binary

These could not be closed from docs/source alone and should be confirmed by
loading the files into an actual pi_agent_rust build:

1. **`promptSnippet` / `promptGuidelines` loss.** The Node host uses these to
   inject per-tool guidance into the system prompt. The Rust host does not read
   them at registration. Confirm whether the Rust host exposes another hook for
   per-tool prompt guidance; if not, the guidance text in these tools' original
   `promptGuidelines` arrays is simply not surfaced (no functional break, but
   the model loses the nudges).
2. **Extension discovery / loading.** Confirm how a `pijs/*.ts` entry point is
   registered with the Rust binary — e.g. an `extension.json` manifest, a
   `pi.extensions`-equivalent config field, or a `--extension <path>` CLI flag
   (the legacy runner exposes `--extension <path>` and auto-discovery via
   `~/.pi/agent/extensions/`). A minimal `extension.json` may be required.
3. **`ctx` shape at execution time.** The port assumes `ctx.cwd` exists (with
   `pi.process.cwd()` as a fallback). Confirm the fields
   `__pi_make_extension_ctx` actually populates, and whether `cwd` is among
   them, so the fallback is exercised as a fallback rather than the primary
   path.
4. **Capability policy.** `search` needs `read`; `tool-policy` is event-only
   (`tool_call`). Both are auto-allowed in the default `Standard` profile, so
   no capability grant should be required — but confirm no prompt is raised on
   first use.
5. **`node:buffer` global vs. import.** The port imports
   `import { Buffer } from "node:buffer"` explicitly. Confirm the shim exposes
   the named export (the matrix lists the module as supported; the explicit
   import is the safe form either way).

## Verification path (the actual de-risk step)

```sh
# 1. Build pi_agent_rust per its README.
# 2. Load each extension in isolation:
pi --extension pijs/tool-policy.ts   # then run a bash tool call that should be blocked
pi --extension pijs/search.ts        # then invoke the `search` tool with a real pattern/paths
# 3. Diff output of the PiJS `search` against the Node `search` over the same
#    repo + pattern to confirm result parity (modulo ordering of Set iteration).
```

The port is deliberately conservative: no new behavior, no stubs, no suppressed
errors — only the minimal adaptations the runtime forces.
