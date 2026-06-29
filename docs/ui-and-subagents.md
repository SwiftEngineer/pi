# TUI and sub-agents

This package adds TUI footer, context, settings-tab, and sub-agent display behavior.

## Powerline footer

Defined in `extensions/tui-powerline.ts`.

The footer component renders a powerline-style status line during TUI sessions. It derives content from the current extension context, footer data provider, and latest thinking level.

Segments include:

- Pi logo
- model name
- reasoning effort
- current directory
- git branch when available
- context token usage
- context percentage
- optional session badge aligned to the right

The component also renders extension status text on a second line when the footer data provider reports statuses.

## Context usage view

Defined in `extensions/context.ts`.

The context command computes a token breakdown and sends a `context-usage` custom message. The renderer displays a grid and legend in TUI mode, with a plain text rendering path for non-TUI output.

Categories in the context breakdown are:

- system prompt
- system tools
- system context
- skills
- messages

The computation uses provider context usage when available and local estimates for prompt, tool schema, skills, context files, and messages.

## Settings tab bar

Defined in `extensions/settings/tab-bar.ts`.

`TabBar` is a reusable terminal component with:

- full and compact tab labels
- muted tabs
- keyboard navigation with Tab, Shift+Tab, Right, and Left
- mouse hit zones recorded during render
- active-tab callbacks
- width-aware rendering and label collapsing

The settings patch script embeds tabbed settings behavior into the installed Pi settings selector.

## Sub-agent task flow

`extensions/task/index.ts` starts sub-agents as child `pi --mode json` processes. It parses JSON event lines from child stdout, extracts assistant message completions, and streams live updates into the shared sub-agent registry.

The task extension sends final results with a Pi follow-up message using custom type `subagent-results`.

## Sub-agent registry

Defined in `extensions/subagent-view/registry.ts`.

The registry tracks each sub-agent's:

- id
- label
- agent kind
- lifecycle state: `pending`, `running`, `done`, or `error`
- phase
- active tool name
- live text tail
- live thinking tail
- finalized transcript blocks
- final result text
- exit information
- start and finish timestamps

The registry is stored as a process-wide singleton so the task producer and the TUI consumer share the same state.

## Transcript rendering

Defined in `extensions/subagent-view/transcript.ts` and `scrollback.ts`.

Finalized child-agent messages are converted into transcript blocks. Rendering code wraps text for the terminal width and strips terminal control sequences from transcript content before display.

`scrollback.ts` provides scroll state, wrapped buffers, top/bottom resolution, and frame composition helpers.

## Sub-agent view state

Defined in `extensions/subagent-view/view-state.ts`.

`SubagentViewState` tracks:

- selected channel
- pager focus
- spinner frame
- per-channel scroll state
- per-channel wrapped buffers
- seen revisions
- unread output markers
- latest rendered viewport geometry

The main channel is `main`; sub-agent channels follow registry insertion order.

## Split-frame and overlay modes

Defined in `extensions/subagent-view/index.ts` and `frame.ts`.

When the Pi TUI split patch is present, the extension installs a `globalThis.__piSplitFrame` hook. The hook composes a reserved layout containing:

- active transcript window
- pinned editor/footer chrome
- pinned sub-agent status strip

When the split patch is not present, the extension uses an overlay fallback that shows only the bottom status strip.

## Sub-agent shortcuts

The sub-agent view registers these shortcuts when shortcut registration is available:

- `alt+]`: next channel
- `alt+[`: previous channel
- `alt+s`: next channel alias
- `alt+a`: previous channel alias
- `alt+0`: main channel
- `alt+1` through `alt+9`: numbered sub-agent channels
- `alt+\\`: focus pager scrolling
- `alt+l`: follow latest/live output

When the pager is focused, terminal input handles scrolling keys including Up, Down, PageUp, PageDown, Home, End, `g`, `G`, and Escape.

## Status strip

Defined in `extensions/subagent-view/strip.ts`.

The status strip renders one or two rows with:

- main/sub-agent channel glyphs
- selected channel name and position
- selected channel status
- spinner for active selected channels
- scroll/live indicator
- controls hint line when there is space

The strip supports ASCII glyphs when `PI_ASCII=1` or when locale detection indicates a non-UTF-8 terminal.
