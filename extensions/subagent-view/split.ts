/**
 * True reserved split-pane composition for the core-patch path.
 *
 * The patched TUI render loop calls {@link composeSplitFrame} with the
 * full-screen main frame and the live `tui`. We carve the viewport in half:
 * one half renders the sub-agent panel, the other shows the main view. For the
 * vertical (left/right) split we re-render the main component tree at the
 * right-hand width so the transcript reflows cleanly into its own column rather
 * than bleeding under the panel.
 *
 * @see ./index.ts which installs `globalThis.__piSplitFrame`.
 * @see ../../scripts/patch-pi-tui-split.mjs for the render-loop hook.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentPanel, type TuiLike } from "./panel.ts";
import { subagentRegistry } from "./registry.ts";

const MIN_PANEL_WIDTH = 24;
const MIN_PANEL_HEIGHT = 6;

export type SplitOrientation = "horizontal" | "vertical";

export interface SplitRegions {
  orientation: SplitOrientation;
  panelWidth: number;
  panelHeight: number;
  mainWidth: number;
  mainHeight: number;
}

/**
 * Carve the viewport into a panel region and a main region.
 *
 * Wide terminals (`width >= height * 2`, i.e. physically landscape given ~2:1
 * cells) use a vertical divider with the panel on the left; everything taller
 * uses a horizontal divider with the panel on top.
 */
export function splitRegions(width: number, height: number, allowVertical: boolean): SplitRegions {
  const wide = allowVertical && width >= height * 2;
  if (wide) {
    const panelWidth = Math.max(MIN_PANEL_WIDTH, Math.floor(width / 2));
    const mainWidth = Math.max(1, width - panelWidth - 1); // -1 for the divider column
    return { orientation: "vertical", panelWidth, panelHeight: height, mainWidth, mainHeight: height };
  }
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.floor(height / 2));
  return {
    orientation: "horizontal",
    panelWidth: width,
    panelHeight,
    mainWidth: width,
    mainHeight: Math.max(1, height - panelHeight),
  };
}

/** Fit `lines` to exactly `rows`, keeping the tail (bottom) when overflowing. */
function fitRegion(lines: string[], rows: number): string[] {
  if (lines.length >= rows) return lines.slice(lines.length - rows);
  const out = lines.slice();
  while (out.length < rows) out.push("");
  return out;
}

/** Right-pad to an exact visible width, preserving any embedded cursor marker. */
function padToWidth(line: string, width: number): string {
  const used = visibleWidth(line);
  return used >= width ? line : line + " ".repeat(width - used);
}

/**
 * Compose the final full-screen frame. Returns `mainLines` unchanged when no
 * sub-agents are active, so the hook is a cheap passthrough at idle.
 */
export function composeSplitFrame(
  tui: TuiLike,
  mainLines: string[],
  width: number,
  height: number,
  getTheme: () => Theme,
  allowVertical: boolean,
): string[] {
  if (subagentRegistry.isEmpty() || width < 1 || height < 1) return mainLines;

  const regions = splitRegions(width, height, allowVertical);
  const panel = new SubagentPanel(tui, getTheme, subagentRegistry, () => allowVertical);
  const panelLines = panel.render(regions.panelWidth, regions.panelHeight);

  if (regions.orientation === "horizontal") {
    const mainRegion = fitRegion(mainLines, regions.mainHeight);
    return [...panelLines, ...mainRegion];
  }

  // Vertical: re-render the main tree at the right-hand width so it reflows
  // into its column. fitRegion keeps the tail, so the editor stays at the
  // bottom and its cursor marker is preserved for hardware-cursor placement.
  const mainRegion = fitRegion(tui.render(regions.mainWidth), height);
  const divider = getTheme().fg("border", "│");
  const out: string[] = [];
  for (let row = 0; row < height; row++) {
    const left = padToWidth(panelLines[row] ?? "", regions.panelWidth);
    const right = padToWidth(mainRegion[row] ?? "", regions.mainWidth);
    out.push(left + divider + right);
  }
  return out;
}
