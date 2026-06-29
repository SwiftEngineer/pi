# Delegated review suggestions

This file tracks suggestions from the delegated codebase exploration. These items are kept outside `docs/` so the `docs/` directory remains a current-state reference.

## Review batch status

The delegated review batch reported `1/5 failed` in the harness output provided for synthesis.

Completed review areas:

- Architecture overview
- Interface/API review
- Tests/tooling review
- Security/performance/operations review

Timed out review area:

- Core logic review: exceeded `PI_TASK_MAX_RUNTIME_MS=600000` and was terminated.

## Significant suggestions

### Documentation and repository guide

- Add and maintain repository documentation for architecture, extension entry points, install/update behavior, environment variables, and patching behavior.
- Keep `AGENTS.md` short and link to detailed documentation.
- Keep review suggestions separate from current-state docs.

### Upstream patching

- Reduce reliance on global monkey-patching where possible.
- Add version/checksum checks for patched Pi files.
- Add backup, dry-run, status, and revert support for all patch scripts.
- Add patch verification against actual Pi package shapes in addition to synthetic smoke fixtures.
- Avoid duplicating `TabBar` logic between source code and the embedded settings patch string, or add a generation/update process.

### Tool policy and prompt alignment

- Align `tool-policy.ts`, `system-prompt.ts`, and the actually registered tools.
- Register a file-name lookup tool or make shell blocking aware of available active tools.
- Add policy exceptions or more precise parsing for legitimate commands that are currently matched by token policy.

### Task and sub-agent runtime

- Validate `task.agent` as an explicit enum.
- Validate task count, unique task IDs, non-empty descriptions, and non-empty assignments.
- Add task status and cancellation controls.
- Pass large or sensitive assignment/context content through stdin or a protected temp file instead of argv.
- Add assignment/context size limits.
- Add transcript and registry memory caps.
- Review detached child-process cleanup behavior after hard parent termination.
- Add debug-level lifecycle events for child start, timeout, abort, exit, and truncation.

### State scoping

- Scope or reset `todo_write` state per session when Pi runs multiple sessions in one extension host.
- Verify sub-agent registry behavior in long-lived and multi-session hosts.

### Network and provider behavior

- Add timeout and abort handling to `web-search.ts` provider requests.
- Cap provider error response bodies included in errors.
- Document outbound web-search privacy behavior.
- Add tests for provider success, failure, fallback order, and cancellation using mocked `fetch`.

### Search and AST tools

- Catch invalid regex patterns in `search.ts` and return a user-facing error.
- Address expensive regular-expression behavior on long lines or large file sets.
- Add output limits or windowing for `ast_grep` and `ast_edit` outputs.
- Add dry-run or preview behavior for mutating AST edits.

### TUI accessibility and diagnostics

- Add ASCII/plain fallback for powerline and Nerd Font glyphs.
- Strip ANSI/control characters from powerline session badge and extension status text.
- Surface split-frame/render-hook failures through debug logs or extension status instead of silent fallback only.
- Add status output for overlay fallback vs core split mode.

### Testing and CI

- Add CI running `npm ci`, `npm run check`, and `npm run smoke`.
- Introduce a test runner such as `node:test` or Vitest while keeping the smoke harness.
- Split `scripts/smoke.mjs` into named tests for tools, UI, sub-agent modules, context/powerline, task subprocess behavior, and patch scripts.
- Add coverage reporting after tests are decomposed.
- Type-check or convert critical `.mjs` scripts.
- Add tests for timeout, abort, output truncation, child failure, and malformed JSON in the task tool.
- Execute-test `ast_edit` in a temp fixture.

### Install/update workflow

- Add Node/tool preflight checks from `install.sh` to `update.sh`.
- Use reproducible installation commands in automated verification.
- Run or document verification after install/update.
- Document stale source maps after patching compiled upstream files.

### Dependency compatibility

- Replace wildcard Pi peer dependency ranges with known-compatible ranges.
- Document the Pi package versions validated with the patch scripts.
- Track dependency update policy for pinned dev dependencies and wildcard peer dependencies.

## Trivial suggestions

- Add `.node-version` or `.nvmrc` matching the supported Node version.
- Add `npm test` as an alias to the main verification command.
- Add a formatter and lint script.
- Add `noUnusedLocals` and `noUnusedParameters` when the codebase is ready for those checks.
- Print a clear final success line from `scripts/smoke.mjs`.
- Add `.env.example` listing supported environment variable names without values.
- Improve `postinstall` diagnostics for missing vs non-executable ast-grep.
- Mention arrow-key support in the `TabBar` hint.
- Remove small formatting noise such as the extra blank line before `commonArgs` in `extensions/ast-tools.ts`.
