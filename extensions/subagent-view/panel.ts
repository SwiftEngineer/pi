/**
 * The split-screen panel that renders a live feed of one sub-agent plus a
 * status-symbol row covering every sub-agent (watched / running / finished).
 *
 * Rendering is fully derived from {@link SubagentRegistry} state on each frame,
 * so external code only needs to mutate the registry and call
 * `tui.requestRender()`.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SubagentRegistry, SubagentSnapshot } from "./registry.ts";

/** Minimal structural view of the TUI we need (terminal size + repaint). */
export interface TuiLike {
  readonly terminal: { readonly rows: number; readonly columns: number };
  requestRender(force?: boolean): void;
}

/** Overlay placement/sizing accepted by `ctx.ui.custom`'s `overlayOptions`. */
export interface OverlayPlacement {
  width: `${number}%`;
  maxHeight: `${number}%`;
  anchor: "top-left" | "top-center";
  nonCapturing: true;
  visible: (termWidth: number, termHeight: number) => boolean;
}

export type SplitOrientation = "horizontal" | "vertical";

export interface SplitLayout {
  orientation: SplitOrientation;
  overlay: OverlayPlacement;
  /** Number of rows the panel should render to fill its half. */
  panelHeight: number;
}

/** Below these sizes the panel hides rather than crowd the screen. */
const MIN_COLUMNS = 60;
const MIN_ROWS = 16;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SYM_WATCHED = "◉";
const SYM_ACTIVE = "●";
const SYM_DONE = "✓";
const SYM_ERROR = "✗";

/**
 * Decide split orientation and overlay placement from terminal dimensions.
 *
 * Terminal cells are roughly twice as tall as wide, so a physically landscape
 * window (vertical divider, panel on the left) corresponds to
 * `columns >= rows * 2`; anything taller (including portrait/vertical monitors)
 * uses a horizontal divider with the panel on top.
 */
export function chooseLayout(columns: number, rows: number, allowVertical: boolean): SplitLayout {
  const wide = allowVertical && columns >= rows * 2;
  const visible = (termWidth: number, termHeight: number): boolean =>
    termWidth >= MIN_COLUMNS && termHeight >= MIN_ROWS;

  if (wide) {
    return {
      orientation: "vertical",
      overlay: { width: "50%", maxHeight: "100%", anchor: "top-left", nonCapturing: true, visible },
      panelHeight: Math.max(MIN_ROWS, rows),
    };
  }
  return {
    orientation: "horizontal",
    overlay: { width: "100%", maxHeight: "50%", anchor: "top-center", nonCapturing: true, visible },
    panelHeight: Math.max(6, Math.floor(rows / 2)),
  };
}

function symbolFor(agent: SubagentSnapshot, watched: boolean, theme: Theme): string {
  if (watched) return theme.bold(theme.fg("accent", SYM_WATCHED));
  switch (agent.state) {
    case "done":
      return theme.fg("success", SYM_DONE);
    case "error":
      return theme.fg("error", SYM_ERROR);
    case "running":
      return theme.fg("warning", SYM_ACTIVE);
    default:
      return theme.fg("muted", SYM_ACTIVE);
  }
}

function stateLabel(agent: SubagentSnapshot): string {
  switch (agent.state) {
    case "pending":
      return "queued";
    case "running":
      return agent.tool ? `using ${agent.tool}` : agent.phase || "running";
    case "done":
      return agent.exitInfo ?? "completed";
    case "error":
      return agent.exitInfo ?? "failed";
  }
}

function spinnerFrame(): string {
  return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length] ?? SPINNER[0]!;
}

export class SubagentPanel implements Component {
  #lastSignature = "";

  constructor(
    private readonly tui: TuiLike,
    private readonly getTheme: () => Theme,
    private readonly registry: SubagentRegistry,
    private readonly allowVertical: () => boolean,
  ) {}

  invalidate(): void {
    this.#lastSignature = "";
  }

  /** The orientation the panel will use for the current terminal size. */
  layout(): SplitLayout {
    return chooseLayout(this.tui.terminal.columns, this.tui.terminal.rows, this.allowVertical());
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    const agents = this.registry.list();
    if (agents.length === 0) return [];

    const innerWidth = Math.max(1, width - 2);
    const { panelHeight } = this.layout();
    const height = Math.max(5, panelHeight);

    const border = (text: string): string => theme.fg("border", text);
    const frameRow = (content: string): string =>
      border("│") + truncateToWidth(content, innerWidth, "…", true) + border("│");
    /** A top/bottom border carrying a label, falling back to a plain rule when too narrow. */
    const labeledBorder = (left: string, right: string, rawLabel: string, styled: string, side: "left" | "right"): string => {
      const labelWidth = visibleWidth(rawLabel);
      if (labelWidth + 4 > width) return border(left + "─".repeat(innerWidth) + right);
      const fill = Math.max(0, innerWidth - labelWidth - 1);
      return side === "left"
        ? border(left) + border("─") + styled + border("─".repeat(fill)) + border(right)
        : border(left) + border("─".repeat(fill)) + styled + border("─") + border(right);
    };

    const counts = this.registry.counts();
    const watched = this.registry.watched();
    const watchedIndex = this.registry.watchedIndex();

    const lines: string[] = [];

    // Top border with title.
    const title = ` Sub-agents ${counts.finished}/${counts.total} `;
    lines.push(labeledBorder("╭", "╮", title, theme.bold(theme.fg("accent", title)), "left"));

    // Status-symbol row: one glyph per sub-agent.
    const watchedId = this.registry.watchedId();
    const symbols = agents.map((agent) => symbolFor(agent, agent.id === watchedId, theme)).join(" ");
    lines.push(frameRow(symbols));

    // Watched sub-agent header line.
    if (watched) {
      const position = `${watchedIndex + 1}/${agents.length}`;
      const head = `${theme.fg("accent", "▸")} ${theme.bold(watched.agentKind)} ${theme.fg("muted", "·")} `
        + `${watched.label} ${theme.fg("dim", `(${position})`)}`;
      lines.push(frameRow(head));
    }

    // Divider.
    lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));

    // Body: watched sub-agent live feed, filling the remaining rows.
    const bodyRows = Math.max(1, height - lines.length - 1);
    for (const line of this.#bodyLines(watched, innerWidth, bodyRows, theme)) {
      lines.push(frameRow(line));
    }

    // Bottom border with key hints.
    const hint = ` alt+s/alt+a switch · ctrl+\\ hide `;
    lines.push(labeledBorder("╰", "╯", hint, theme.fg("dim", hint), "right"));

    return lines;
  }

  #bodyLines(
    watched: SubagentSnapshot | undefined,
    innerWidth: number,
    bodyRows: number,
    theme: Theme,
  ): string[] {
    if (!watched) {
      return padToRows([theme.fg("dim", "No sub-agent selected.")], bodyRows, innerWidth);
    }

    const header: string[] = [];
    const running = watched.state === "running" || watched.state === "pending";
    const statusGlyph = running ? theme.fg("warning", spinnerFrame()) : theme.fg("muted", "•");
    header.push(`${statusGlyph} ${theme.fg("muted", stateLabel(watched))}`);

    // When finished, prefer the final result; otherwise show the live stream.
    let bodyText: string;
    if ((watched.state === "done" || watched.state === "error") && watched.final) {
      bodyText = watched.final;
    } else if (watched.text) {
      bodyText = watched.text;
    } else if (watched.thinking) {
      bodyText = theme.fg("dim", watched.thinking);
    } else {
      bodyText = theme.fg("dim", running ? "working…" : "(no output)");
    }

    const wrapped = wrapTextWithAnsi(bodyText, innerWidth);
    const available = Math.max(1, bodyRows - header.length);
    // Show the most recent output (tail) so the live feed stays current.
    const tail = wrapped.slice(Math.max(0, wrapped.length - available));
    return padToRows([...header, ...tail], bodyRows, innerWidth);
  }
}

/** Pad/truncate a block of (already width-safe) lines to exactly `rows` lines. */
function padToRows(lines: string[], rows: number, innerWidth: number): string[] {
  const out = lines.slice(0, rows).map((line) => truncateToWidth(line, innerWidth, "…", true));
  while (out.length < rows) out.push(" ".repeat(innerWidth));
  return out;
}
