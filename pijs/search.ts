/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/search.ts. Behavior-defining bounded-output logic
 * (truncation, per-file/global caps, notices, formatBytes) ports 1:1. The
 * adaptations forced by the QuickJS runtime are:
 *
 *  1. Dependencies: `glob` and `ignore` are npm packages that do not run in
 *     the sandbox (virtual stubs / unstubbed). Reimplemented below in pure JS
 *     using only `node:fs`, `node:path`, `node:buffer` (all confirmed supported
 *     by the PiJS hostcall matrix). Supports the common shapes: a file path, a
 *     directory path, and a glob pattern with `*`, `**`, `?`.
 *  2. Schema: plain JSON Schema object instead of typebox `Type.Object`. The
 *     runtime validates only `type`/`properties`/`required`.
 *  3. Cancellation: the host invokes the tool as
 *     `execute(toolCallId, input, undefined, undefined, ctx)` — `signal` is
 *     always undefined and QuickJS has no Node event loop, so the original
 *     AbortController/setTimeout abort machinery is inert here. Timeout is
 *     enforced by the inline `Date.now() > deadline` check (runtime-agnostic);
 *     hard cancellation is the host's responsibility (ExtensionRegion budget).
 */

import { promises as fs } from "node:fs";
import { Buffer } from "node:buffer";
import path from "node:path";

const DEFAULT_FILE_LIMIT = 20;
const MULTI_FILE_PER_FILE_MATCHES = 20;
const SINGLE_FILE_MATCHES = 200;
const INTERNAL_TOTAL_CAP = 2000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COLUMN = 512;
const INLINE_MAX_BYTES = 50 * 1024;

type SearchParamsType = {
  pattern: string;
  paths?: string | string[];
  i?: boolean;
  context?: number;
  maxResults?: number;
  skip?: number;
  gitignore?: boolean;
};

type AppendResult = "ok" | "line-truncated" | "output-full";

// ---------------------------------------------------------------------------
// Glob + gitignore (pure-JS reimplementations — see header note #1)
// ---------------------------------------------------------------------------

/** Convert a glob pattern (with *, **, ?) to a RegExp anchored over a path. */
function globToRegex(pattern: string): RegExp {
  let i = 0;
  let re = "";
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          i += 1;
          re += "(?:.*/)?"; // **/ -> matches zero or more leading dirs
        } else {
          re += ".*"; // ** -> crosses path separators
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (".+^$(){}|[]\\".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$");
}

interface IgnorePattern {
  negate: boolean;
  regex: RegExp;
  anchored: boolean;
  dirOnly: boolean;
  source: string;
}

/** Compile a single .gitignore line into a matchable pattern. */
function compileIgnoreLine(raw: string): IgnorePattern | undefined {
  let line = raw;
  const hash = line.indexOf("#");
  if (hash >= 0) line = line.slice(0, hash);
  line = line.trim();
  if (line === "") return undefined;

  let negate = false;
  if (line[0] === "!") {
    negate = true;
    line = line.slice(1);
  }
  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  // Trailing slash => directory-only (match directories named `source` + their contents).
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  return { negate, regex: globToRegex(line), anchored, dirOnly, source: line };
}

interface IgnoreEngine {
  ignores: (rel: string, isDir?: boolean) => boolean;
}

function makeIgnore(patterns: IgnorePattern[]): IgnoreEngine {
  return {
    ignores(rel: string, isDir = false): boolean {
      const segs = rel.split("/");
      let ignored = false;
      for (const p of patterns) {
        let hit = false;
        if (!p.source.includes("/")) {
          // No-slash pattern matches a single component at any depth (file or dir).
          for (let idx = 0; idx < segs.length; idx++) {
            if (!p.regex.test(segs[idx] ?? "")) continue;
            const isLast = idx === segs.length - 1;
            // dir-only rule ignores a component only if it is an ancestor dir, or
            // the trailing component when the path itself is a directory.
            if (p.dirOnly && isLast && !isDir) continue;
            hit = true;
            break;
          }
        } else {
          // Slashed pattern: anchored to root — match full path or an ancestor dir prefix.
          if (p.regex.test(rel)) {
            hit = true;
          } else {
            for (let i = 1; i < segs.length; i++) {
              if (p.regex.test(segs.slice(0, i).join("/"))) {
                hit = true;
                break;
              }
            }
          }
        }
        if (hit) ignored = !p.negate;
      }
      return ignored;
    },
  };
}

async function loadIgnore(cwd: string, enabled: boolean): Promise<IgnoreEngine> {
  const patterns: IgnorePattern[] = [];
  if (enabled) {
    const file = path.join(cwd, ".gitignore");
    try {
      const text = await fs.readFile(file, "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const p = compileIgnoreLine(raw);
        if (p) patterns.push(p);
      }
    } catch {
      // No .gitignore — only the hard-coded ignores below apply.
    }
  }
  for (const line of [".git/", "node_modules/", ".pi/", ".omp/"]) {
    const p = compileIgnoreLine(line);
    if (p) patterns.push(p);
  }
  return makeIgnore(patterns);
}

function matchGlob(pattern: string, rel: string): boolean {
  const re = globToRegex(pattern);
  if (re.test(rel)) return true;
  // Slash-less pattern matches the basename anywhere.
  if (!pattern.includes("/")) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (re.test(base)) return true;
  }
  return false;
}

/** Recursively collect files under `rootRel` (relative to cwd), pruning ignored dirs. */
async function walkFiles(rootRel: string, cwd: string, ig: IgnoreEngine, out: string[]): Promise<void> {
  const absRoot = path.resolve(cwd, rootRel);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = (rootRel ? rootRel + "/" : "") + entry.name;
    const isDir = entry.isDirectory();
    if (ig.ignores(rel, isDir)) continue;
    if (isDir) {
      await walkFiles(rel, cwd, ig, out);
    } else if (entry.isFile()) {
      out.push(path.resolve(cwd, rel));
    }
  }
}

async function expandInput(cwd: string, input: string, ig: IgnoreEngine): Promise<string[]> {
  const absolute = path.resolve(cwd, input);
  let st;
  try {
    st = await fs.stat(absolute);
  } catch {
    st = undefined;
  }
  if (st?.isFile()) return [absolute];
  if (st?.isDirectory()) {
    const out: string[] = [];
    await walkFiles("", absolute, ig, out);
    return out;
  }
  // Treat as a glob pattern relative to cwd.
  const all: string[] = [];
  await walkFiles("", cwd, ig, all);
  return all.filter((file) => {
    const rel = path.relative(cwd, file);
    return matchGlob(input, rel);
  });
}

// ---------------------------------------------------------------------------
// Helpers (ported verbatim from the Node version)
// ---------------------------------------------------------------------------

function lineRanges(line: number, total: number, context: number): number[] {
  const start = Math.max(1, line - context);
  const end = Math.min(total, line + context);
  const out: number[] = [];
  for (let n = start; n <= end; n++) out.push(n);
  return out;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value ?? fallback), max));
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function truncateLine(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = utf8ByteLength(text);
  if (bytes <= maxBytes) return { text, omittedBytes: 0 };
  const suffix = `… [line truncated: ${bytes - maxBytes} bytes omitted]`;
  const headBytes = Math.max(0, maxBytes - utf8ByteLength(suffix));
  return { text: `${utf8Head(text, headBytes)}${suffix}`, omittedBytes: bytes - headBytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const SearchParams = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "JavaScript regular expression to search for." },
    paths: {
      description: "File, directory, or glob to search.",
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
      ],
    },
    i: { type: "boolean", description: "Case-insensitive search." },
    context: { type: "number", description: "Number of context lines around each match." },
    maxResults: { type: "number", description: `Maximum matching lines to return. Default ${INTERNAL_TOTAL_CAP}.` },
    skip: { type: "number", description: "Matching files to skip before collecting results; use to paginate after the file limit." },
    gitignore: { type: "boolean", description: "Respect .gitignore in the current working directory. Default true." },
  },
  required: ["pattern"],
};

export default function (pi: {
  registerTool: (spec: unknown) => void;
  process?: { cwd?: () => string };
}) {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: "Search file contents with a regular expression. Use this instead of grep, rg, awk, or sed for content lookup.",
    parameters: SearchParams,
    async execute(_toolCallId: string, params: SearchParamsType, _signal: unknown, _onUpdate: unknown, ctx: { cwd?: string }) {
      const cwd = ctx && typeof ctx.cwd === "string" ? ctx.cwd : (pi.process?.cwd?.() ?? ".");
      const inputs = Array.isArray(params.paths) ? params.paths : [params.paths ?? "."];
      const regex = new RegExp(params.pattern, params.i ? "i" : "");
      const maxResults = clampInt(params.maxResults, INTERNAL_TOTAL_CAP, 1, INTERNAL_TOTAL_CAP);
      const context = clampInt(params.context, 1, 0, 10);
      const skip = clampInt(params.skip, 0, 0, Number.MAX_SAFE_INTEGER);
      const deadline = Date.now() + SEARCH_TIMEOUT_MS;
      let timedOut = false;

      const ig = await loadIgnore(cwd, params.gitignore !== false);
      const files = new Set<string>();
      for (const input of inputs) {
        for (const file of await expandInput(cwd, input, ig)) {
          const rel = path.relative(cwd, file);
          if (!rel.startsWith("..") && !path.isAbsolute(rel) && ig.ignores(rel)) continue;
          files.add(file);
        }
        if (Date.now() > deadline) {
          timedOut = true;
          break;
        }
      }

      const fileMatchLimit = files.size === 1 ? SINGLE_FILE_MATCHES : MULTI_FILE_PER_FILE_MATCHES;
      const linesOut: string[] = [];
      const skippedLargeFiles: string[] = [];
      let outputBytes = 0;
      let outputFull = false;
      let emittedMatches = 0;
      let emittedFiles = 0;
      let matchedFilesSeen = 0;
      let columnTruncatedLines = 0;
      let columnDroppedBytes = 0;
      let perFileTruncatedFiles = 0;
      let globalMatchTruncated = false;

      const appendLine = (line: string): AppendResult => {
        const truncated = truncateLine(line, DEFAULT_MAX_COLUMN);
        const resultLine = truncated.text;
        const bytes = utf8ByteLength(resultLine) + 1;
        if (outputBytes + bytes > INLINE_MAX_BYTES) {
          outputFull = true;
          return "output-full";
        }
        linesOut.push(resultLine);
        outputBytes += bytes;
        if (truncated.omittedBytes > 0) {
          columnTruncatedLines++;
          columnDroppedBytes += truncated.omittedBytes;
          return "line-truncated";
        }
        return "ok";
      };

      scan: for (const file of files) {
        if (Date.now() > deadline) {
          timedOut = true;
          break;
        }

        let st;
        try {
          st = await fs.stat(file);
        } catch {
          continue;
        }
        const rel = path.relative(cwd, file);
        if (st.size > MAX_FILE_BYTES) {
          skippedLargeFiles.push(rel);
          continue;
        }

        let text: string;
        try {
          text = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;

        const lines = text.split(/\r?\n/);
        const emittedLineNumbers = new Set<number>();
        let fileMatched = false;
        let fileEmitted = false;
        let fileEmittedMatches = 0;
        let emitThisFile = false;
        let fileHitPerFileLimit = false;

        for (let index = 0; index < lines.length; index++) {
          if (Date.now() > deadline) {
            timedOut = true;
            break scan;
          }
          const line = lines[index] ?? "";
          if (!regex.test(line)) continue;
          regex.lastIndex = 0;

          if (!fileMatched) {
            fileMatched = true;
            matchedFilesSeen++;
            emitThisFile = matchedFilesSeen > skip && emittedFiles < DEFAULT_FILE_LIMIT;
            if (!emitThisFile) break;
            emittedFiles++;
          }

          if (fileEmittedMatches >= fileMatchLimit) {
            fileHitPerFileLimit = true;
            break;
          }
          if (emittedMatches >= maxResults) {
            globalMatchTruncated = true;
            break scan;
          }
          if (!emitThisFile) break;

          const lineNo = index + 1;
          for (const n of lineRanges(lineNo, lines.length, context)) {
            if (emittedLineNumbers.has(n)) continue;
            emittedLineNumbers.add(n);
            const mark = n === lineNo ? "*" : " ";
            const status = appendLine(`${mark}${rel}:${n}:${lines[n - 1] ?? ""}`);
            if (status === "output-full") break scan;
          }
          fileEmitted = true;
          fileEmittedMatches++;
          emittedMatches++;
        }

        if (fileEmitted && fileHitPerFileLimit) perFileTruncatedFiles++;
        if (emittedFiles >= DEFAULT_FILE_LIMIT && fileMatched) {
          break;
        }
      }

      const notices: string[] = [];
      if (skip > 0) notices.push(`Skipped the first ${skip} matching file${skip === 1 ? "" : "s"}.`);
      if (matchedFilesSeen >= skip + DEFAULT_FILE_LIMIT && emittedFiles === DEFAULT_FILE_LIMIT) {
        notices.push(`File window capped at ${DEFAULT_FILE_LIMIT}; rerun with skip: ${skip + DEFAULT_FILE_LIMIT} for more matching files.`);
      }
      if (globalMatchTruncated) notices.push(`Match window capped at ${maxResults} matching lines.`);
      if (perFileTruncatedFiles > 0) notices.push(`${perFileTruncatedFiles} file${perFileTruncatedFiles === 1 ? "" : "s"} hit the per-file cap of ${fileMatchLimit} matches.`);
      if (outputFull) notices.push(`Inline output capped at ${formatBytes(INLINE_MAX_BYTES)}; narrow paths/pattern or use skip.`);
      if (columnTruncatedLines > 0) notices.push(`${columnTruncatedLines} long line${columnTruncatedLines === 1 ? "" : "s"} truncated at ${DEFAULT_MAX_COLUMN} bytes (${formatBytes(columnDroppedBytes)} omitted).`);
      if (skippedLargeFiles.length > 0) {
        const preview = skippedLargeFiles.slice(0, 5).join(", ");
        const extra = skippedLargeFiles.length > 5 ? `, and ${skippedLargeFiles.length - 5} more` : "";
        notices.push(`Skipped ${skippedLargeFiles.length} file${skippedLargeFiles.length === 1 ? "" : "s"} larger than ${formatBytes(MAX_FILE_BYTES)} (${preview}${extra}).`);
      }
      if (timedOut) notices.push(`Search stopped after ${SEARCH_TIMEOUT_MS}ms; narrow paths or pattern.`);

      if (emittedMatches === 0) {
        const text = notices.length > 0 ? `No matches shown.\n${notices.map((n) => `[notice] ${n}`).join("\n")}` : "No matches.";
        return { content: [{ type: "text", text }], details: { matches: 0, files: 0, matchedFilesSeen, notices } };
      }

      const header = `Showing ${emittedMatches} match${emittedMatches === 1 ? "" : "es"} in ${emittedFiles} file${emittedFiles === 1 ? "" : "s"}.`;
      const noticeText = notices.length > 0 ? `\n${notices.map((n) => `[notice] ${n}`).join("\n")}` : "";
      return {
        content: [{ type: "text", text: `${header}\n${linesOut.join("\n")}${noticeText}` }],
        details: {
          matches: emittedMatches,
          files: emittedFiles,
          matchedFilesSeen,
          skippedLargeFiles: skippedLargeFiles.length,
          truncated: outputFull || globalMatchTruncated || perFileTruncatedFiles > 0 || timedOut,
          notices,
        },
      };
    },
  });
}
