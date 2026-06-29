/**
 * The pinned bottom status strip (1–2 rows) — the redesigned sub-agent panel.
 *
 * Replaces the old half-screen bordered box with a always-visible status bar
 * (vim/lazygit/tmux style): a symbol row covering every channel, the selected
 * channel's name + position + live status, a scroll indicator, and an
 * always-visible controls line so a first-time user needs no documentation.
 *
 * Three orthogonal visual axes keep status, selection, and unread legible at
 * once (the old panel overloaded selection onto the glyph): status → glyph
 * shape + color, selected → inverse video, unread → underline. Status stays
 * distinguishable with color off (the glyph shapes differ), so it is
 * colorblind-safe.
 *
 * Pure and width-bounded, so the smoke harness can verify it headlessly.
 *
 * @see ./scrollback.ts#composeFrame which pins these rows at the bottom.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentState } from "./registry.ts";

export type ChannelKind = "main" | SubagentState;
/** Refines the glyph for a running channel (from the registry phase/tool). */
export type ChannelActivity = "reasoning" | "writing" | "tool" | "idle";

export interface StripChannel {
  kind: ChannelKind;
  activity: ChannelActivity;
  selected: boolean;
  hasNewOutput: boolean;
}

export interface StripModel {
  /** Channel 0 is always the main agent, followed by sub-agents in order. */
  channels: StripChannel[];
  selectedIndex: number;
  /** Session name of the selected channel (`task.description`, or "main"). */
  selectedLabel: string;
  /** Live status word for the selected channel, e.g. "reasoning" / "using read". */
  selectedStatus: string;
  /** Animate the spinner (selected channel is actively working). */
  spinner: boolean;
  /** Spinner frame index (caller advances it; keeps this module pure). */
  spinnerFrame: number;
  scrolledUp: boolean;
  /** 0–100, how far from the top the viewport sits (for the ▲ N% readout). */
  percent: number;
  /** Lines hidden below the viewport (for the "N below" readout). */
  linesBelow: number;
  /** Use ASCII glyphs (no-Unicode terminals). */
  ascii: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_ASCII = ["|", "/", "-", "\\"];

const DIVIDER = "┊";
const DIVIDER_ASCII = "|";

interface Glyph {
  ch: string;
  ascii: string;
  tone: "text" | "accent" | "success" | "error" | "warning" | "muted" | "dim";
}

function glyphFor(channel: StripChannel): Glyph {
  switch (channel.kind) {
    case "main":
      return { ch: "⌂", ascii: "M", tone: "text" };
    case "pending":
      return { ch: "◌", ascii: ".", tone: "dim" };
    case "done":
      return { ch: "✓", ascii: "v", tone: "success" };
    case "error":
      return { ch: "✗", ascii: "x", tone: "error" };
    default:
      // running — refine by activity.
      switch (channel.activity) {
        case "reasoning":
          return { ch: "◍", ascii: "?", tone: "accent" };
        case "writing":
          return { ch: "◆", ascii: ">", tone: "warning" };
        case "tool":
          return { ch: "◉", ascii: "*", tone: "warning" };
        default:
          return { ch: "●", ascii: "o", tone: "warning" };
      }
  }
}

/** Style one channel glyph: tone color + inverse (selected) + underline (unread). */
function styleGlyph(channel: StripChannel, theme: Theme, ascii: boolean): string {
  const glyph = glyphFor(channel);
  let out = theme.fg(glyph.tone, ascii ? glyph.ascii : glyph.ch);
  if (channel.hasNewOutput && typeof theme.underline === "function") out = theme.underline(out);
  if (channel.selected) out = inverse(out, theme, ascii, glyph, channel);
  return out;
}

/** Selection marker: inverse video, or `[g]` brackets when inverse is unavailable/ASCII. */
function inverse(styled: string, theme: Theme, ascii: boolean, glyph: Glyph, channel: StripChannel): string {
  if (!ascii && typeof theme.inverse === "function") return theme.inverse(styled);
  return `${theme.fg("accent", "[")}${theme.fg(glyph.tone, ascii ? glyph.ascii : glyph.ch)}${theme.fg("accent", "]")}`;
}

function spinnerGlyph(model: StripModel): string {
  const frames = model.ascii ? SPINNER_ASCII : SPINNER;
  return frames[((model.spinnerFrame % frames.length) + frames.length) % frames.length] ?? frames[0]!;
}

/**
 * Render the strip into `rows` lines (1 or 2). Every line is guaranteed to fit
 * `width` columns. Row order: status line, then (for 2 rows) the controls line.
 */
export function renderStrip(model: StripModel, width: number, theme: Theme, rows: 1 | 2): string[] {
  const ascii = model.ascii;
  const div = theme.fg("border", ascii ? DIVIDER_ASCII : DIVIDER);

  // Symbol row: main, divider, then one glyph per sub-agent.
  const symbols: string[] = [];
  model.channels.forEach((channel, i) => {
    symbols.push(styleGlyph(channel, theme, ascii));
    if (i === 0) symbols.push(div); // separate the main "home" channel from the fleet
  });
  const symbolRow = symbols.join(" ");

  const position = `${model.selectedIndex + 1}/${model.channels.length}`;
  const name = model.selectedLabel ? truncateToWidth(model.selectedLabel, 24, "…", true) : "";
  const nameField = name ? `${theme.fg("accent", ascii ? "<" : "‹")}${theme.bold(name)}${theme.fg("accent", ascii ? ">" : "›")}` : "";

  const spin = model.spinner ? ` ${theme.fg("warning", spinnerGlyph(model))}` : "";
  const status = model.selectedStatus ? `${theme.fg("muted", model.selectedStatus)}${spin}` : "";
  const positionField = theme.fg("dim", position);
  const scrollFull = model.scrolledUp
    ? theme.fg("warning", `${ascii ? "^" : "▲"} ${model.percent}%`)
    : theme.fg("success", `${ascii ? "*" : "●"} live`);
  const scrollShort = model.scrolledUp ? theme.fg("warning", ascii ? "^" : "▲") : theme.fg("success", ascii ? "*" : "●");

  // Degrade by dropping the lowest-priority field first; the symbol row and
  // position indicator are never dropped (see the design's width budget).
  const join = (parts: string[]): string => parts.filter(Boolean).join("  ");
  const candidates = [
    { left: join([symbolRow, nameField, positionField, status]), right: scrollFull },
    { left: join([symbolRow, positionField, status]), right: scrollFull }, // drop name
    { left: join([symbolRow, positionField, status]), right: scrollShort }, // drop scroll text
    { left: join([symbolRow, positionField]), right: scrollShort }, // drop status word
  ];
  let chosen = candidates[candidates.length - 1]!;
  for (const candidate of candidates) {
    if (visibleWidth(candidate.left) + visibleWidth(candidate.right) + 1 <= width) {
      chosen = candidate;
      break;
    }
  }
  const statusLine = padBetween(chosen.left, chosen.right, width);

  if (rows === 1) return [statusLine];
  return [statusLine, controlsLine(width, theme)];
}

/** The always-visible controls hint (self-documenting for first-time users). */
function controlsLine(width: number, theme: Theme): string {
  const hint = theme.fg("dim", ["PgUp/PgDn scroll", "alt+]/[ switch", "alt+l live"].join(" · "));
  // Compact fallback when the full hint can't fit.
  if (visibleWidth(hint) > width) {
    return truncateToWidth(theme.fg("dim", "PgUp/PgDn scroll · alt+]/[ switch"), width, "…", true);
  }
  return hint;
}

/** Left/right justify two segments within `width`, ANSI-aware. */
function padBetween(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + rw + 1 > width) return truncateToWidth(left, width, "…", true);
  return left + " ".repeat(width - lw - rw) + right;
}

/**
 * The loud "viewing history" banner shown on the bottom window row while
 * scrolled off the live tail. Full-width inverse bar so it's impossible to miss.
 */
export function bannerLine(linesBelow: number, width: number, theme: Theme, ascii = false): string {
  const arrow = ascii ? "vv" : "▼▼";
  const label = ` ${arrow} VIEWING HISTORY — ${linesBelow} line${linesBelow === 1 ? "" : "s"} below · End → latest ${arrow} `;
  const padded = centerPad(label, width);
  const styler = typeof theme.inverse === "function" ? (s: string) => theme.inverse(theme.fg("warning", s)) : (s: string) => theme.fg("warning", s);
  return styler(padded);
}

function centerPad(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return truncateToWidth(text, width, "…", true);
  const leftPad = Math.floor((width - w) / 2);
  return " ".repeat(leftPad) + text + " ".repeat(width - w - leftPad);
}
