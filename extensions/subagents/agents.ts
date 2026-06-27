/**
 * Agent-role definitions and indicator glyph/color mapping for the subagents
 * extension.
 *
 * The role prompts are carried over verbatim from the previous blocking `task`
 * tool. The glyph and status tables implement design decision D4 (indicator
 * grammar): every glyph is a single-codepoint, single-width, ANSI-recolorable
 * Unicode symbol — no emoji (which resist recoloring and render double-width in
 * some terminals). Notably `quick_task` uses ▸ (was ⚡) and `reviewer` uses ∴
 * (was ⚖ / U+2696, which carries the Emoji property).
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type AgentStatus = "waiting" | "thinking" | "working" | "done" | "failed" | "aborted";

export const TERMINAL_STATUSES: readonly AgentStatus[] = ["done", "failed", "aborted"];

export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const AGENT_PROMPTS: Record<string, { description: string; prompt: string }> = {
  explore: {
    description: "Fast read-only codebase scout returning compressed context.",
    prompt: "You are a read-only codebase scout. Inspect only what is needed, do not edit files, do not run gates/formatters, and return concise source-grounded findings.",
  },
  plan: {
    description: "Software architect for multi-file implementation plans.",
    prompt: "You are a software architect. Produce concrete implementation plans grounded in the repo. Do not edit files or run gates/formatters.",
  },
  designer: {
    description: "UI/UX implementation and review specialist.",
    prompt: "You are a UI/UX specialist. Focus on polished product design, accessibility, and implementation details. Do not run gates/formatters.",
  },
  reviewer: {
    description: "Code review specialist for correctness, security, and maintainability.",
    prompt: "You are a code reviewer. Look for correctness, security, reliability, and maintainability issues. Do not edit files or run gates/formatters.",
  },
  librarian: {
    description: "External library/API researcher.",
    prompt: "You are a library researcher. Read primary source/docs and return definitive source-grounded API facts. Do not edit files or run gates/formatters.",
  },
  oracle: {
    description: "Senior engineer for debugging, architecture, and implementation advice.",
    prompt: "You are a senior engineer. Solve hard debugging and architecture problems concretely. If editing is requested, keep changes targeted and do not run project-wide gates/formatters.",
  },
  task: {
    description: "General-purpose implementation subagent.",
    prompt: "You are a general-purpose coding subagent. Follow the assignment exactly, edit only targeted files, and do not run project-wide gates/formatters.",
  },
  quick_task: {
    description: "Mechanical low-reasoning update or collection agent.",
    prompt: "You are a mechanical task runner. Perform only the explicitly requested simple update or collection. Do not run gates/formatters.",
  },
};

/** Type glyph per agent role (D4). Single-width, recolorable. */
export const TYPE_GLYPHS: Record<string, string> = {
  explore: "⌕",
  plan: "∡",
  designer: "◬",
  reviewer: "∴",
  librarian: "⌘",
  oracle: "✦",
  task: "▦",
  quick_task: "▸",
};

/** Leading indicator glyph for the parent agent (D4). */
export const PARENT_GLYPH = "⊤";

/** Status glyph + theme color per status (D4). */
export const STATUS_META: Record<AgentStatus, { glyph: string; color: ThemeColor }> = {
  waiting: { glyph: "·", color: "dim" },
  thinking: { glyph: "∾", color: "accent" },
  working: { glyph: "▶", color: "warning" },
  done: { glyph: "✓", color: "success" },
  failed: { glyph: "✗", color: "error" },
  aborted: { glyph: "⊘", color: "warning" },
};

export function typeGlyph(type: string): string {
  return TYPE_GLYPHS[type] ?? TYPE_GLYPHS.task ?? "▦";
}
