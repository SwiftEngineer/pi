import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// bash policy
// ---------------------------------------------------------------------------

// Shell command → the dedicated Pi tool that replaces it. A command is only
// blocked when its replacement is active in the session (pi.getActiveTools()),
// so the block message always names a tool the model really has — and when no
// replacement is registered, bash remains the legitimate way to run it.
const REPLACEMENT_TOOLS: Record<string, string> = {
  // File viewing → read
  cat: "read",
  head: "read",
  tail: "read",
  less: "read",
  more: "read",
  // Content search → search
  grep: "search",
  rg: "search",
  ripgrep: "search",
  ag: "search",
  ack: "search",
  awk: "search",
  sed: "search",
  // Filename/glob lookup → find (fs-tools)
  find: "find",
  fd: "find",
  locate: "find",
  // Directory listing → ls (fs-tools)
  ls: "ls",
};

// Wrappers that execute a following word as a command, so the word after them
// is still in command position (`sudo cat`, `xargs ls`). Flags and leading
// environment assignments are skipped too. Over-skipping only risks false
// negatives (letting a shell `cat` through), which is the safe direction —
// false positives are what broke `aws s3 ls`.
const COMMAND_PREFIXES = new Set([
  "sudo",
  "doas",
  "nohup",
  "nice",
  "time",
  "env",
  "command",
  "exec",
  "timeout",
  "stdbuf",
  "strace",
  "watch",
  "xargs",
  "flock",
  "setsid",
]);

// Words in command position: the first non-flag, non-assignment, non-wrapper
// word of each simple command (segments split on shell separators). Arguments
// like the `ls` in `aws s3 ls` are never command words.
function commandWords(command: string): string[] {
  const words: string[] = [];
  for (const segment of command.split(/[;&|()\n`{}]/)) {
    for (const token of segment.trim().split(/\s+/)) {
      if (!token || token.startsWith("-")) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env assignment
      if (COMMAND_PREFIXES.has(token)) continue;
      words.push(basename(token));
      break; // one command per segment
    }
  }
  return words;
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

function bashViolation(command: string, activeTools: ReadonlySet<string>): string | undefined {
  if (/\|\s*(head|tail)\b/.test(command)) return "Do not pipe through head/tail; Pi already truncates tool output.";
  if (/\b2>\s*&\s*1\b|\b2>\s*\/dev\/null\b/.test(command)) return "Do not redirect stderr; Pi already captures stdout and stderr.";
  if (/\bsed\s+-n\b/.test(command)) return "Use read offsets/ranges instead of sed for line ranges.";
  for (const word of commandWords(command)) {
    const name = basename(word);
    const replacement = REPLACEMENT_TOOLS[name];
    if (replacement && activeTools.has(replacement)) {
      return `Use the ${replacement} tool instead of shelling out to ${name}.`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// edit pre-flight
//
// The pinned edit tool (pi 0.84.3) applies an edit that only matches after
// fuzzy normalization by rebuilding the touched lines from a normalized copy
// of the file, which silently rewrites characters outside the edit span
// (trailing whitespace, typographic quotes/dashes, special spaces) — and one
// fuzzy edit in a call switches the whole call into that mode. Leading
// whitespace is never normalized, so an oldText that mis-guesses indentation
// fails with a bare "Could not find" and no diagnostics. This guard blocks
// both cases before the file is written and shows the exact bytes to copy.
// ---------------------------------------------------------------------------

// Ported verbatim from normalizeForFuzzyMatch in
// @earendil-works/pi-coding-agent@0.84.3 (dist/core/tools/edit-diff.ts).
// Keep in sync when bumping the pi pin in distribution.json.
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isSingleEdit(value: unknown): value is { oldText: string; newText: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { oldText?: unknown }).oldText === "string" &&
    typeof (value as { newText?: unknown }).newText === "string"
  );
}

// Mirrors prepareEditArguments in the pinned edit tool: edits may arrive as a
// JSON string, as a single edit object, or with a legacy top-level
// oldText/newText pair folded into the list.
function extractEdits(input: Record<string, unknown>): Array<{ oldText?: unknown }> {
  let edits: unknown = input.edits;
  if (typeof edits === "string") {
    try {
      const parsed: unknown = JSON.parse(edits);
      if (Array.isArray(parsed)) edits = parsed;
      else if (isSingleEdit(parsed)) edits = [parsed];
    } catch {
      // Leave malformed input to the tool's own validation error.
    }
  } else if (isSingleEdit(edits)) {
    edits = [edits];
  }
  const list: Array<{ oldText?: unknown }> = Array.isArray(edits) ? [...edits] : [];
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    list.push({ oldText: input.oldText });
  }
  return list;
}

/** Render whitespace models routinely lose: → for tabs, · for trailing spaces. */
function visualize(line: string): string {
  return line.replace(/\t/g, "→").replace(/ +$/, (spaces) => "·".repeat(spaces.length));
}

/** Line numbers whose content resembles oldText's first meaningful line. */
function findCandidateLines(content: string, oldText: string): number[] {
  const firstLine = normalizeForFuzzyMatch(oldText)
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (!firstLine) return [];
  const needle = firstLine.trim();
  const lines = content.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < 3; i++) {
    if (normalizeForFuzzyMatch(lines[i] ?? "").includes(needle)) hits.push(i + 1);
  }
  return hits;
}

function excerpt(content: string, lineNumbers: number[]): string {
  const lines = content.split("\n");
  return lineNumbers
    .map((n) => {
      const out: string[] = [];
      for (let i = Math.max(1, n - 1); i <= Math.min(lines.length, n + 1); i++) {
        out.push(`  L${i}: ${visualize(lines[i - 1] ?? "")}`);
      }
      return out.join("\n");
    })
    .join("\n");
}

/** Exact (non-overlapping) occurrences of needle with their line numbers, capped at 5. */
function exactMatchLines(content: string, needle: string): { count: number; lines: number[] } {
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of content.split("\n")) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const start = lineStarts[mid] ?? 0;
      if (start <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines: number[] = [];
  let count = 0;
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    count++;
    if (lines.length < 5) lines.push(lineAt(idx));
    idx = content.indexOf(needle, idx + needle.length);
  }
  return { count, lines };
}

const MAX_REPORTED_VIOLATIONS = 3;

function editViolation(input: Record<string, unknown>, cwd: string): string | undefined {
  const rawPath = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
  if (rawPath.length === 0) return;
  const edits = extractEdits(input);
  if (edits.length === 0) return;

  let raw: string;
  try {
    raw = readFileSync(path.resolve(cwd, rawPath), "utf8");
  } catch {
    return; // Missing/unreadable files get the edit tool's own clearer error.
  }
  // Mirror the tool: strip BOM, compare in LF space.
  const content = normalizeToLF(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);

  const violations: string[] = [];
  let suppressed = 0;
  const note = (message: string): void => {
    if (violations.length < MAX_REPORTED_VIOLATIONS) violations.push(message);
    else suppressed++;
  };

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit) continue;
    const { oldText } = edit;
    if (typeof oldText !== "string" || oldText.length === 0) continue; // The tool validates these.
    const needle = normalizeToLF(oldText);

    const exact = exactMatchLines(content, needle);
    if (exact.count === 1) continue; // Exact, unique: the tool applies it byte-for-byte.

    if (exact.count > 1) {
      note(
        `edits[${i}]: oldText matches ${exact.count} locations in ${rawPath} (lines ${exact.lines.join(", ")}). ` +
          "Widen it with surrounding unique lines so it matches exactly one location.",
      );
      continue;
    }

    const candidates = findCandidateLines(content, needle);
    if (normalizeForFuzzyMatch(content).includes(normalizeForFuzzyMatch(needle))) {
      note(
        `edits[${i}]: oldText matches ${rawPath} only after lossy whitespace/Unicode normalization. ` +
          "The edit tool would then rebuild the surrounding lines from its normalized copy of the file, silently altering characters outside your edit " +
          "(trailing spaces, typographic quotes/dashes). Re-read the region and re-send oldText byte-for-byte as the file has it " +
          `(→ = tab, · = trailing space):\n${excerpt(content, candidates)}`,
      );
      continue;
    }

    note(
      `edits[${i}]: oldText was not found in ${rawPath}. It must reproduce the file exactly, including leading whitespace — ` +
        "indentation (tabs vs spaces, nesting depth) is not fuzzy-matched. " +
        (candidates.length > 0
          ? `Closest candidate lines (→ = tab, · = trailing space):\n${excerpt(content, candidates)}`
          : "Read the target region and copy the exact bytes."),
    );
  }

  if (violations.length === 0) return;
  return violations.join("\n") + (suppressed > 0 ? `\n(+${suppressed} more failing edit${suppressed === 1 ? "" : "s"})` : "");
}

// A bug in the guard must never block edits outright: the runtime surfaces handler
// exceptions as "Extension failed, blocking execution", which would disable editing.
function safeEditViolation(input: Record<string, unknown>, cwd: string): string | undefined {
  try {
    return editViolation(input, cwd);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event: ToolCallEvent, ctx) => {
    if (event.toolName === "edit") {
      const reason = safeEditViolation(event.input as Record<string, unknown>, ctx.cwd);
      if (reason) return { block: true, reason };
      return;
    }
    if (event.toolName !== "bash") return;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const reason = bashViolation(command, new Set(pi.getActiveTools()));
    if (!reason) return;
    return { block: true, reason };
  });
}
