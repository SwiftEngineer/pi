# Installation, update, and patching

This repository includes shell entry points for installing and updating the harness. The install and update scripts fetch and run the `pi_agent_rust` installer, which installs the `pi` binary (a Rust release build) and registers this harness package with it.

## Runtime requirements

`package.json` declares:

- Node engine: `>=22.19.0`
- package type: ESM

`install.sh` checks for these commands before proceeding:

- `node`
- `npm`
- `git`
- `curl`

`install.sh` also checks the Node version at runtime (`>=22.19.0`). `curl` is required because the scripts fetch the `pi_agent_rust` installer over HTTPS.

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

1. Checks required commands (`node`, `npm`, `git`, `curl`).
2. Checks Node version (`>=22.19.0`).
3. Runs `npm install` to install this harness package's dependencies (including `@ast-grep/cli`).
4. Installs the `pi` binary by fetching and running the `pi_agent_rust` installer:

   ```sh
   curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/pi_agent_rust/main/install.sh?$( date +%s )" | bash
   ```

   with `YES=1` and `NO_GUM=1` exported by default. The `pi_agent_rust` installer migrates any pre-existing TypeScript Pi installation (aliasing the old binary `legacy-pi`) and is idempotent, so re-running it is safe.
5. Refreshes the shell command hash table with `hash -r`.
6. Checks that `pi` is available.
7. Registers this harness package with `pi`, trying `pi install "$ROOT"` first and falling back to `pi install -l "$ROOT"` if that fails.
8. Prints the success message.

The four `scripts/patch-pi-*.mjs` scripts are intentionally not run here (see [Patch scripts](#patch-scripts)).

## `update.sh`

`update.sh` performs these steps from the repository root:

1. If the repository has a configured upstream, runs `git pull --ff-only`.
2. Runs `npm install` to refresh this harness package's dependencies.
3. Re-runs the `pi_agent_rust` installer (the same `curl … | bash` one-liner as `install.sh`). Because the installer is idempotent, this doubles as a `pi` binary upgrade.
4. Refreshes the shell command hash table with `hash -r`.
5. Registers this harness package with `pi`, trying `pi install "$ROOT"` first and falling back to `pi install -l "$ROOT"` if that fails.
6. Prints the success message.

The four `scripts/patch-pi-*.mjs` scripts are intentionally not run here (see [Patch scripts](#patch-scripts)).

## Postinstall check

`scripts/postinstall.mjs` checks whether the local ast-grep executable exists at `node_modules/.bin/sg` or `node_modules/.bin/sg.cmd` on Windows. If it is absent, the script prints a warning that AST tools will fail until dependencies are installed.

## Patch scripts

> **Note.** These patch scripts are **no longer invoked by `install.sh` or `update.sh`**. They mutate the compiled `dist/` output of the Node Pi host (`@earendil-works/pi-coding-agent` / `pi-tui`), which the `pi` Rust binary installed by the current scripts does not ship; running them against the Rust binary throws because their anchor strings are not found. The `.mjs` files are kept on disk for the legacy/dual-target Node flow (see [Migration hand-off](migration-to-pi-agent-rust.md)). The descriptions below apply only to the Node Pi host, not the Rust `pi` binary.

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

- `PI_GLOBAL_NODE_MODULES`
- `PI_CODING_AGENT_DIR`
- `PI_TUI_DIST`

The install/update scripts pass their environment through to the `pi_agent_rust` installer. `YES` and `NO_GUM` default to `1` (overridable); `VERSION` and `DEST`, if set, are also honored by the installer.

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
