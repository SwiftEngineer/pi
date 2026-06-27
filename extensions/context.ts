/**
 * `/context` — context window usage breakdown.
 *
 * A faithful port of oh-my-pi's `/context` command. The rendering (the 20x10
 * draughts-glyph grid, the legend, the colors, the bordered panel) is mapped
 * one-to-one from oh-my-pi's `modes/utils/context-usage.ts` +
 * `handleContextCommand`, so the panel looks identical here.
 *
 * Differences forced by the upstream (@earendil-works) runtime this harness
 * runs on:
 *  - Token counts use a character heuristic (chars / 4), which is what Pi's own
 *    estimator uses. oh-my-pi shells out to a native tokenizer, so absolute
 *    numbers differ slightly, but the categories and layout are identical.
 *  - The autocompact buffer uses the harness compaction defaults, since the
 *    extension API does not expose per-session compaction settings.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  MessageRenderOptions,
  SessionContext,
  Theme,
  ThemeColor,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, DEFAULT_COMPACTION_SETTINGS, DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

// ---- Grid geometry & glyphs (verbatim from oh-my-pi context-usage.ts) --------
const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";
const CELL_FILLED = "⛁"; // ⛁ draughts king — system prompt / tools / context / skills
const CELL_FILLED_MESSAGES = "⛃"; // ⛃ draughts king — messages
const CELL_FREE = "⛶"; // ⛶ square four corners — free space
const CELL_BUFFER = "⛝"; // ⛝ squared saltire — autocompact buffer

const IMAGE_TOKEN_ESTIMATE = 1200;

interface Category {
  id: string;
  label: string;
  tokens: number;
  color: ThemeColor;
  glyph: string;
}

interface Cell {
  glyph: string;
  color: ThemeColor;
}

interface ContextBreakdown {
  contextWindow: number;
  modelName: string;
  modelId: string;
  categories: Category[];
  usedTokens: number;
  autoCompactBufferTokens: number;
  freeTokens: number;
}

// ---- Token estimation --------------------------------------------------------

/** Character heuristic (chars / 4), matching Pi's own token estimator. */
function countTokens(fragments: string[]): number {
  let chars = 0;
  for (const fragment of fragments) {
    if (fragment) chars += fragment.length;
  }
  return Math.ceil(chars / 4);
}

type MessageBlock = { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type MessageLike = {
  role: string;
  content?: string | MessageBlock[];
  command?: string;
  output?: string;
  summary?: string;
};

function estimateTokens(rawMessage: SessionContext["messages"][number]): number {
  const message = rawMessage as unknown as MessageLike;
  const fragments: string[] = [];
  let extra = 0;
  if (message.role === "bashExecution") {
    if (typeof message.command === "string") fragments.push(message.command);
    if (typeof message.output === "string") fragments.push(message.output);
    return fragments.length === 0 ? 0 : countTokens(fragments);
  }
  switch (message.role) {
    case "user": {
      const content = message.content;
      if (typeof content === "string") {
        fragments.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) fragments.push(block.text);
        }
      }
      break;
    }
    case "assistant": {
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            fragments.push(block.text);
          } else if (block.type === "thinking" && block.thinking) {
            fragments.push(block.thinking);
          } else if (block.type === "toolCall") {
            if (block.name) fragments.push(block.name);
            fragments.push(JSON.stringify(block.arguments));
          }
        }
      }
      break;
    }
    case "hookMessage":
    case "toolResult": {
      const content = message.content;
      if (typeof content === "string") {
        fragments.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            fragments.push(block.text);
          } else if (block.type === "image") {
            extra += IMAGE_TOKEN_ESTIMATE;
          }
        }
      }
      break;
    }
    case "branchSummary":
    case "compactionSummary": {
      if (message.summary) fragments.push(message.summary);
      break;
    }
    default:
      return 0;
  }
  if (fragments.length === 0) return extra;
  return extra + countTokens(fragments);
}

function estimateSkillsTokens(skills: Array<{ name: string; description: string }>): number {
  const fragments: string[] = [];
  for (const skill of skills) {
    fragments.push(skill.name, skill.description);
  }
  return countTokens(fragments);
}

function estimateToolSchemaTokens(tools: ToolInfo[]): number {
  const fragments: string[] = [];
  for (const tool of tools) {
    fragments.push(tool.name, tool.description ?? "");
    try {
      fragments.push(JSON.stringify(tool.parameters ?? {}));
    } catch {
      // Unserializable schema — skip.
    }
  }
  return countTokens(fragments);
}

// ---- Breakdown ---------------------------------------------------------------

function computeContextBreakdown(ctx: ExtensionCommandContext, pi: ExtensionAPI): ContextBreakdown {
  const model = ctx.model;
  const contextWindow = model?.contextWindow ?? 0;

  const { messages } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  let messagesTokens = 0;
  for (const message of messages) {
    messagesTokens += estimateTokens(message);
  }

  const options = ctx.getSystemPromptOptions();
  const skills = options.skills ?? [];
  const skillsTokens = estimateSkillsTokens(skills);
  const contextFiles = options.contextFiles ?? [];
  const systemContextTokens = countTokens(contextFiles.map((file) => file.content));
  const systemPromptTokens = Math.max(0, countTokens([ctx.getSystemPrompt()]) - skillsTokens - systemContextTokens);

  const selectedTools = options.selectedTools;
  const allTools = pi.getAllTools();
  const tools = selectedTools ? allTools.filter((tool) => selectedTools.includes(tool.name)) : allTools;
  const toolsTokens = estimateToolSchemaTokens(tools);

  const categories: Category[] = [
    { id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens, color: "accent", glyph: CELL_FILLED },
    { id: "systemTools", label: "System tools", tokens: toolsTokens, color: "warning", glyph: CELL_FILLED },
    { id: "systemContext", label: "System context", tokens: systemContextTokens, color: "customMessageLabel", glyph: CELL_FILLED },
    { id: "skills", label: "Skills", tokens: skillsTokens, color: "success", glyph: CELL_FILLED },
    { id: "messages", label: "Messages", tokens: messagesTokens, color: "userMessageText", glyph: CELL_FILLED_MESSAGES },
  ];
  const usedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);

  let autoCompactBufferTokens = 0;
  if (contextWindow > 0 && DEFAULT_COMPACTION_SETTINGS.enabled) {
    autoCompactBufferTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  }
  autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));
  const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

  return {
    contextWindow,
    modelName: model?.name ?? model?.id ?? "no model",
    modelId: model?.id ?? "unknown",
    categories,
    usedTokens,
    autoCompactBufferTokens,
    freeTokens,
  };
}

// ---- Number formatting (verbatim from oh-my-pi) ------------------------------

function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function formatNumber(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1e4) return `${trim1(n / 1000)}K`;
  if (n < 1e6) return `${Math.round(n / 1000)}K`;
  if (n < 1e7) return `${trim1(n / 1e6)}M`;
  if (n < 1e9) return `${Math.round(n / 1e6)}M`;
  if (n < 1e10) return `${trim1(n / 1e9)}B`;
  return `${Math.round(n / 1e9)}B`;
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(fractionDigits)}%`;
}

// ---- Grid + legend rendering (verbatim from oh-my-pi) ------------------------

function planCells(breakdown: ContextBreakdown): Cell[] {
  const cells: Cell[] = [];
  const window = breakdown.contextWindow;
  if (window <= 0) {
    for (let i = 0; i < GRID_CELLS; i++) {
      cells.push({ glyph: CELL_FREE, color: "dim" });
    }
    return cells;
  }
  const tokensPerCell = window / GRID_CELLS;
  const ratioCells = (tokens: number): number => {
    if (tokens <= 0) return 0;
    return Math.max(1, Math.round(tokens / tokensPerCell));
  };
  const categoryCounts = breakdown.categories.map((category) => ({
    category,
    count: ratioCells(category.tokens),
  }));
  let bufferCount = ratioCells(breakdown.autoCompactBufferTokens);
  let usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
  const maxUsable = GRID_CELLS - bufferCount;
  if (usedCount > maxUsable) {
    let overflow = usedCount - maxUsable;
    const order = [...categoryCounts].sort((a, b) => b.count - a.count);
    for (const entry of order) {
      while (overflow > 0 && entry.count > 1) {
        entry.count -= 1;
        overflow -= 1;
      }
    }
    usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
    if (usedCount + bufferCount > GRID_CELLS) {
      bufferCount = Math.max(0, GRID_CELLS - usedCount);
    }
  }
  for (const { category, count } of categoryCounts) {
    for (let i = 0; i < count; i++) {
      cells.push({ glyph: category.glyph, color: category.color });
    }
  }
  const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
  for (let i = 0; i < freeCount; i++) {
    cells.push({ glyph: CELL_FREE, color: "dim" });
  }
  for (let i = 0; i < bufferCount; i++) {
    cells.push({ glyph: CELL_BUFFER, color: "warning" });
  }
  while (cells.length < GRID_CELLS) {
    cells.push({ glyph: CELL_FREE, color: "dim" });
  }
  return cells.slice(0, GRID_CELLS);
}

function buildLegendLines(breakdown: ContextBreakdown, theme: Theme): string[] {
  const lines: string[] = [];
  const { contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens } = breakdown;
  const windowLabel = formatNumber(contextWindow).toLowerCase();
  lines.push(theme.bold(`${breakdown.modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
  lines.push(theme.fg("muted", `${breakdown.modelId}[${windowLabel}]`));
  lines.push(
    `${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}` +
      theme.fg("muted", ` (${percentString(usedTokens, contextWindow)})`),
  );
  lines.push("");
  lines.push(theme.fg("muted", "Estimated usage by category"));
  for (const category of categories) {
    const dot = theme.fg(category.color, category.glyph);
    const tokens = formatNumber(category.tokens);
    const pct = percentString(category.tokens, contextWindow);
    lines.push(`${dot} ${category.label}: ${theme.bold(tokens)} ${theme.fg("dim", `tokens (${pct})`)}`);
  }
  const freeDot = theme.fg("dim", CELL_FREE);
  lines.push(
    `${freeDot} Free space: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`,
  );
  if (autoCompactBufferTokens > 0) {
    const bufferDot = theme.fg("warning", CELL_BUFFER);
    lines.push(
      `${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg("dim", `tokens (${percentString(autoCompactBufferTokens, contextWindow)})`)}`,
    );
  }
  return lines;
}

function renderContextUsage(breakdown: ContextBreakdown, theme: Theme): string {
  if (breakdown.contextWindow <= 0) {
    return theme.fg("muted", "Context usage is unavailable: no model is selected for this session.");
  }
  const cells = planCells(breakdown);
  const legend = buildLegendLines(breakdown, theme);
  const totalLines = Math.max(GRID_ROWS, legend.length);
  const lines: string[] = [];
  for (let row = 0; row < totalLines; row++) {
    let gridSegment = "";
    if (row < GRID_ROWS) {
      const rowCells: string[] = [];
      for (let col = 0; col < GRID_COLS; col++) {
        const cell = cells[row * GRID_COLS + col];
        if (cell) rowCells.push(theme.fg(cell.color, cell.glyph));
      }
      gridSegment = rowCells.join(" ");
    } else {
      gridSegment = " ".repeat(GRID_COLS * 2 - 1);
    }
    const legendSegment = legend[row] ?? "";
    const line = legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
    lines.push(line);
  }
  return lines.join("\n");
}

// ---- Panel + one-line fallback ----------------------------------------------

function renderPanel(breakdown: ContextBreakdown, theme: Theme): Component {
  // Pass an explicit color fn: DynamicBorder's default reads the global theme,
  // which is not initialized in jiti-loaded extension module instances.
  const border = () => new DynamicBorder((str) => theme.fg("border", str));
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(border());
  container.addChild(new Text(theme.bold(theme.fg("accent", "Context Usage")), 1, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(renderContextUsage(breakdown, theme), 1, 0));
  container.addChild(border());
  return container;
}

/** Plain-text one-liner for non-TUI modes and minimal LLM footprint. */
function plainSummary(breakdown: ContextBreakdown): string {
  const windowLabel = formatNumber(breakdown.contextWindow).toLowerCase();
  return `Context usage: ${formatNumber(breakdown.usedTokens)}/${windowLabel} tokens (${percentString(breakdown.usedTokens, breakdown.contextWindow)})`;
}

// ---- Extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer<ContextBreakdown>("context-usage", (message, _options: MessageRenderOptions, theme) => {
    const breakdown = message.details;
    if (!breakdown) return undefined;
    return renderPanel(breakdown, theme);
  });

  pi.registerCommand("context", {
    description: "Show context window usage breakdown",
    handler: async (_args, ctx) => {
      const breakdown = computeContextBreakdown(ctx, pi);
      if (breakdown.contextWindow <= 0) {
        ctx.ui.notify("Context usage is unavailable: no model is selected for this session.", "warning");
        return;
      }
      pi.sendMessage<ContextBreakdown>({
        customType: "context-usage",
        content: plainSummary(breakdown),
        display: true,
        details: breakdown,
      });
    },
  });
}
