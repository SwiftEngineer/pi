import { promises as fs } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import ignore from "ignore";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_FILE_LIMIT = 20;
const MULTI_FILE_PER_FILE_MATCHES = 20;
const SINGLE_FILE_MATCHES = 200;
const INTERNAL_TOTAL_CAP = 2000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COLUMN = 512;
const INLINE_MAX_BYTES = 50 * 1024;

const SearchParams = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression to search for." }),
  paths: Type.Optional(
    Type.Union([
      Type.String({ description: "File, directory, or glob to search." }),
      Type.Array(Type.String(), { description: "Files, directories, or globs to search." }),
    ]),
  ),
  i: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
  context: Type.Optional(Type.Number({ description: "Number of context lines around each match." })),
  maxResults: Type.Optional(Type.Number({ description: `Maximum matching lines to return. Default ${INTERNAL_TOTAL_CAP}.` })),
  skip: Type.Optional(Type.Number({ description: "Matching files to skip before collecting results; use to paginate after the file limit." })),
  gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore in the current working directory. Default true." })),
});

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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function expandInput(cwd: string, input: string, signal?: AbortSignal): Promise<string[]> {
  const absolute = path.resolve(cwd, input);
  const options = { nodir: true, dot: true, absolute: true, ...(signal ? { signal } : {}) };
  let st;
  try {
    st = await fs.stat(absolute);
  } catch {
    // Treat non-existing path as a glob below.
  }
  if (st?.isFile()) return [absolute];
  if (st?.isDirectory()) return glob("**/*", { cwd: absolute, ...options });
  return glob(input, { cwd, ...options });
}

async function loadIgnore(cwd: string, enabled: boolean) {
  const ig = ignore();
  if (!enabled) return ig;
  const file = path.join(cwd, ".gitignore");
  if (await exists(file)) ig.add(await fs.readFile(file, "utf8"));
  ig.add([".git/", "node_modules/", ".pi/", ".omp/"]);
  return ig;
}

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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: "Search file contents with a regular expression. Use this instead of grep, rg, awk, or sed for content lookup.",
    promptSnippet: "search — regex content search across files/directories/globs with bounded output.",
    promptGuidelines: [
      "Use search for plain-text content lookup instead of shell grep/rg/ag/awk/sed.",
      `Search returns at most ${DEFAULT_FILE_LIMIT} files per call and caps long match lines; use skip to paginate.`,
    ],
    parameters: SearchParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: SearchParamsType, signal, _onUpdate, ctx) {
      const inputs = Array.isArray(params.paths) ? params.paths : [params.paths ?? "."];
      const regex = new RegExp(params.pattern, params.i ? "i" : "");
      const maxResults = clampInt(params.maxResults, INTERNAL_TOTAL_CAP, 1, INTERNAL_TOTAL_CAP);
      const context = clampInt(params.context, 1, 0, 10);
      const skip = clampInt(params.skip, 0, 0, Number.MAX_SAFE_INTEGER);
      const deadline = Date.now() + SEARCH_TIMEOUT_MS;
      let timedOut = false;
      let aborted = false;
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => timeoutController.abort(), SEARCH_TIMEOUT_MS);
      timeoutTimer.unref();
      const abortExpansion = () => timeoutController.abort();
      if (signal?.aborted) {
        aborted = true;
        timeoutController.abort();
      } else {
        signal?.addEventListener("abort", abortExpansion, { once: true });
      }
      const ig = await loadIgnore(ctx.cwd, params.gitignore !== false);
      const files = new Set<string>();
      try {
        for (const input of inputs) {
          if (signal?.aborted || timeoutController.signal.aborted) break;
          for (const file of await expandInput(ctx.cwd, input, timeoutController.signal)) {
            const rel = path.relative(ctx.cwd, file);
            if (!rel.startsWith("..") && !path.isAbsolute(rel) && ig.ignores(rel)) continue;
            files.add(file);
          }
        }
      } catch (error) {
        if (timeoutController.signal.aborted) {
          aborted = signal?.aborted === true;
          timedOut = !aborted;
        } else {
          throw error;
        }
      } finally {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", abortExpansion);
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
        if (signal?.aborted) {
          aborted = true;
          break;
        }
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
        const rel = path.relative(ctx.cwd, file);
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
          if (signal?.aborted) {
            aborted = true;
            break scan;
          }
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
          // Keep work bounded. The caller can ask for the next window with skip.
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
      if (aborted) notices.push("Search aborted.");

      if (emittedMatches === 0) {
        const text = notices.length > 0 ? `No matches shown.\n${notices.map(n => `[notice] ${n}`).join("\n")}` : "No matches.";
        return { content: [{ type: "text", text }], details: { matches: 0, files: 0, matchedFilesSeen, notices } };
      }

      const header = `Showing ${emittedMatches} match${emittedMatches === 1 ? "" : "es"} in ${emittedFiles} file${emittedFiles === 1 ? "" : "s"}.`;
      const noticeText = notices.length > 0 ? `\n${notices.map(n => `[notice] ${n}`).join("\n")}` : "";
      return {
        content: [{ type: "text", text: `${header}\n${linesOut.join("\n")}${noticeText}` }],
        details: {
          matches: emittedMatches,
          files: emittedFiles,
          matchedFilesSeen,
          skippedLargeFiles: skippedLargeFiles.length,
          truncated: outputFull || globalMatchTruncated || perFileTruncatedFiles > 0 || timedOut || aborted,
          notices,
        },
      };
    },
  });
}
