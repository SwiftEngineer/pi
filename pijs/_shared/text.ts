/**
 * PiJS shared text helpers — extracted so the `task` tool and the
 * `subagent-view` registry share one implementation of the byte/line bounding
 * logic (mirrors the `_shared/exec.ts` / `_shared/http.ts` seams).
 *
 * All pure UTF-8 / string logic, ported verbatim from the Node sources:
 *   - `BoundedText` + `countNewlines` + `utf8Head` + `clipToLineLimit` come from
 *     `extensions/task/index.ts`.
 *   - `tailBytes` comes from `extensions/subagent-view/registry.ts`.
 *
 * `Buffer` is imported from `node:buffer` (confirmed supported in the QuickJS
 * sandbox; the same form `pijs/search.ts` already relies on).
 *
 * ⚠ Runtime transpiler note: the pi_agent_rust QuickJS loader mis-handles a TS
 * type annotation on a PRIVATE class field's declaration line (`#f: T = v` and
 * `#f = v as T` both corrupt transpilation and throw "undefined private field"
 * at load — empirically verified). Type-only PUBLIC declarations strip fine. So
 * `BoundedText` uses `private`-modifier fields declared type-only (no
 * initializer) and initializes them in the constructor. Same pattern in
 * `../subagent-view/registry.ts`.
 */

import { Buffer } from "node:buffer";

/** Count the number of `\n` bytes in `text`. */
export function countNewlines(text: string): number {
  let count = 0;
  let index = text.indexOf("\n");
  while (index !== -1) {
    count++;
    index = text.indexOf("\n", index + 1);
  }
  return count;
}

/** Keep the leading `maxBytes` of UTF-8 text, aligned to a char boundary. */
export function utf8Head(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** Keep the trailing `maxBytes` of UTF-8 text, aligned to a char boundary. */
export function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** Keep at most `remainingLines` newline-terminated lines from the start of `text`. */
function clipToLineLimit(text: string, remainingLines: number): string {
  if (remainingLines <= 0) return "";
  let index = -1;
  for (let i = 0; i < remainingLines; i++) {
    index = text.indexOf("\n", index + 1);
    if (index === -1) return text;
  }
  return text.slice(0, index + 1);
}

/**
 * Append-only text buffer bounded by both a UTF-8 byte cap and a line cap.
 * Once either cap is hit, further input is counted as "dropped" and surfaced as
 * a trailing truncation notice from {@link BoundedText.text}.
 */
export class BoundedText {
  readonly maxBytes: number;
  readonly maxLines: number;
  private parts: string[];
  private bytes: number;
  private lines: number;
  private droppedBytes: number;
  private droppedLines: number;

  constructor(maxBytes: number, maxLines: number) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
    this.parts = [];
    this.bytes = 0;
    this.lines = 0;
    this.droppedBytes = 0;
    this.droppedLines = 0;
  }

  append(text: string): void {
    if (text.length === 0) return;
    const inputBytes = Buffer.byteLength(text, "utf8");
    const inputLines = countNewlines(text);
    if (this.bytes >= this.maxBytes || this.lines >= this.maxLines) {
      this.droppedBytes += inputBytes;
      this.droppedLines += inputLines;
      return;
    }

    const byLines = clipToLineLimit(text, this.maxLines - this.lines);
    const byBytes = utf8Head(byLines, this.maxBytes - this.bytes);
    if (byBytes.length > 0) {
      this.parts.push(byBytes);
      this.bytes += Buffer.byteLength(byBytes, "utf8");
      this.lines += countNewlines(byBytes);
    }

    const keptBytes = Buffer.byteLength(byBytes, "utf8");
    if (keptBytes < inputBytes) {
      this.droppedBytes += inputBytes - keptBytes;
      this.droppedLines += Math.max(0, inputLines - countNewlines(byBytes));
    }
  }

  reset(text = ""): void {
    this.parts = [];
    this.bytes = 0;
    this.lines = 0;
    this.droppedBytes = 0;
    this.droppedLines = 0;
    this.append(text);
  }

  text(): string {
    const body = this.parts.join("");
    if (this.droppedBytes === 0 && this.droppedLines === 0) return body;
    const lineNotice = this.droppedLines > 0 ? `, ${this.droppedLines} lines` : "";
    return `${body}\n\n[Output truncated: ${this.droppedBytes} bytes${lineNotice} omitted.]`;
  }
}
