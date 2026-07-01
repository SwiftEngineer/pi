/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/ast-tools.ts. All pure logic — the `ast-grep run`
 * argument assembly (`commonArgs`), the compact-JSON post-processing
 * (`compactOutput`), and the per-op rewrite loop — ports 1:1. The adaptations
 * forced by the QuickJS / Rust-host runtime:
 *
 *  1. Schema: plain JSON Schema objects instead of typebox `Type.Object`. The
 *     host validates only `type`/`properties`/`required`; `description`/array
 *     `items`/nested `properties` survive as model hints only (§5.6), so the
 *     things that actually matter (`paths` is a non-empty string array; `ops`
 *     is a non-empty array of `{pat,out}`) are validated inside `execute`.
 *  2. Dropped fields: `promptSnippet`/`promptGuidelines`/`executionMode` (host
 *     ignores them) and the `@earendil-works/pi-coding-agent` type imports
 *     (`pi`/`ctx` are duck-typed).
 *  3. Subprocess execution goes through the native `pi.exec()` hostcall via
 *     `./_shared/exec.ts` (NOT `node:child_process`). The `pi.exec` result/option
 *     shape is unconfirmed (§9 #5) and isolated entirely to _shared/exec.ts.
 *  4. Cancellation: the host invokes `execute(id, params, undefined, undefined, ctx)`
 *     — `signal` is always undefined and there is no event loop, so the original
 *     `AbortSignal`/`ExecOptions.signal` plumbing is dropped. A wall-clock
 *     `timeout` is passed to exec; hard cancellation is the host's budget.
 *  5. `process.platform` (used by the original to pick `sg.cmd` on Windows) is
 *     gone — `process.env`/`process.platform` are empty in the sandbox (§9). The
 *     resolver probes concrete file paths via `fs.existsSync` instead.
 *
 * ── Binary resolution (the substantive port decision) ────────────────────────
 * The original computed `sgPath` from `import.meta.url` →
 * `<packageRoot>/node_modules/.bin/sg`. Two environment facts (probed live
 * against `pi 0.1.18`, see §7 Phase 3 / §9) shape the port:
 *
 *   • `import.meta.url` IS supported under the Rust runtime (returns
 *     `file:///…/pijs/ast-tools.ts`); `import.meta.dirname` is `undefined`. So
 *     the package root is recovered by walking up from the file URL's directory.
 *     `pi`/`ctx` expose NO package/extension-root field (probed: `pi` has no
 *     `root`/`dir`/`packageRoot`; `pi.process.cwd` is a string, not a function),
 *     and `ctx.cwd` is the USER's working dir (possibly a different repo), so it
 *     is NOT a reliable anchor for the package's own `node_modules`.
 *   • A bare `sg` on PATH is a TRAP: on this box `/usr/bin/sg` is shadow's
 *     set-group `sg`, NOT ast-grep, and `ast-grep` is not on PATH at all. The
 *     real binary is the package's own dependency
 *     `<packageRoot>/node_modules/@ast-grep/cli/{ast-grep,sg}` (and the
 *     `.bin/{ast-grep,sg}` symlinks), provided by `@ast-grep/cli@0.44.0` via the
 *     install step's `npm install`.
 *
 * Strategy (all lazy + cached inside `execute()`, never at load — `pi.exec`
 * hangs during activate(), §9 #5):
 *   1. Walk up from the import.meta.url directory; for each ancestor probe the
 *      four package-local candidate paths with `fs.existsSync` (sync, safe at any
 *      time). The first existing one wins — it is unambiguously ast-grep
 *      (`@ast-grep/cli`), so no `--version` check is needed and `pi.exec` is not
 *      touched during resolution in the common case.
 *   2. Fallback: try PATH names `ast-grep` then `sg`, but ACCEPT one only if
 *      `<name> --version` output contains "ast-grep" — this rejects shadow's
 *      `sg` (whose `--version` prints a `Usage:` line). This step uses `pi.exec`
 *      and therefore only runs inside `execute()`.
 *   3. Otherwise return a clear, actionable error rather than silently running
 *      the wrong binary.
 */

import fs from "node:fs";
import path from "node:path";
import { execCommand, type ExecResult } from "./_shared/exec.ts";

interface ProviderExec {
  exec: (command: string, args: string[], options?: unknown) => Promise<unknown>;
  registerTool: (spec: unknown) => void;
}

type AstGrepArgs = { pat?: unknown; paths?: unknown; lang?: unknown; skip?: unknown };
type AstEditArgs = { ops?: unknown; paths?: unknown; lang?: unknown };

// ---------------------------------------------------------------------------
// Schemas (plain JSON Schema — see header note #1; real checks live in execute)
// ---------------------------------------------------------------------------

const AstGrepParams = {
  type: "object",
  properties: {
    pat: { type: "string", description: "AST pattern. Metavariables are uppercase, e.g. $A and $$$ARGS." },
    paths: { type: "array", items: { type: "string" }, description: "Files, directories, or globs to search." },
    lang: { type: "string", description: "ast-grep language name such as ts, tsx, js, py, rust, go." },
    skip: { type: "number", description: "Number of matches to skip before returning output." },
  },
  required: ["pat", "paths"],
};

const AstEditParams = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      description: "Rewrite operations to apply sequentially.",
      items: {
        type: "object",
        properties: {
          pat: { type: "string", description: "AST pattern to replace." },
          out: { type: "string", description: "Replacement template." },
        },
        required: ["pat", "out"],
      },
    },
    paths: { type: "array", items: { type: "string" }, description: "Files, directories, or globs to rewrite." },
    lang: { type: "string", description: "ast-grep language name such as ts, tsx, js, py, rust, go." },
  },
  required: ["ops", "paths"],
};

// ---------------------------------------------------------------------------
// Binary resolution (lazy + cached — see header)
// ---------------------------------------------------------------------------

type Resolution = { path: string } | { error: string };
let cachedResolution: Resolution | undefined;

/** Strip the `file://` scheme and percent-decode an import.meta.url file URL. */
function fileUrlToPath(url: string): string {
  if (!url) return "";
  let p = url;
  if (p.startsWith("file://")) p = p.slice("file://".length);
  // A POSIX absolute file URL is `file:///abs` → `/abs` after the slice above.
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Package-local candidate binary paths, walking up from `startDir`. */
function localCandidates(startDir: string): string[] {
  const out: string[] = [];
  let dir = startDir;
  for (let depth = 0; depth < 8 && dir; depth++) {
    out.push(
      path.join(dir, "node_modules", "@ast-grep", "cli", "ast-grep"),
      path.join(dir, "node_modules", "@ast-grep", "cli", "sg"),
      path.join(dir, "node_modules", ".bin", "ast-grep"),
      path.join(dir, "node_modules", ".bin", "sg"),
    );
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function existsFile(candidate: string): boolean {
  try {
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

async function resolveSg(pi: ProviderExec): Promise<Resolution> {
  if (cachedResolution) return cachedResolution;

  // 1. Package-local binary, anchored at import.meta.url (no pi.exec needed).
  const selfPath = fileUrlToPath(String((import.meta as { url?: string }).url ?? ""));
  const startDir = selfPath ? path.dirname(selfPath) : "";
  if (startDir) {
    for (const candidate of localCandidates(startDir)) {
      if (existsFile(candidate)) {
        cachedResolution = { path: candidate };
        return cachedResolution;
      }
    }
  }

  // 2. PATH fallback — accept only a binary whose --version is really ast-grep.
  for (const name of ["ast-grep", "sg"]) {
    try {
      const probe = await execCommand(name, ["--version"], { timeoutMs: 10_000 }, pi);
      const out = `${probe.stdout}\n${probe.stderr}`.toLowerCase();
      if (probe.code === 0 && out.includes("ast-grep")) {
        cachedResolution = { path: name };
        return cachedResolution;
      }
    } catch {
      // command not found / not executable — try the next name.
    }
  }

  // L1: do NOT cache a failure. A first call that lands before `npm install`
  // has completed must not poison the whole session — leave cachedResolution
  // unset so a later call re-probes once the dependency is present. Only the
  // two success paths above are memoized.
  return {
    error:
      "ast-grep was not found. Ensure the harness package's dependencies are installed " +
      "(`npm install` provides @ast-grep/cli under node_modules), or put a real `ast-grep` on PATH. " +
      "Note: a bare `sg` on PATH may be shadow's set-group tool, not ast-grep, and is rejected.",
  };
}

// ---------------------------------------------------------------------------
// Helpers (ported 1:1 from the Node version)
// ---------------------------------------------------------------------------

function commonArgs(lang: string | undefined, paths: string[], json: boolean): string[] {
  const args = json ? ["run", "--json=compact", "--color", "never"] : ["run", "--color", "never"];
  if (lang) args.push("--lang", lang);
  args.push(...paths);
  return args;
}

function compactOutput(stdout: string, skip: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    return stdout || "No matches.";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "No matches.";
  const matches = parsed.slice(Math.max(0, skip));
  return JSON.stringify(matches, null, 2);
}

// ---------------------------------------------------------------------------
// Validation (the host does not enforce these — see header note #1)
// ---------------------------------------------------------------------------

function validatePaths(paths: unknown): string[] | string {
  if (!Array.isArray(paths) || paths.length === 0) {
    return "paths must be a non-empty array of file, directory, or glob strings.";
  }
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string" || p.trim() === "") return "each entry in paths must be a non-empty string.";
    out.push(p);
  }
  return out;
}

function validateOps(ops: unknown): { pat: string; out: string }[] | string {
  if (!Array.isArray(ops) || ops.length === 0) {
    return "ops must be a non-empty array of { pat, out } rewrite operations.";
  }
  const out: { pat: string; out: string }[] = [];
  for (const op of ops) {
    if (!op || typeof op !== "object") return "each op must be an object with string 'pat' and 'out'.";
    const pat = (op as Record<string, unknown>).pat;
    const replacement = (op as Record<string, unknown>).out;
    if (typeof pat !== "string" || pat.trim() === "") return "each op.pat must be a non-empty string.";
    if (typeof replacement !== "string") return "each op.out must be a string.";
    out.push({ pat, out: replacement });
  }
  return out;
}

function errorResult(text: string) {
  return { content: [{ type: "text", text }], details: { error: text } };
}

const EXEC_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export default function (pi: ProviderExec) {
  pi.registerTool({
    name: "ast_grep",
    label: "AST Grep",
    description: "Search code structurally using ast-grep. Use when syntax shape matters more than raw text.",
    parameters: AstGrepParams,
    async execute(_toolCallId: string, params: AstGrepArgs, _signal: unknown, _onUpdate: unknown, ctx: { cwd?: string }) {
      if (typeof params.pat !== "string" || params.pat.trim() === "") {
        return errorResult("pat must be a non-empty AST pattern string.");
      }
      const paths = validatePaths(params.paths);
      if (typeof paths === "string") return errorResult(paths);
      const lang = typeof params.lang === "string" && params.lang.trim() !== "" ? params.lang : undefined;
      const skip = typeof params.skip === "number" && Number.isFinite(params.skip) ? params.skip : 0;

      const resolution = await resolveSg(pi);
      if ("error" in resolution) return errorResult(resolution.error);

      const args = commonArgs(lang, paths, true);
      args.splice(1, 0, "--pattern", params.pat);
      let result: ExecResult;
      try {
        result = await execCommand(resolution.path, args, { cwd: ctx?.cwd, timeoutMs: EXEC_TIMEOUT_MS }, pi);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`ast-grep failed to run: ${message}`);
      }
      if (result.code !== 0) {
        return {
          content: [{ type: "text", text: result.stderr || result.stdout || `ast-grep exited ${result.code}` }],
          details: { code: result.code },
        };
      }
      return {
        content: [{ type: "text", text: compactOutput(result.stdout, skip) }],
        details: { code: result.code },
      };
    },
  });

  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description: "Rewrite code structurally using ast-grep rewrite patterns. Use for codemods where text replacement is unsafe.",
    parameters: AstEditParams,
    async execute(_toolCallId: string, params: AstEditArgs, _signal: unknown, _onUpdate: unknown, ctx: { cwd?: string }) {
      const ops = validateOps(params.ops);
      if (typeof ops === "string") return errorResult(ops);
      const paths = validatePaths(params.paths);
      if (typeof paths === "string") return errorResult(paths);
      const lang = typeof params.lang === "string" && params.lang.trim() !== "" ? params.lang : undefined;

      const resolution = await resolveSg(pi);
      if ("error" in resolution) return errorResult(resolution.error);

      const outputs: string[] = [];
      for (const op of ops) {
        const args = commonArgs(lang, paths, false);
        args.splice(1, 0, "--pattern", op.pat, "--rewrite", op.out, "--update-all");
        let result: ExecResult;
        try {
          result = await execCommand(resolution.path, args, { cwd: ctx?.cwd, timeoutMs: EXEC_TIMEOUT_MS }, pi);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outputs.push(`rewrite failed to run: ${message}`);
          return { content: [{ type: "text", text: outputs.join("\n\n") }], details: { code: 1 }, terminate: true };
        }
        outputs.push(result.stdout.trim() || result.stderr.trim() || `rewrite exited ${result.code}`);
        if (result.code !== 0) {
          return { content: [{ type: "text", text: outputs.join("\n\n") }], details: { code: result.code }, terminate: true };
        }
      }
      return { content: [{ type: "text", text: outputs.join("\n\n") || "No rewrites reported." }], details: { code: 0 } };
    },
  });
}
