# Verification and developer workflow

The repository currently uses TypeScript checking and a custom smoke harness for verification.

## npm scripts

`package.json` defines these scripts:

- `npm run check`: runs `tsc --noEmit`
- `npm run smoke`: runs `node scripts/smoke.mjs`
- `npm run postinstall`: runs `node scripts/postinstall.mjs`

There is no separate `test` script in `package.json`.

## TypeScript check

`npm run check` type-checks files included by `tsconfig.json`.

The TypeScript include pattern is:

```json
["extensions/**/*.ts"]
```

The `.mjs` files in `scripts/` are executed by Node and are not part of the TypeScript include pattern.

## Smoke harness

`scripts/smoke.mjs` is the repository's custom integration harness. It uses `jiti` to import TypeScript extensions and registers a fake Pi API surface with maps for tools, commands, renderers, shortcuts, sent messages, and event handlers.

The smoke harness covers these current behaviors:

- extension loading
- tool registration
- `search` basic matching
- `search` long-line truncation
- background `task` execution with a fake Pi command
- `todo_write`
- `ask` fallback behavior
- `ast_grep`
- `web_search` no-provider behavior
- titanium theme loading
- powerline footer rendering
- context command and `context-usage` renderer
- settings `TabBar`
- settings patch behavior
- TUI split patch behavior
- native scrollback patch behavior
- sub-agent registry, view state, strip, frame, and transcript behavior

At completion, the smoke harness prints registered tools and registered handlers.

## Installed package checks

`install.sh` and `update.sh` run dependency installation, global Pi installation, patch scripts, and `pi install`. They do not run `npm run check` or `npm run smoke` as part of their current command sequence.

## Repository ignore rules

`.gitignore` excludes dependency directories, build/test outputs, package archives, logs, environment files, Pi runtime state, OS/editor noise, and temporary directories. It allows sample environment files such as `.env.example` and `.env.sample`.

## Current tracked documentation entry points

The repository root contains:

- `README.md`
- `AGENTS.md`
- `REVIEW_SUGGESTIONS.md`
- `docs/`
