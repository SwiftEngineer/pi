# SwiftEngineer Pi Distribution

A custom distribution of the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). One command installs a pinned, known-good `pi` and registers a curated set of packages:

| Package | What it adds |
| --- | --- |
| **`@swiftengineer/pi-harness`** _(this repo)_ | The default agent harness: compact system prompt, tool policy, task/subagents, `search`, `ls`/`find`, AST tools, `todo_write`, `ask`, last-used-model defaults, and Z.ai tool-schema compatibility. |
| **[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)** | Access every MCP server through a single ~200-token proxy tool, with lazy connections and idle disconnect — instead of paying 10k+ tokens per server. |
| **[`pi-web-access`](https://github.com/nicobailon/pi-web-access)** | Web search and content extraction: `web_search` (OpenAI/Brave/Parallel/Tavily/Exa/Perplexity/Gemini with fallback chains), `fetch_content` (URLs, GitHub repos, YouTube, PDFs), `get_search_content`. |
| **[`pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer)** | Powerline-style segmented footer for the Pi TUI: cwd/branch, context %, tokens/cost, model • thinking • provider. |
| **[`pi-hashline-edit-pro`](https://github.com/YuGiMob/pi-hashline-edit-pro)** | Hash-anchored `read`/`edit`: content hashes replace line numbers, so edits land on the right line every time — stale or unseen ranges are hard-rejected with fresh anchors, old text is never re-typed, and same-file edits batch atomically. |
| **[`pi-automode`](https://github.com/czottmann/pi-automode)** | Claude Code-style auto mode guardrail: intercepts agent tool calls before execution and blocks unsafe actions via permission deny rules, deterministic hard-deny checks, and a conservative classifier. |

## Install

Runs the same on **macOS, Linux, and Windows** (Node is a Pi prerequisite, so `npx` is always available):

```sh
npx -y git+ssh://git@github.com/SwiftEngineer/pi.git
```

This repo is **private**, so the one-liner installs over SSH. It works on any machine where your GitHub SSH key (with access to `SwiftEngineer/pi`) is set up — verify with `ssh -T git@github.com`.

What it does, in order:

1. Installs the pinned Pi coding agent globally (`@earendil-works/pi-coding-agent@0.84.4`), replacing any stale/faulty `pi` on your PATH.
2. Registers the harness and the plugins via `pi install`.
3. Configures `pi-web-access` to run headless: forces `"workflow": "none"` and `"autoOpenBrowser": false` in `~/.pi/web-search.json` (respecting `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME`). Existing config keys are preserved, so re-running the installer never wipes your provider keys. Without this, every `web_search` opens an interactive curator page in your browser and waits for manual approval.

### Prerequisites

- **Node.js ≥ 22.19.0** (bundles `npm` and `npx`)
- **git**
- A **GitHub SSH key** with access to `SwiftEngineer/pi`

### From a local checkout

If you've cloned the repo (e.g. to hack on the harness), install *this working copy* instead of the published one:

```sh
git clone ssh://git@github.com/SwiftEngineer/pi.git
cd pi
./install.sh            # macOS / Linux
# .\install.ps1         # Windows PowerShell
# node scripts/bootstrap.mjs   # any OS
```

The source install sets the harness source to your local path, so your edits are what get registered.

## After installing

```sh
export ANTHROPIC_API_KEY=...   # or GEMINI_API_KEY, etc.
pi                             # start the agent
```

Then configure MCP servers from inside Pi:

```
/mcp setup        # guided setup
/mcp              # interactive panel
mcp({ search: "screenshot" })   # discover a tool
```

The adapter reads standard MCP config from `~/.config/mcp/mcp.json`, `.mcp.json`, and Pi's own `mcp.json` overrides.

Web access (`web_search` / `fetch_content`) works out of the box via a keyless Exa fallback. For the stronger providers, set any of `OPENAI_API_KEY`, `BRAVE_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, or `PARALLEL_API_KEY` — or put keys in `~/.pi/web-search.json`.

The installer configures `pi-web-access` headless, so searches return raw results without opening the browser curator. If you want the interactive review flow back (or want to toggle it per-session), run `/curator on` inside Pi — and note that re-running the installer will force headless mode again.

## Updating

```sh
pi update --extensions
```

This pulls the latest for every remote-installed package (harness + plugins) while leaving `pi` itself on the pinned version. Avoid `pi update --all` — it also updates `pi`, bypassing the pin. To upgrade `pi`, bump `"pi"` in `distribution.json` to a known-good version and re-run the installer. From a checkout you can also run `./update.sh` (or `.\install.ps1` again on Windows) to refresh the pinned `pi` and re-register your local harness.

## Extending the distribution

The package set lives in [`distribution.json`](./distribution.json). Add an entry and re-run the installer:

```json
{
  "name": "some-pi-plugin",
  "role": "plugin",
  "source": "npm:some-pi-plugin"
}
```

`source` accepts anything `pi install` accepts: `npm:<pkg>`, `https://github.com/user/repo`, `ssh://git@github.com/user/repo`, or a local path.

### Environment overrides

| Variable | Effect |
| --- | --- |
| `PI_PACKAGE` | Override the pinned pi npm spec (default from `distribution.json`). |
| `PI_HARNESS_SOURCE` | Override where the harness is installed from (set automatically to the local path by `install.sh` / `install.ps1`). |

Pass `--dry-run` to `scripts/bootstrap.mjs` to print the install plan without changing anything.

## Uninstall

```sh
pi remove ssh://git@github.com/SwiftEngineer/pi
pi remove npm:pi-mcp-adapter
pi remove npm:pi-web-access
pi remove https://github.com/nicobailon/pi-powerline-footer
pi remove https://github.com/YuGiMob/pi-hashline-edit-pro
pi remove https://github.com/czottmann/pi-automode
npm uninstall -g @earendil-works/pi-coding-agent
```
