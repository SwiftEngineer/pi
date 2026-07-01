/**
 * PiJS port (pi_agent_rust QuickJS runtime) — OVERLAY-ONLY (§2 decision).
 *
 * Adapted from extensions/subagent-view/frame.ts. The entire split-pane
 * `composePagerFrame`/`extractChrome`/`liveLines` core-patch path is DROPPED
 * (there is no patchable render loop under the Rust host — §2). Only the
 * status-strip render path is kept:
 *   statusStripLines → buildStripModel → renderStrip
 * plus the small `activityOf`/`statusWord` helpers they need.
 *
 * `maxTop` still comes from `./scrollback.ts` (buildStripModel uses it with a
 * degenerate total=0 geometry for the overlay). `import type { Theme }` is
 * erased at runtime.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { maxTop } from "./scrollback.ts";
import { type SubagentRegistry, type SubagentSnapshot, subagentRegistry } from "./registry.ts";
import { type ChannelActivity, renderStrip, type StripChannel, type StripModel } from "./strip.ts";
import type { SubagentViewState } from "./view-state.ts";

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
  _theme: Theme,
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
 * Status-only strip lines for the non-capturing overlay (no pager): shows the
 * channel symbols + selected status, with scroll always reading "live" (the
 * overlay cannot scroll). Returns [] when there are no sub-agents.
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
