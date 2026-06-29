/**
 * Channel transcript model — the append-only source of truth for one channel
 * (the main agent, or a sub-agent spawned by the `task` tool).
 *
 * Built from FINALIZED messages (`message_end` for the main session, and the
 * reconstructed `message_end` events of a child `pi --mode json` stream for
 * sub-agents) rather than streaming deltas, so the complete history is retained
 * in content order. This replaces the old design's lossy 8 KB rolling tail,
 * which was the root cause of "reasoning vanishes / writing…" — see
 * [[subagent-split-view-feature]].
 *
 * Every text body is sanitized of ANSI/control sequences, so a sub-agent's tool
 * output can never clear the screen (`[2J`), hijack the hardware cursor (a
 * forged cursor APC marker), or corrupt width measurement when later composited
 * into the TUI frame. The pager re-applies its own theme styling at render time.
 *
 * This module is pure and UI-agnostic: it produces structured {@link TranscriptBlock}s.
 * Wrapping those into width-bounded display lines is the pager's job.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

const ESC = "\u001b";
const BEL = "\u0007";

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

/** Control chars to drop entirely (keep "\n"; tabs are expanded separately). */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip ANSI/control sequences and normalize newlines/tabs to inert plain text. */
export function sanitize(input: string): string {
  if (!input) return "";
  return input
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_RE, "")
    .replace(/\t/g, "    ")
    .replace(CONTROL_RE, "");
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
