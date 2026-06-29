/**
 * Frame composition for the sub-agent pager (core-patch path).
 *
 * The patched render loop calls {@link composePagerFrame} with the full native
 * frame (`mainLines`) and the live `tui`. We split the component tree at the
 * editor — found by its cursor marker — so everything from the editor down
 * (editor + powerline footer) is the permanently-pinned chrome, and everything
 * above is replaced by the active channel's scrollable window. The sub-agent
 * status strip is pinned at the very bottom. The result is exactly `height`
 * rows; the cursor marker only ever lives in the pinned chrome, so the hardware
 * cursor is never lost while scrolled.
 *
 * Main channel → pi's own native transcript lines (sliced from `mainLines`).
 * Sub-agent channel → its reconstructed, width-wrapped transcript buffer.
 *
 * @see ./scrollback.ts (composeFrame), ./strip.ts (renderStrip), ./view-state.ts.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { composeFrame, maxTop } from "./scrollback.ts";
import { type SubagentRegistry, type SubagentSnapshot, subagentRegistry } from "./registry.ts";
import { bannerLine, type ChannelActivity, renderStrip, type StripChannel, type StripModel } from "./strip.ts";
import { MAIN_CHANNEL, type SubagentViewState } from "./view-state.ts";

/** The cursor marker pi-tui injects into the editor line (APC sequence). */
const CURSOR_MARKER = "_pi:c";

/** Below this height the strip collapses to a single row. */
const TWO_ROW_MIN_HEIGHT = 12;

/** Minimal structural view of the TUI the composer needs. */
export interface FrameTui {
  readonly terminal: { readonly rows: number; readonly columns: number };
  /** Top-level components, in render order (transcript … editor … footer). */
  readonly children: ReadonlyArray<{ render(width: number): string[] }>;
}

export interface ComposeDeps {
  state: SubagentViewState;
  getTheme: () => Theme;
  ascii: boolean;
  /** Registry override for tests; defaults to the process-wide singleton. */
  registry?: SubagentRegistry;
}

/** The pinned bottom chrome, split at the editor so the prompt can be hidden. */
export interface Chrome {
  /** The editor child's lines (carry the cursor marker). Shown only on the main channel. */
  editorLines: string[];
  /** Children rendered below the editor (widgets + powerline footer). Always pinned. */
  belowLines: string[];
}

/**
 * Walk `children` from the end until the editor (cursor marker) is found,
 * splitting the bottom chrome into the editor and everything rendered below it
 * (the powerline footer). Returns null when no marker is present, so the caller
 * can safely fall back to an unmodified frame.
 *
 * The split lets the pager hide the prompt while viewing a sub-agent: dropping
 * `editorLines` removes the only cursor marker from the frame, so pi-tui hides
 * the hardware cursor — exactly the behaviour we want off the main channel.
 */
export function extractChrome(tui: FrameTui, width: number): Chrome | null {
  const children = tui.children;
  if (!children || children.length === 0) return null;
  const belowLines: string[] = [];
  let rows = 0;
  for (let i = children.length - 1; i >= 0; i--) {
    let lines: string[];
    try {
      lines = children[i]!.render(width);
    } catch {
      return null;
    }
    if (lines.some((line) => line.includes(CURSOR_MARKER))) return { editorLines: lines, belowLines };
    belowLines.unshift(...lines);
    rows += lines.length;
    // The chrome can't be taller than the screen; if we've passed that without
    // finding the editor, bail to a safe passthrough rather than guess.
    if (rows > tui.terminal.rows) return null;
  }
  return null;
}

/** Live in-flight stream (not yet finalized into blocks) for a running sub-agent. */
function liveLines(agent: SubagentSnapshot, width: number, theme: Theme): string[] {
  if (agent.state === "done" || agent.state === "error") return [];
  const out: string[] = [];
  if (agent.text) {
    for (const line of wrapTextWithAnsi(agent.text, width)) out.push(line);
  } else if (agent.thinking) {
    for (const line of wrapTextWithAnsi(theme.fg("dim", agent.thinking), width)) out.push(line);
  }
  return out;
}

function activityOf(agent: SubagentSnapshot): ChannelActivity {
  if (agent.state !== "running" && agent.state !== "pending") return "idle";
  if (agent.tool) return "tool";
  const phase = agent.phase || "";
  if (phase.includes("reason") || phase.includes("think")) return "reasoning";
  if (phase.includes("writ")) return "writing";
  return "idle";
}

function statusWord(agent: SubagentSnapshot): string {
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

function buildStripModel(
  registry: SubagentRegistry,
  state: SubagentViewState,
  theme: Theme,
  ascii: boolean,
  total: number,
  viewport: number,
  top: number,
): StripModel {
  const agents = registry.list();
  const channels: StripChannel[] = [
    { kind: "main", activity: "idle", selected: state.isMainSelected(), hasNewOutput: false },
    ...agents.map((agent): StripChannel => ({
      kind: agent.state,
      activity: activityOf(agent),
      selected: state.selectedId === agent.id,
      hasNewOutput: state.hasNewOutput(agent.id),
    })),
  ];

  const isMain = state.isMainSelected();
  const selected = isMain ? undefined : agents.find((agent) => agent.id === state.selectedId);
  const spinner = !isMain && (selected?.state === "running" || selected?.state === "pending");

  const limit = maxTop(total, viewport);
  const clampedTop = Math.min(Math.max(0, top), limit);
  const below = limit - clampedTop;

  return {
    channels,
    selectedIndex: state.selectedIndex(),
    selectedLabel: isMain ? "main" : (selected?.label ?? ""),
    selectedStatus: isMain ? "" : selected ? statusWord(selected) : "",
    offMain: !isMain,
    spinner,
    spinnerFrame: state.spinnerFrame,
    scrolledUp: below > 0,
    percent: limit > 0 ? Math.round((clampedTop / limit) * 100) : 100,
    linesBelow: below,
    ascii,
  };
}

/**
 * Status-only strip lines for the unpatched overlay fallback (no pager): shows
 * the channel symbols + selected status, with scroll always reading "live".
 */
export function statusStripLines(
  state: SubagentViewState,
  theme: Theme,
  ascii: boolean,
  width: number,
  rows: 1 | 2,
  registry: SubagentRegistry = subagentRegistry,
): string[] {
  if (registry.isEmpty()) return [];
  return renderStrip(buildStripModel(registry, state, theme, ascii, 0, 1, 0), width, theme, rows);
}

/**
 * Compose the final reserved-layout frame. Returns `mainLines` unchanged when
 * there are no sub-agents or the editor seam can't be found (safe passthrough),
 * so the hook is a cheap no-op at idle and never corrupts the frame.
 */
export function composePagerFrame(tui: FrameTui, mainLines: string[], width: number, height: number, deps: ComposeDeps): string[] {
  const registry = deps.registry ?? subagentRegistry;
  if (registry.isEmpty() || width < 1 || height < 1) return mainLines;

  const chrome = extractChrome(tui, width);
  if (!chrome) return mainLines;

  const theme = deps.getTheme();
  const state = deps.state;
  const stripRows: 1 | 2 = height >= TWO_ROW_MIN_HEIGHT ? 2 : 1;

  // Resolve the active channel first; a vanished sub-agent falls back to main.
  let agent: SubagentSnapshot | undefined;
  if (!state.isMainSelected()) {
    agent = registry.list().find((candidate) => candidate.id === state.selectedId);
    if (!agent) state.selectMain();
  }
  const onMain = state.isMainSelected();

  // On the main channel the prompt stays pinned; on a sub-agent channel the
  // editor is dropped (prompt hidden, cursor released) and its rows go to the
  // scrollback. The footer/powerline below the editor is always pinned.
  const chromeLines = onMain ? [...chrome.editorLines, ...chrome.belowLines] : chrome.belowLines;
  const chromeRows = chromeLines.length;

  // Build the active channel's window line buffer.
  let windowLines: string[];
  if (onMain || !agent) {
    // The native frame always carries editor + footer at its tail; strip both.
    const nativeChrome = chrome.editorLines.length + chrome.belowLines.length;
    windowLines = mainLines.slice(0, Math.max(0, mainLines.length - nativeChrome));
  } else {
    const buffer = state.buffer(agent.id);
    buffer.setBlocks(agent.blocks, agent.blocks.length, agent.trimmedBlocks);
    windowLines = [...buffer.lines(width), ...liveLines(agent, width, theme)];
  }

  const viewport = Math.max(1, height - chromeRows - stripRows);
  state.rememberGeometry(windowLines.length, viewport, width);

  const top = state.windowTop(state.selectedId, windowLines.length, viewport, width);
  const stripModel = buildStripModel(registry, state, theme, deps.ascii, windowLines.length, viewport, top);
  const stripLines = renderStrip(stripModel, width, theme, stripRows);

  return composeFrame({
    windowLines,
    chromeLines,
    stripLines,
    width,
    height,
    top,
    banner: (below, bannerWidth) => bannerLine(below, bannerWidth, theme, deps.ascii),
  });
}
