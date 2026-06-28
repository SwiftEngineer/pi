import {
  DEFAULT_COMPACTION_SETTINGS,
  DynamicBorder,
  buildSessionContext,
  estimateTokens,
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
  type ThemeColor,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";
const CONTEXT_MESSAGE_TYPE = "context-usage";

const CELL_FILLED = "⛁";
const CELL_FILLED_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

interface ContextModelInfo {
  id?: string;
  name?: string;
}

interface ContextUsageMessageDetails {
  model: ContextModelInfo | null;
  contextWindow: number;
  categories: CategoryInfo[];
  usedTokens: number;
  autoCompactBufferTokens: number;
  freeTokens: number;
}

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
  id: CategoryId;
  label: string;
  tokens: number;
  color: ThemeColor;
  glyph: string;
}

export interface ContextBreakdown {
  model: ContextModelInfo | null | undefined;
  contextWindow: number;
  categories: CategoryInfo[];
  usedTokens: number;
  autoCompactBufferTokens: number;
  freeTokens: number;
}

interface CellSpec {
  glyph: string;
  color: ThemeColor;
}

interface MessageTokenEstimate {
  tokens: number;
}

function estimateTextTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateJsonTokens(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return estimateTextTokens(json ?? "");
  } catch {
    return 0;
  }
}

function estimateToolSchemaTokens(tools: readonly ToolInfo[]): number {
  let tokens = 0;
  for (const tool of tools) {
    tokens += estimateTextTokens(tool.name);
    tokens += estimateTextTokens(tool.description);
    tokens += estimateJsonTokens(tool.parameters);
    for (const guideline of tool.promptGuidelines ?? []) {
      tokens += estimateTextTokens(guideline);
    }
  }
  return tokens;
}

function activeTools(pi: ExtensionAPI): ToolInfo[] {
  const activeNames = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => activeNames.has(tool.name));
}

function estimateContextFileTokens(options: BuildSystemPromptOptions): number {
  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length === 0) return 0;

  let text = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const contextFile of contextFiles) {
    text += `<project_instructions path="${contextFile.path}">\n${contextFile.content}\n</project_instructions>\n\n`;
  }
  text += "</project_context>\n";
  return estimateTextTokens(text);
}

function estimateMessageTokens(ctx: ExtensionCommandContext): MessageTokenEstimate {
  try {
    const sessionContext = buildSessionContext(ctx.sessionManager.getBranch());
    let tokens = 0;
    for (const message of sessionContext.messages) {
      tokens += estimateTokens(message);
    }
    return { tokens };
  } catch {
    return { tokens: 0 };
  }
}

function computeAutoCompactBufferTokens(contextWindow: number, usedTokens: number): number {
  if (contextWindow <= 0) return 0;
  const reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  return Math.min(reserveTokens, Math.max(0, contextWindow - usedTokens));
}

export function computeContextBreakdown(ctx: ExtensionCommandContext, pi: ExtensionAPI): ContextBreakdown {
  const model = ctx.model;
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
  const options = ctx.getSystemPromptOptions();

  const skillsTokens = estimateTextTokens(formatSkillsForPrompt(options.skills ?? []));
  const systemContextTokens = estimateContextFileTokens(options);
  const systemToolsTokens = estimateToolSchemaTokens(activeTools(pi));
  const systemPromptTotalTokens = estimateTextTokens(ctx.getSystemPrompt());
  const systemPromptTokens = Math.max(0, systemPromptTotalTokens - skillsTokens - systemContextTokens);

  const nonMessageTokens = skillsTokens + systemToolsTokens + systemContextTokens + systemPromptTokens;
  const estimatedMessageTokens = estimateMessageTokens(ctx).tokens;
  const providerTokens = usage?.tokens ?? null;
  const messagesTokens = providerTokens === null
    ? estimatedMessageTokens
    : Math.max(0, providerTokens - nonMessageTokens);
  const usedTokens = providerTokens === null
    ? nonMessageTokens + messagesTokens
    : Math.max(providerTokens, nonMessageTokens + messagesTokens);

  const autoCompactBufferTokens = computeAutoCompactBufferTokens(contextWindow, usedTokens);
  const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

  const categories: CategoryInfo[] = [
    { id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens, color: "accent", glyph: CELL_FILLED },
    { id: "systemTools", label: "System tools", tokens: systemToolsTokens, color: "warning", glyph: CELL_FILLED },
    {
      id: "systemContext",
      label: "System context",
      tokens: systemContextTokens,
      color: "customMessageLabel",
      glyph: CELL_FILLED,
    },
    { id: "skills", label: "Skills", tokens: skillsTokens, color: "success", glyph: CELL_FILLED },
    {
      id: "messages",
      label: "Messages",
      tokens: messagesTokens,
      color: "userMessageText",
      glyph: CELL_FILLED_MESSAGES,
    },
  ];

  return { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens };
}

function trimTrailingZeroes(value: string): string {
  return value.replace(/\.0$/, "");
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimTrailingZeroes((value / 1_000_000_000).toFixed(1))}B`;
  if (abs >= 1_000_000) return `${trimTrailingZeroes((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${trimTrailingZeroes((value / 1_000).toFixed(abs >= 100_000 ? 0 : 1))}K`;
  return String(value);
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(fractionDigits)}%`;
}

function planCells(breakdown: ContextBreakdown): CellSpec[] {
  const cells: CellSpec[] = [];
  const window = breakdown.contextWindow;

  if (window <= 0) {
    for (let i = 0; i < GRID_CELLS; i++) cells.push({ glyph: CELL_FREE, color: "dim" });
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
  let usedCount = categoryCounts.reduce((sum, category) => sum + category.count, 0);
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
    usedCount = categoryCounts.reduce((sum, category) => sum + category.count, 0);
    if (usedCount + bufferCount > GRID_CELLS) bufferCount = Math.max(0, GRID_CELLS - usedCount);
  }

  for (const { category, count } of categoryCounts) {
    for (let i = 0; i < count; i++) cells.push({ glyph: category.glyph, color: category.color });
  }

  const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
  for (let i = 0; i < freeCount; i++) cells.push({ glyph: CELL_FREE, color: "dim" });
  for (let i = 0; i < bufferCount; i++) cells.push({ glyph: CELL_BUFFER, color: "warning" });
  while (cells.length < GRID_CELLS) cells.push({ glyph: CELL_FREE, color: "dim" });
  return cells.slice(0, GRID_CELLS);
}

function buildLegendLines(breakdown: ContextBreakdown, theme: Theme): string[] {
  const lines: string[] = [];
  const { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens } = breakdown;
  const modelName = model?.name ?? model?.id ?? "no model";
  const modelId = model?.id ?? "unknown";
  const windowLabel = formatNumber(contextWindow).toLowerCase();

  lines.push(theme.bold(`${modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
  lines.push(theme.fg("muted", `${modelId}[${windowLabel}]`));
  lines.push(
    `${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}`
      + theme.fg("muted", ` (${percentString(usedTokens, contextWindow)})`),
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
  lines.push(`${freeDot} Free space: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`);

  if (autoCompactBufferTokens > 0) {
    const bufferDot = theme.fg("warning", CELL_BUFFER);
    lines.push(
      `${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg(
        "dim",
        `tokens (${percentString(autoCompactBufferTokens, contextWindow)})`,
      )}`,
    );
  }

  return lines;
}

export function renderContextUsage(breakdown: ContextBreakdown, theme: Theme): string {
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

function renderContextUsagePlainText(breakdown: ContextBreakdown): string {
  if (breakdown.contextWindow <= 0) return "Context usage is unavailable: no model is selected for this session.";
  const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
  const lines = [`Context window: ${breakdown.contextWindow} tokens (${usedPct}% used)`];
  for (const category of breakdown.categories) {
    if (category.tokens === 0) continue;
    const fraction = category.tokens / breakdown.contextWindow;
    const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * 24);
    lines.push(`  ${category.label.padEnd(16)} [${"█".repeat(filled)}${"░".repeat(24 - filled)}]  ${category.tokens} tokens`);
  }
  if (breakdown.autoCompactBufferTokens > 0) {
    const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
    const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * 24);
    lines.push(`  ${"Auto-compact buf".padEnd(16)} [${"█".repeat(filled)}${"░".repeat(24 - filled)}]  ${breakdown.autoCompactBufferTokens} tokens`);
  }
  if (breakdown.freeTokens > 0) {
    const fraction = breakdown.freeTokens / breakdown.contextWindow;
    const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * 24);
    lines.push(`  ${"Free".padEnd(16)} [${"█".repeat(filled)}${"░".repeat(24 - filled)}]  ${breakdown.freeTokens} tokens`);
  }
  return lines.join("\n");
}

function toContextModelInfo(model: ContextBreakdown["model"]): ContextModelInfo | null {
  if (!model) return null;
  const info: ContextModelInfo = {};
  if (model.id !== undefined) info.id = model.id;
  if (model.name !== undefined) info.name = model.name;
  return info;
}

function toContextUsageMessageDetails(breakdown: ContextBreakdown): ContextUsageMessageDetails {
  return {
    model: toContextModelInfo(breakdown.model),
    contextWindow: breakdown.contextWindow,
    categories: breakdown.categories,
    usedTokens: breakdown.usedTokens,
    autoCompactBufferTokens: breakdown.autoCompactBufferTokens,
    freeTokens: breakdown.freeTokens,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isThemeColor(value: unknown): value is ThemeColor {
  return value === "accent"
    || value === "warning"
    || value === "success"
    || value === "userMessageText"
    || value === "customMessageLabel";
}

function isCategoryId(value: unknown): value is CategoryId {
  return value === "systemPrompt"
    || value === "systemContext"
    || value === "systemTools"
    || value === "skills"
    || value === "messages";
}

function isCategoryInfo(value: unknown): value is CategoryInfo {
  if (typeof value !== "object" || value === null) return false;
  const category = value as Partial<CategoryInfo>;
  return isCategoryId(category.id)
    && typeof category.label === "string"
    && isFiniteNumber(category.tokens)
    && isThemeColor(category.color)
    && typeof category.glyph === "string";
}

function isContextUsageMessageDetails(value: unknown): value is ContextUsageMessageDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as Partial<ContextUsageMessageDetails>;
  const model = details.model;
  const hasValidModel = model === null || (
    typeof model === "object"
    && (model.id === undefined || typeof model.id === "string")
    && (model.name === undefined || typeof model.name === "string")
  );
  return hasValidModel
    && isFiniteNumber(details.contextWindow)
    && Array.isArray(details.categories)
    && details.categories.every(isCategoryInfo)
    && isFiniteNumber(details.usedTokens)
    && isFiniteNumber(details.autoCompactBufferTokens)
    && isFiniteNumber(details.freeTokens);
}

class ContextUsagePanel extends Container {
  constructor(breakdown: ContextUsageMessageDetails, theme: Theme) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.addChild(new Text(theme.bold(theme.fg("accent", "Context Usage")), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(renderContextUsage(breakdown, theme), 1, 0));
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }
}

export default function contextCommandExtension(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ContextUsageMessageDetails>(CONTEXT_MESSAGE_TYPE, (message, _options, theme) => {
    if (!isContextUsageMessageDetails(message.details)) return undefined;
    return new ContextUsagePanel(message.details, theme);
  });

  pi.registerCommand("context", {
    description: "Show estimated context usage breakdown",
    handler: async (_args, ctx) => {
      const breakdown = computeContextBreakdown(ctx, pi);
      if (breakdown.contextWindow <= 0) {
        ctx.ui.notify("Context usage is unavailable: no model is selected for this session.", "warning");
        return;
      }

      if (ctx.mode === "tui") {
        pi.sendMessage<ContextUsageMessageDetails>({
          customType: CONTEXT_MESSAGE_TYPE,
          content: "",
          display: true,
          details: toContextUsageMessageDetails(breakdown),
        });
        return;
      }

      ctx.ui.notify(renderContextUsagePlainText(breakdown), "info");
    },
  });
}
