# Installation, update, and patching

This repository includes shell entry points for installing and updating the harness with a global Pi package.

## Runtime requirements

`package.json` declares:

- Node engine: `>=22.19.0`
- package type: ESM

`install.sh` checks for these commands before proceeding:

- `node`
- `npm`
- `git`

`install.sh` also checks the Node version at runtime.

## Dependencies

Direct dependencies in `package.json` are:

- `@ast-grep/cli`
- `glob`
- `ignore`

Peer dependencies are:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Development dependencies pin the Pi packages at version `0.80.2`.

## `install.sh`

`install.sh` performs these steps from the repository root:

1. Checks required commands.
2. Checks Node version.
3. Runs `npm install`.
4. Installs the global Pi package with `npm install -g --ignore-scripts`.
5. Runs the settings patch script.
6. Runs the startup resource display patch script.
7. Runs the TUI split patch script.
8. Runs the native scrollback patch script.
9. Refreshes the shell command hash table with `hash -r`.
10. Checks that `pi` is available.
11. Runs `pi install "$ROOT"`.

The global Pi package defaults to `@earendil-works/pi-coding-agent@0.80.2`. The `PI_PACKAGE` environment variable overrides that value.

## `update.sh`

`update.sh` performs these steps from the repository root:

1. If the repository has a configured upstream, runs `git pull --ff-only`.
2. Runs `npm install`.
3. Installs the global Pi package with `npm install -g --ignore-scripts`.
4. Runs the settings patch script.
5. Runs the startup resource display patch script.
6. Runs the TUI split patch script.
7. Runs the native scrollback patch script.
8. Refreshes the shell command hash table with `hash -r`.
9. Runs `pi install "$ROOT"`.

The global Pi package defaults to `@earendil-works/pi-coding-agent@0.80.2`. The `PI_PACKAGE` environment variable overrides that value.

## Postinstall check

`scripts/postinstall.mjs` checks whether the local ast-grep executable exists at `node_modules/.bin/sg` or `node_modules/.bin/sg.cmd` on Windows. If it is absent, the script prints a warning that AST tools will fail until dependencies are installed.

## Patch scripts

Patch scripts read installed Pi package files, apply text transformations, and write the patched files back.

### `scripts/patch-pi-settings.mjs`

Patches the installed Pi settings selector. It adds tabbed settings behavior and provider settings entries for transport and HTTP idle timeout when needed.

Target resolution uses:

- `PI_CODING_AGENT_DIR` when set
- otherwise the global npm root joined with `@earendil-works/pi-coding-agent`

### `scripts/patch-pi-startup-resources.mjs`

Patches Pi's interactive startup resource listing to hide the `[Skills]`, `[Extensions]`, and `[Themes]` sections while leaving those resources loaded.

Target resolution uses:

- `PI_CODING_AGENT_DIR` when set
- otherwise the global npm root joined with `@earendil-works/pi-coding-agent`

### `scripts/patch-pi-tui-split.mjs`

Patches Pi TUI rendering to add a frame hook used by the sub-agent split view.

The patch installs:

- `globalThis.__piSplitFrame` call site support
- `globalThis.__PI_SPLIT_PATCH__ = true`

Target resolution uses:

- `PI_TUI_DIST` when set
- otherwise candidate paths under the Pi coding-agent package and global Pi TUI package

This script supports `--revert`.

### `scripts/patch-pi-scrollback.mjs`

Backports native scrollback behavior into the installed Pi package. It patches TUI rendering, tool execution rendering, and interactive-mode transcript behavior, and writes transcript container files into the target package.

Target resolution uses the global npm root and `PI_CODING_AGENT_DIR` when provided.

## Environment variables used by runtime code and scripts

Install/update and patching:

- `PI_PACKAGE`
- `PI_GLOBAL_NODE_MODULES`
- `PI_CODING_AGENT_DIR`
- `PI_TUI_DIST`

Task/sub-agent runtime:

- `SWIFT_PI_COMMAND`
- `PI_TASK_MAX_CONCURRENCY`
- `PI_TASK_MAX_OUTPUT_BYTES`
- `PI_TASK_MAX_OUTPUT_LINES`
- `PI_TASK_INLINE_RESULT_BYTES`
- `PI_TASK_INLINE_RESULT_LINES`
- `PI_TASK_MAX_RUNTIME_MS`
- `PI_TASK_KILL_GRACE_MS`
- `PI_TASK_MAX_JSON_EVENT_BYTES`

Web search providers:

- `BRAVE_API_KEY`
- `TAVILY_API_KEY`
- `KAGI_API_KEY`

TUI behavior:

- `PI_ASCII`
