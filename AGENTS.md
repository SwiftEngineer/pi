# AGENTS.md

Custom distribution of the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): the SwiftEngineer harness + `pi-mcp-adapter`, installed by one command.

## Layout

- `distribution.json` — source of truth: pinned pi version + package list.
- `scripts/bootstrap.mjs` — cross-OS installer (Node built-ins only).
- `extensions/` — the harness (registered via `package.json` `pi` field).
- `install.sh` / `install.ps1` / `update.sh` — thin wrappers over the bootstrap.

## Commands

- `npm run check` — typecheck (`tsc --noEmit`).
- `npm run smoke` — exercise the harness tools.
- `node scripts/bootstrap.mjs --dry-run` — print the install plan without changing anything.

## Conventions

- Keep `distribution.json` the single source of truth; add packages there, not in scripts.
- `bootstrap.mjs` stays dependency-free (Node built-ins only) so it runs on any OS.
