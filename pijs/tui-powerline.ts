/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/tui-powerline.ts. The powerline SEGMENT / COLOR /
 * SEPARATOR math ports VERBATIM; only the host binding and data sources change,
 * because the Node contract does not map (verified by Phase-5 API recon):
 *
 *  1. `ctx.ui.setFooter((tui,theme,footerData)=>Component)` render-callback DOES
 *     NOT EXIST. Under PiJS `ctx.ui.setFooter(text)` takes a STRING and pushes it
 *     via `pi.ui('setStatus', {statusKey:'footer'})` (fire-and-forget). So we
 *     compute the powerline ANSI string ourselves and PUSH it on each relevant
 *     event. There is no `Component`, no `invalidate`, no render loop.
 *  2. `footerData.getGitBranch()` / `getExtensionStatuses()` DO NOT EXIST. Git
 *     branch is recomputed here from `.git/HEAD` via `node:fs` (sync reads work
 *     in the sandbox). The 2nd extension-status line is DROPPED (no data source).
 *  3. `ctx.model` DOES NOT EXIST and `ctx.getContextUsage()` DOES NOT EXIST.
 *     Model id, thinking level, session name, and the context WINDOW come from
 *     `pi.session('get_state')`. The context window IS exposed (renders e.g.
 *     `1M`), but per-message USED-token usage is NOT, so `used` stays `?` and
 *     the percent stays `--%` while `max` renders correctly (i.e. `?/1M --%`).
 *  4. `thinking_level_select` is NOT a host event — dropped; the effort value is
 *     read from `get_state().thinkingLevel` instead.
 *  5. `truncateToWidth`/`visibleWidth` reimplemented in `./_shared/textwidth.ts`.
 *  6. `process.env.HOME` is EMPTY in the sandbox, so `formatDirectory` cannot
 *     collapse `~` and shows the cwd as-is (graceful, unchanged code path).
 *
 * ⚠ Render caveat: whether the host actually PAINTS a pushed footer string
 * (ANSI included) is only observable in a live interactive TUI (a `-p` run has
 * no footer). The call surface is correct and load-clean; paint needs live
 * verification.
 */
import fs from "node:fs";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "./_shared/textwidth.ts";

const RESET = "\x1b[0m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";
const POWERLINE = "";
const PI_LOGO = "";
const GIT_BRANCH = "";
const CONTEXT_ICON = "";
const DIRECTORY_ICON = "";
const EFFORT_ICON = "⚙";
const MODEL_ICON = "󰚩";
const ELLIPSIS = "…";

/**
 * No terminal width is exposed to extensions at event time, so we render the
 * "full" variant at a large budget and rely on the HOST to clip. FORCED
 * consequence: the powerline's adaptive compact/tiny + priority-drop path is
 * effectively inert here. This cannot be improved without the host exposing a
 * terminal-width field to extensions.
 */
const FOOTER_RENDER_WIDTH = 400;

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

/** Shape of `pi.session('get_state')` fields this footer reads. */
interface SessionState {
  model?: { provider?: string; id?: string; name?: string; contextWindow?: number } | null;
  thinkingLevel?: string;
  sessionName?: string | null;
  contextWindow?: number;
  tokens?: number;
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
  if (!home) return cwd; // sandbox: process.env is empty → cwd shown as-is (degraded)
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

/**
 * Recompute the git branch from `.git/HEAD`, walking up from `cwd` (the Node
 * host's `footerData.getGitBranch()` has no PiJS equivalent). Sync `node:fs`
 * reads are supported in the sandbox. Returns "" when not in a repo.
 */
function gitBranch(cwd: string): string {
  try {
    let dir = path.resolve(cwd || ".");
    for (let i = 0; i < 64; i++) {
      const gitPath = path.join(dir, ".git");
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(gitPath);
      } catch {
        stat = undefined;
      }
      if (stat) {
        let headPath: string;
        if (stat.isDirectory()) {
          headPath = path.join(gitPath, "HEAD");
        } else {
          const content = fs.readFileSync(gitPath, "utf8").trim();
          const m = content.match(/^gitdir:\s*(.+)$/);
          if (!m) return "";
          const gitDir = path.isAbsolute(m[1]!) ? m[1]! : path.resolve(dir, m[1]!);
          headPath = path.join(gitDir, "HEAD");
        }
        const head = fs.readFileSync(headPath, "utf8").trim();
        if (head.startsWith("ref:")) {
          // Symbolic ref. Normal branches are `refs/heads/<name>`; handle exotic
          // symbolic HEADs (e.g. `refs/remotes/origin/x`) generally rather than
          // letting them fall through to `slice(0,7)` → a garbage `"ref: re"`.
          const target = head.slice(4).trim();
          if (target.startsWith("refs/heads/")) return target.slice("refs/heads/".length);
          const stripped = target.startsWith("refs/") ? target.slice("refs/".length) : target;
          return stripped.split("/").pop() || stripped;
        }
        return head.slice(0, 7); // detached HEAD → short sha
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Any fs error → no branch segment.
  }
  return "";
}

function contextMetrics(state: SessionState | null): ContextMetrics {
  // PiJS `get_state` DOES expose the context window (renders e.g. `1M` for glm),
  // but NOT per-message used-token usage — so `used`/`percent` degrade (`?` /
  // `--%`) while `max` renders. Fields are read defensively so a future host
  // that adds used-token usage lights up automatically.
  const maxTokens = state?.contextWindow ?? state?.model?.contextWindow ?? 0;
  const usedTokens = typeof state?.tokens === "number" ? state.tokens : null;
  const percent = usedTokens !== null && maxTokens > 0 ? (usedTokens / maxTokens) * 100 : null;
  return { usedTokens, maxTokens, percent };
}

function contextPercentStyle(metrics: ContextMetrics): SegmentStyle {
  const percent = metrics.percent ?? 0;
  if (percent >= 50) return { fg: PALETTE.white, bg: PALETTE.red };
  if (percent > 30) return { fg: PALETTE.black, bg: PALETTE.yellow };
  return { fg: PALETTE.black, bg: PALETTE.green };
}

function buildSegments(cwd: string, modelName: string, effort: string, branch: string, state: SessionState | null): PowerlineSegment[] {
  const metrics = contextMetrics(state);
  const percentStyle = contextPercentStyle(metrics);
  const used = metrics.usedTokens === null ? "?" : formatTokens(metrics.usedTokens);
  const max = metrics.maxTokens > 0 ? formatTokens(metrics.maxTokens) : "?";
  const pct = formatPercent(metrics.percent);

  const segments: PowerlineSegment[] = [
    { key: "pi", full: ` ${PI_LOGO} `, compact: ` ${PI_LOGO} `, tiny: ` ${PI_LOGO} `, fg: PALETTE.white, bg: PALETTE.deepBlue, priority: 30 },
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
    { key: "context-tokens", full: ` ${CONTEXT_ICON} ${used}/${max} `, compact: ` ${CONTEXT_ICON} ${used}/${max} `, tiny: ` ${used}/${max} `, fg: PALETTE.white, bg: PALETTE.brushedTitanium, priority: 0 },
    { key: "context-percent", full: ` ${pct} `, compact: ` ${pct} `, tiny: ` ${pct} `, fg: percentStyle.fg, bg: percentStyle.bg, priority: 0 },
  );

  return segments;
}

function renderSegmentsWithVariant(segments: PowerlineSegment[], variant: SegmentVariant): string {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    return styleSegment(variantText(segment, variant), segment) + styleSeparator(segment.bg, next?.bg);
  }).join("") + RESET;
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

function sessionBadgeSegment(title: string | undefined): PowerlineSegment | undefined {
  if (!title) return undefined;
  const text = sanitizeInline(title);
  if (!text) return undefined;
  const label = ` ${truncateToWidth(text, 32, ELLIPSIS)} `;
  return { key: "session-badge", full: label, compact: label, tiny: label, fg: PALETTE.white, bg: PALETTE.slate, priority: 5 };
}

/** Build the full powerline footer string from the resolved session state. */
function buildFooterString(cwd: string, state: SessionState | null): string {
  const modelName = state?.model?.id ?? state?.model?.name ?? "no-model";
  const level = state?.thinkingLevel;
  const effort = level && level !== "off" ? level : "off";
  const branch = gitBranch(cwd);
  const segments = buildSegments(cwd, modelName, effort, branch, state);
  const badge = sessionBadgeSegment(state?.sessionName ?? undefined);
  if (badge) segments.push(badge);
  return renderSegments(segments, FOOTER_RENDER_WIDTH);
}

interface PowerlineCtx {
  hasUI?: boolean;
  cwd?: string;
  ui?: { setFooter?: (text: string) => void; setTitle?: (text: string) => void };
}

interface PowerlinePi {
  on: (event: string, handler: (event: unknown, ctx: PowerlineCtx) => unknown) => void;
  session: (op: string, args?: unknown) => Promise<unknown>;
  process?: { cwd?: string };
}

export default function tuiPowerlineExtension(pi: PowerlinePi): void {
  const resolveCwd = (ctx: PowerlineCtx): string => ctx.cwd || pi.process?.cwd || ".";

  const updateFooter = async (ctx: PowerlineCtx): Promise<void> => {
    if (!ctx || !ctx.hasUI || typeof ctx.ui?.setFooter !== "function") return;
    let state: SessionState | null = null;
    try {
      state = (await pi.session("get_state", {})) as SessionState | null;
    } catch {
      state = null;
    }
    try {
      const footer = buildFooterString(resolveCwd(ctx), state);
      ctx.ui.setFooter(footer);
      const title = state?.sessionName ? sanitizeInline(state.sessionName) : "";
      if (title && typeof ctx.ui.setTitle === "function") ctx.ui.setTitle(title);
    } catch {
      // Push is best-effort; never break the host on a footer update.
    }
  };

  // All of these ARE valid host events (§3). `thinking_level_select` is NOT and
  // is dropped (effort now comes from get_state().thinkingLevel).
  for (const event of ["session_start", "model_select", "context", "message_end", "agent_end", "input", "session_tree", "session_compact"]) {
    // Return the promise so the host awaits it and the reactor pumps until
    // `get_state` resolves WITHIN this live event frame (eliminates a possible
    // one-event staleness lag per the "un-awaited continuation only advances on
    // a later frame" semantics). `updateFooter` catches internally, so the
    // returned promise never rejects the handler.
    pi.on(event, (_event, ctx) => updateFooter(ctx));
  }

  pi.on("session_shutdown", () => {
    // Nothing to tear down (no render loop / no timers under the push model).
  });
}
