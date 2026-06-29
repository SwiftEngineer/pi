# Architecture

`@swiftengineer/pi-harness` is a private ESM package that extends Pi with additional tools, prompt policy, TUI components, patch scripts, and a theme.

## Package composition

`package.json` is the package-level composition point. Its `pi.extensions` array loads these extension entry points in order:

1. `extensions/system-prompt.ts`
2. `extensions/tool-policy.ts`
3. `extensions/search.ts`
4. `extensions/ast-tools.ts`
5. `extensions/todo-write.ts`
6. `extensions/ask.ts`
7. `extensions/web-search.ts`
8. `extensions/context.ts`
9. `extensions/tui-powerline.ts`
10. `extensions/task/index.ts`
11. `extensions/subagent-view/index.ts`

`package.json` also registers package directories for skills, prompts, and themes:

- `skills/`
- `prompts/`
- `themes/`

## Runtime extension model

Most extension files export a default function that receives Pi's `ExtensionAPI` and registers tools, events, renderers, shortcuts, or commands.

The main patterns are:

- Tool extensions call `pi.registerTool`.
- UI/runtime extensions subscribe to Pi events with `pi.on`.
- The context extension registers a command and a custom message renderer.
- The powerline extension installs a footer component during TUI sessions.
- The task extension starts background child Pi processes and reports results through Pi messages.

## Directory layout

- `extensions/` contains Pi extensions and shared extension modules.
- `extensions/subagent-view/` contains the sub-agent pager and transcript rendering implementation.
- `extensions/settings/` contains the reusable `TabBar` component used by settings UI code and smoke tests.
- `scripts/` contains smoke testing, postinstall checks, and patch scripts for installed Pi package files.
- `themes/titanium.json` contains the titanium theme.
- `install.sh` and `update.sh` install dependencies, install Pi globally, apply patches, and run `pi install` for this harness.

## TypeScript configuration

`tsconfig.json` targets modern Node ESM:

- `target`: `ES2024`
- `module`: `NodeNext`
- `moduleResolution`: `NodeNext`
- `allowImportingTsExtensions`: `true`
- `noEmit`: `true`

Strictness settings include:

- `strict`
- `noImplicitAny`
- `exactOptionalPropertyTypes`
- `noUncheckedIndexedAccess`

The TypeScript include pattern is `extensions/**/*.ts`.

## Core subsystems

### Prompt and policy

`extensions/system-prompt.ts` injects the compact staff-level coding-agent prompt before agent start.

`extensions/tool-policy.ts` listens for bash tool calls and blocks shell commands that overlap with dedicated Pi tools, including common file viewing/search/listing commands and stderr/truncation patterns.

### Tooling extensions

Tooling extensions provide search, AST operations, todo tracking, structured user questions, web search, and background task/sub-agent execution. Their current tool contracts are documented in [Tools and commands](tools.md).

### Context and TUI extensions

`extensions/context.ts` computes and renders context-usage breakdowns. `extensions/tui-powerline.ts` renders the footer. `extensions/subagent-view/` renders sub-agent progress and transcripts. These are documented in [TUI and sub-agents](ui-and-subagents.md).

### Install and patch scripts

Install/update scripts and patch scripts operate outside the Pi extension API. They are documented in [Installation, update, and patching](install-update.md).
