import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";
const POWERLINE = "";
const SOFT_SEPARATOR = "";
const PI_LOGO = "";
const GIT_BRANCH = "";
const CONTEXT_ICON = "";
const DIRECTORY_ICON = "";
const EFFORT_ICON = "⚙";
const MODEL_ICON = "󰚩";
const ELLIPSIS = "…";

const PALETTE = {
  deepBlue: "#0082b3",
  titaniumGold: "#d4c090",
  brightAluminum: "#e8ecf4",
  brushedTitanium: "#151820",
  subtleGray: "#2a3038",
  dimAluminum: "#9ca3b0",
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
  slate: "#334155",
  black: "#020617",
  white: "#f8fafc",
} as const;

type HexColor = typeof PALETTE[keyof typeof PALETTE];

type SegmentVariant = "full" | "compact" | "tiny";

interface PowerlineSegment {
  key: string;
  full: string;
  compact: string;
  tiny: string;
  fg: HexColor;
  bg: HexColor;
  priority: number;
}

interface ContextMetrics {
  usedTokens: number | null;
  maxTokens: number;
  percent: number | null;
}

interface SegmentStyle {
  fg: HexColor;
  bg: HexColor;
}

function fg(color: HexColor): string {
  const { r, g, b } = hexToRgb(color);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg(color: HexColor): string {
  const { r, g, b } = hexToRgb(color);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function styleSegment(text: string, segment: Pick<PowerlineSegment, "fg" | "bg">): string {
  return `${fg(segment.fg)}${bg(segment.bg)}${text}${FG_RESET}${BG_RESET}`;
}

function styleSeparator(previousBg: HexColor, nextBg: HexColor | undefined): string {
  if (nextBg) return `${fg(previousBg)}${bg(nextBg)}${POWERLINE}${FG_RESET}${BG_RESET}`;
  return `${fg(previousBg)}${POWERLINE}${FG_RESET}`;
}

function variantText(segment: PowerlineSegment, variant: SegmentVariant): string {
  return segment[variant];
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value < 10_000) return Math.round(value).toLocaleString("en-US");
  if (value < 1_000_000) {
    const scaled = value / 1_000;
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const scaled = value / 1_000_000;
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}M`;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--%";
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`;
}

function sanitizeInline(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatDirectory(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = path.resolve(home);
  const relativeToHome = path.relative(resolvedHome, resolvedCwd);
  const insideHome = relativeToHome === ""
    || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome));
  return insideHome ? (relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`) : cwd;
}

function basenameForCompactDir(cwd: string): string {
  const base = path.basename(cwd);
  return base || cwd;
}

function sessionBadgeText(ctx: ExtensionContext | undefined): string | undefined {
  const fromSession = ctx?.sessionManager.getSessionName();
  if (!fromSession) return undefined;
  const title = sanitizeInline(fromSession);
  return title || undefined;
}

function thinkingLevelFromEntries(ctx: ExtensionContext | undefined, fallback: string): string {
  if (!ctx) return fallback;
  for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
    if (entry.type === "thinking_level_change" && "thinkingLevel" in entry && typeof entry.thinkingLevel === "string") {
      return entry.thinkingLevel;
    }
  }
  return fallback;
}

function contextMetrics(ctx: ExtensionContext | undefined): ContextMetrics {
  const usage = ctx?.getContextUsage();
  const maxTokens = usage?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
  const usedTokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? (usedTokens !== null && maxTokens > 0 ? (usedTokens / maxTokens) * 100 : null);
  return { usedTokens, maxTokens, percent };
}

function contextPercentStyle(metrics: ContextMetrics): SegmentStyle {
  const percent = metrics.percent ?? 0;
  if (percent >= 50) return { fg: PALETTE.white, bg: PALETTE.red };
  if (percent > 30) return { fg: PALETTE.black, bg: PALETTE.yellow };
  return { fg: PALETTE.black, bg: PALETTE.green };
}

function buildSegments(
  ctx: ExtensionContext | undefined,
  footerData: ReadonlyFooterDataProvider,
  latestThinkingLevel: string,
): PowerlineSegment[] {
  const cwd = ctx?.sessionManager.getCwd() ?? ctx?.cwd ?? process.cwd();
  const model = ctx?.model;
  const modelName = model?.id ?? "no-model";
  const effort = model?.reasoning ? thinkingLevelFromEntries(ctx, latestThinkingLevel) : "off";
  const branch = footerData.getGitBranch();
  const metrics = contextMetrics(ctx);
  const percentStyle = contextPercentStyle(metrics);
  const used = metrics.usedTokens === null ? "?" : formatTokens(metrics.usedTokens);
  const max = metrics.maxTokens > 0 ? formatTokens(metrics.maxTokens) : "?";
  const pct = formatPercent(metrics.percent);

  const segments: PowerlineSegment[] = [
    {
      key: "pi",
      full: ` ${PI_LOGO} `,
      compact: ` ${PI_LOGO} `,
      tiny: ` ${PI_LOGO} `,
      fg: PALETTE.white,
      bg: PALETTE.deepBlue,
      priority: 30,
    },
    {
      key: "model",
      full: ` ${MODEL_ICON} ${modelName} `,
      compact: ` ${truncateToWidth(modelName, 18, ELLIPSIS)} `,
      tiny: ` ${truncateToWidth(modelName, 8, ELLIPSIS)} `,
      fg: PALETTE.black,
      bg: PALETTE.titaniumGold,
      priority: 10,
    },
    {
      key: "effort",
      full: ` ${EFFORT_ICON} ${effort} `,
      compact: ` ${EFFORT_ICON} ${effort} `,
      tiny: ` ${effort.slice(0, 1) || "?"} `,
      fg: PALETTE.black,
      bg: PALETTE.brightAluminum,
      priority: 15,
    },
    {
      key: "directory",
      full: ` ${DIRECTORY_ICON} ${formatDirectory(cwd)} `,
      compact: ` ${DIRECTORY_ICON} ${basenameForCompactDir(cwd)} `,
      tiny: ` ${basenameForCompactDir(cwd)} `,
      fg: PALETTE.black,
      bg: PALETTE.dimAluminum,
      priority: 25,
    },
  ];

  if (branch) {
    segments.push({
      key: "branch",
      full: ` ${GIT_BRANCH} ${branch} `,
      compact: ` ${GIT_BRANCH} ${truncateToWidth(branch, 18, ELLIPSIS)} `,
      tiny: ` ${GIT_BRANCH} `,
      fg: PALETTE.white,
      bg: PALETTE.subtleGray,
      priority: 20,
    });
  }

  segments.push(
    {
      key: "context-tokens",
      full: ` ${CONTEXT_ICON} ${used}/${max} `,
      compact: ` ${CONTEXT_ICON} ${used}/${max} `,
      tiny: ` ${used}/${max} `,
      fg: PALETTE.white,
      bg: PALETTE.brushedTitanium,
      priority: 0,
    },
    {
      key: "context-percent",
      full: ` ${pct} `,
      compact: ` ${pct} `,
      tiny: ` ${pct} `,
      fg: percentStyle.fg,
      bg: percentStyle.bg,
      priority: 0,
    },
  );

  return segments;
}

function renderSegments(segments: PowerlineSegment[], width: number): string {
  const variants: SegmentVariant[] = ["full", "compact", "tiny"];
  let visibleSegments = [...segments];

  for (const variant of variants) {
    const rendered = renderSegmentsWithVariant(visibleSegments, variant);
    if (visibleWidth(rendered) <= width) return rendered;
  }

  for (const segment of [...visibleSegments].sort((a, b) => b.priority - a.priority)) {
    if (segment.priority === 0) continue;
    visibleSegments = visibleSegments.filter((candidate) => candidate.key !== segment.key);
    const rendered = renderSegmentsWithVariant(visibleSegments, "tiny");
    if (visibleWidth(rendered) <= width) return rendered;
  }

  return truncateToWidth(renderSegmentsWithVariant(visibleSegments, "tiny"), width, "");
}

function renderSegmentsWithVariant(segments: PowerlineSegment[], variant: SegmentVariant): string {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    return styleSegment(variantText(segment, variant), segment) + styleSeparator(segment.bg, next?.bg);
  }).join("") + RESET;
}

function renderSessionBadge(title: string | undefined, width: number): string {
  if (!title) return "";
  const maxTitleWidth = width - 3; // surrounding spaces plus trailing powerline separator.
  if (maxTitleWidth < 1) return "";
  const text = truncateToWidth(title, maxTitleWidth, ELLIPSIS);
  const segment: PowerlineSegment = {
    key: "session-badge",
    full: ` ${text} `,
    compact: ` ${text} `,
    tiny: ` ${text} `,
    fg: PALETTE.white,
    bg: PALETTE.slate,
    priority: 0,
  };
  return renderSegments([segment], width);
}

function renderFooterLine(segments: PowerlineSegment[], sessionBadge: string | undefined, width: number): string {
  const right = renderSessionBadge(sessionBadge, width);
  if (!right) return renderSegments(segments, width);

  const rightWidth = visibleWidth(right);
  const leftBudget = Math.max(0, width - rightWidth - 1);
  const left = leftBudget > 0 ? renderSegments(segments, leftBudget) : "";
  const spacerWidth = Math.max(0, width - visibleWidth(left) - rightWidth);
  return `${left}${" ".repeat(spacerWidth)}${right}`;
}

export class PowerlineFooterComponent implements Component {
  constructor(
    private readonly getContext: () => ExtensionContext | undefined,
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly theme: Theme,
    private readonly getThinkingLevel: () => string,
  ) {}

  invalidate(): void {
    // Rendering is derived from live session state, so there is no cache to clear.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const ctx = this.getContext();
    const sessionBadge = sessionBadgeText(ctx);
    const segments = buildSegments(ctx, this.footerData, this.getThinkingLevel());
    const lines = [renderFooterLine(segments, sessionBadge, safeWidth)];

    const statuses = this.footerData.getExtensionStatuses();
    if (statuses.size > 0) {
      const statusLine = Array.from(statuses.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => sanitizeInline(text))
        .join(` ${SOFT_SEPARATOR} `);
      lines.push(truncateToWidth(this.theme.fg("dim", statusLine), safeWidth, this.theme.fg("dim", ELLIPSIS)));
    }

    return lines;
  }
}

export default function tuiPowerlineExtension(pi: ExtensionAPI): void {
  let latestContext: ExtensionContext | undefined;
  let latestThinkingLevel = "default";

  const rememberContext = (ctx: ExtensionContext): void => {
    if (ctx.mode === "tui") latestContext = ctx;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    rememberContext(ctx);
    ctx.ui.setFooter((_tui, theme, footerData) => new PowerlineFooterComponent(
      () => latestContext,
      footerData,
      theme,
      () => latestThinkingLevel,
    ));
    const title = sessionBadgeText(ctx);
    if (title) ctx.ui.setTitle(title);
  });

  pi.on("model_select", (_event, ctx) => {
    rememberContext(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    latestThinkingLevel = event.level;
    rememberContext(ctx);
  });

  pi.on("context", (_event, ctx) => { rememberContext(ctx); });
  pi.on("message_end", (_event, ctx) => { rememberContext(ctx); });
  pi.on("agent_end", (_event, ctx) => { rememberContext(ctx); });
  pi.on("input", (_event, ctx) => { rememberContext(ctx); });
  pi.on("session_tree", (_event, ctx) => { rememberContext(ctx); });
  pi.on("session_compact", (_event, ctx) => { rememberContext(ctx); });

  pi.on("session_shutdown", () => {
    latestContext = undefined;
  });
}
