# Tools and commands

This package registers Pi tools and commands through the extension entry points listed in `package.json`.

## System prompt

`extensions/system-prompt.ts` registers a `before_agent_start` handler. The handler returns a compact system prompt that defines coding-agent authority, safety, default execution, tool routing, and workflow guidance.

## Bash tool policy

`extensions/tool-policy.ts` registers a `tool_call` handler for bash calls. It blocks commands that match configured policy checks.

Blocked command words include:

- `cat`, `head`, `tail`, `less`, `more`
- `ls`
- `grep`, `rg`, `ripgrep`, `ag`, `ack`
- `find`, `fd`, `locate`
- `awk`, `sed`

Additional blocked shell patterns include:

- piping through `head` or `tail`
- redirecting stderr with `2>&1` or `2>/dev/null`
- using `sed -n` for line ranges

## `search`

Defined in `extensions/search.ts`.

Purpose: regex content search across files, directories, and globs.

Parameters:

- `pattern`: JavaScript regular expression string.
- `paths`: optional file, directory, glob, or array of those values. Defaults to `.`.
- `i`: optional case-insensitive flag.
- `context`: optional surrounding line count.
- `maxResults`: optional cap for emitted matching lines.
- `skip`: optional matching-file window offset.
- `gitignore`: optional `.gitignore` handling flag. Defaults to respecting `.gitignore`.

Runtime bounds in the implementation include:

- file window cap
- per-file match cap
- global match cap
- maximum file size
- output byte cap
- long-line truncation
- search timeout
- default ignores for `.git/`, `node_modules/`, `.pi/`, and `.omp/`

## `ast_grep`

Defined in `extensions/ast-tools.ts`.

Purpose: structural search using the local `@ast-grep/cli` binary.

Parameters:

- `pat`: ast-grep pattern.
- `paths`: files, directories, or globs.
- `lang`: optional ast-grep language.
- `skip`: optional match offset in the compact JSON output.

The extension invokes the local `node_modules/.bin/sg` executable through `pi.exec`.

## `ast_edit`

Defined in `extensions/ast-tools.ts`.

Purpose: structural rewrite using ast-grep rewrite patterns.

Parameters:

- `ops`: ordered rewrite operations with `pat` and `out`.
- `paths`: files, directories, or globs.
- `lang`: optional ast-grep language.

The tool runs rewrite operations sequentially with ast-grep's update mode.

## `todo_write`

Defined in `extensions/todo-write.ts`.

Purpose: in-memory phased task tracking for multi-step agent work.

Supported operations:

- `init`
- `start`
- `done`
- `drop`
- `rm`
- `append`
- `note`

The tool renders phases, task statuses, notes, and remaining task count. State is stored in module memory for the running extension process.

## `ask`

Defined in `extensions/ask.ts`.

Purpose: structured clarification questions with selectable options.

Parameters:

- `questions`: array of questions.
- Each question has `id`, `question`, `options`, optional `multi`, and optional `recommended`.

When UI is unavailable, the implementation falls back to the recommended option or the first option.

## `web_search`

Defined in `extensions/web-search.ts`.

Purpose: provider-backed web search.

Supported provider environment variables:

- `BRAVE_API_KEY`
- `TAVILY_API_KEY`
- `KAGI_API_KEY`

The provider order is Brave, Tavily, then Kagi. The first provider returning results supplies the tool response. If no provider key is configured, the tool returns a message explaining that no web search provider is configured.

Parameters:

- `query`
- optional `recency`: `day`, `week`, `month`, or `year`
- optional `limit`, clamped to the implementation's range

## `task`

Defined in `extensions/task/index.ts`.

Purpose: start one or more background sub-agents in isolated child Pi processes.

Parameters:

- `agent`: agent kind string.
- `tasks`: array of task objects with `id`, `description`, and `assignment`.
- `context`: optional shared context prepended to each assignment.

Built-in agent prompt names in the implementation are:

- `explore`
- `plan`
- `designer`
- `reviewer`
- `librarian`
- `oracle`
- `task`
- `quick_task`

The task tool returns immediately after launching the background batch. Results are delivered later as a follow-up Pi message with custom type `subagent-results`.

Runtime bounds are controlled by environment-backed constants for concurrency, output bytes, output lines, inline result bytes/lines, runtime, kill grace, and JSON event size.

## `context` command

Defined in `extensions/context.ts`.

Purpose: compute and display context-usage details.

The command sends a custom message with type `context-usage`. The extension also registers a renderer for that message type.

The breakdown includes:

- model metadata
- context window
- system prompt tokens
- system tools tokens
- system context file tokens
- skills tokens
- message tokens
- auto-compact buffer tokens
- free tokens
