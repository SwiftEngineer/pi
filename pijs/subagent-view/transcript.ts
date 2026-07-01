/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/subagent-view/transcript.ts. This module is pure and
 * UI-agnostic, so the logic ports 1:1. Two PiJS-relevant notes:
 *  1. Every external import here is `import type` (AgentMessage / pi-ai message
 *     shapes), which the TS-aware Rust loader erases — so at runtime this file
 *     has NO value imports from the `@earendil-works/*` packages (not present in
 *     the sandbox). The types resolve for `tsc` via the repo's devDependencies.
 *  2. The ANSI/control constants are built from `String.fromCharCode` and the
 *     control-char strip is a codepoint filter (was a regex literal containing
 *     raw control bytes). This is behavior-identical but keeps the source file
 *     free of literal control bytes (a raw NUL/ESC in source is fragile to load).
 *
 * ── original module docstring ────────────────────────────────────────────────
 * Channel transcript model — the append-only source of truth for one channel
 * (the main agent, or a sub-agent spawned by the `task` tool).
 *
 * Built from FINALIZED messages (`message_end` for the main session, and the
 * reconstructed `message_end` events of a child `pi --mode json` stream for
 * sub-agents) rather than streaming deltas, so the complete history is retained
 * in content order.
 *
 * Every text body is sanitized of ANSI/control sequences, so a sub-agent's tool
 * output can never clear the screen, hijack the hardware cursor, or corrupt
 * width measurement when later composited into the TUI frame.
 */
import type { AgentMessage, BashExecutionMessage, BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

/** A single logical chunk of a transcript, in chronological / content order. */
export type BlockKind = "user" | "thinking" | "text" | "toolcall" | "toolresult" | "meta";

export interface TranscriptBlock {
  readonly kind: BlockKind;
  /** Optional header label shown before the body (e.g. a tool name). */
  readonly label?: string;
  /** Sanitized plain-text body; may contain "\n" but no ANSI/control bytes. */
  readonly text: string;
  /** True for failed tool results (rendered with an error marker). */
  readonly isError?: boolean;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * Matches ANSI/VT escape sequences so reconstructed content renders as inert
 * plain text: OSC, APC/DCS/PM/SOS (BEL- or ST-terminated), CSI, and lone two-byte
 * escapes. Non-greedy bodies keep a stray ESC from swallowing real text.
 */
const ANSI_RE = new RegExp(
  `${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)` + // OSC ... BEL/ST
    `|${ESC}[_PX^][\\s\\S]*?(?:${BEL}|${ESC}\\\\)` + // APC/DCS/PM/SOS ... BEL/ST (incl. forged cursor markers)
    `|${ESC}\\[[0-9;:?]*[ -/]*[@-~]` + // CSI
    `|${ESC}[@-Z\\\\-_]`, // lone ESC + final byte
  "g",
);

/**
 * Drop control chars: 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f, 0x7f. Keeps "\n" (0x0a)
 * and does not touch 0x09 (tabs are expanded to spaces before this runs). Mirrors
 * the original control-char class 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f, 0x7f.
 */
function stripControl(input: string): string {
  let out = "";
  for (const ch of input) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a) {
      out += ch;
      continue;
    }
    if ((c >= 0x00 && c <= 0x08) || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** Strip ANSI/control sequences and normalize newlines/tabs to inert plain text. */
export function sanitize(input: string): string {
  if (!input) return "";
  return stripControl(
    input
      .replace(/\r\n?/g, "\n")
      .replace(ANSI_RE, "")
      .replace(/\t/g, "    "),
  );
}

/** Pull plain text out of a `string | (TextContent | ImageContent)[]` body. */
function contentText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
    else if (part.type === "image") parts.push("[image]");
  }
  return parts.join("");
}

const MAX_ARG_CHARS = 200;

/** Compact, bounded one-line summary of a tool call's arguments. */
function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = String(args);
  }
  if (!json || json === "{}" || json === "null") return "";
  return json.length > MAX_ARG_CHARS ? `${json.slice(0, MAX_ARG_CHARS)}…` : json;
}

/**
 * Convert one finalized message into transcript blocks, in content order.
 * Returns `[]` for messages with no displayable content or unknown custom roles.
 *
 * `AgentMessage` is `Message | <custom>`, so we discriminate on the `role` string
 * and cast to the concrete pi-ai shape rather than relying on union narrowing
 * (the custom branch has no `role` discriminant).
 */
export function messageToBlocks(message: AgentMessage | undefined): TranscriptBlock[] {
  if (!message || typeof message !== "object") return [];
  const role = (message as { role?: unknown }).role;
  const blocks: TranscriptBlock[] = [];

  if (role === "user") {
    const text = sanitize(contentText((message as UserMessage).content)).trim();
    if (text) blocks.push({ kind: "user", text });
    return blocks;
  }

  if (role === "assistant") {
    const assistant = message as AssistantMessage;
    for (const part of assistant.content) {
      if (part.type === "thinking") {
        const text = sanitize(part.thinking).trim();
        if (text) blocks.push({ kind: "thinking", text });
      } else if (part.type === "text") {
        const text = sanitize(part.text).trim();
        if (text) blocks.push({ kind: "text", text });
      } else if (part.type === "toolCall") {
        blocks.push({ kind: "toolcall", label: part.name, text: sanitize(summarizeArgs(part.arguments)) });
      }
    }
    if (assistant.errorMessage) {
      blocks.push({ kind: "meta", text: sanitize(`error: ${assistant.errorMessage}`) });
    }
    return blocks;
  }

  if (role === "toolResult") {
    const result = message as ToolResultMessage;
    const text = sanitize(contentText(result.content)).trim();
    blocks.push({ kind: "toolresult", label: result.toolName, text, isError: result.isError });
    return blocks;
  }

  // A sub-agent's `bash` tool runs surface as a dedicated message role: render
  // the command as a tool call and its output as a (possibly error) result.
  if (role === "bashExecution") {
    const bash = message as BashExecutionMessage;
    const command = sanitize(bash.command).trim();
    blocks.push({ kind: "toolcall", label: "bash", text: command });
    const output = sanitize(bash.output).trim();
    const isError = bash.cancelled || (typeof bash.exitCode === "number" && bash.exitCode !== 0);
    const outcome = bash.cancelled ? "cancelled" : `exit ${bash.exitCode ?? "?"}`;
    const body = bash.truncated && output ? `${output}\n…(truncated)` : output;
    if (body || isError) blocks.push({ kind: "toolresult", label: `bash (${outcome})`, text: body, isError });
    return blocks;
  }

  // Context-management markers: render as inert meta lines so the reader sees
  // that a compaction/branch-return happened rather than silently losing turns.
  if (role === "compactionSummary") {
    const compaction = message as CompactionSummaryMessage;
    const summary = sanitize(compaction.summary).trim();
    const tokens = typeof compaction.tokensBefore === "number" ? ` (~${compaction.tokensBefore} tokens)` : "";
    blocks.push({ kind: "meta", text: `context compacted${tokens}${summary ? `: ${summary}` : ""}` });
    return blocks;
  }

  if (role === "branchSummary") {
    const branch = message as BranchSummaryMessage;
    const summary = sanitize(branch.summary).trim();
    blocks.push({ kind: "meta", text: summary ? `returned from branch: ${summary}` : "returned from branch" });
    return blocks;
  }

  // Custom messages (e.g. nested task results) — show only when display:true.
  if (role === "custom") {
    const custom = message as CustomMessage;
    if (!custom.display) return blocks;
    const text = sanitize(contentText(custom.content)).trim();
    if (text) blocks.push({ kind: "meta", text: custom.customType ? `${custom.customType}: ${text}` : text });
    return blocks;
  }

  return blocks;
}

/**
 * Flatten blocks into a single plain-text string for the live panel tail (v1).
 * The full pager renders blocks directly with theme styling; this keeps the
 * existing panel behavior working while history is no longer discarded.
 */
export function blocksToText(blocks: readonly TranscriptBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "toolcall") {
      const args = block.text ? ` ${block.text}` : "";
      out.push(`→ ${block.label ?? "tool"}${args}`);
      continue;
    }
    if (block.kind === "toolresult") {
      const head = `← ${block.label ?? "result"}${block.isError ? " (error)" : ""}`;
      out.push(block.text ? `${head}\n${block.text}` : head);
      continue;
    }
    if (block.kind === "user") {
      out.push(`❯ ${block.text}`);
      continue;
    }
    if (block.kind === "meta") {
      out.push(`— ${block.text}`);
      continue;
    }
    out.push(block.text);
  }
  return out.join("\n\n");
}
