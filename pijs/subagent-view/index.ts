/**
 * PiJS port (pi_agent_rust QuickJS runtime) — OVERLAY-ONLY sub-agent status strip.
 *
 * ⚠ MECHANISM DEVIATION FROM THE NODE OVERLAY (grounded in Phase-5 API recon):
 * the Node version used `ctx.ui.custom(factory, { overlay:true, overlayOptions,
 * onHandle })` with an `OverlayHandle.setHidden()`. Under PiJS:
 *   1. `ctx.ui.custom` IS present but is a BLOCKING async render loop
 *      (`while(!done) await sleep(16)`) driven by `setInterval`. Per the Phase-4
 *      finding, the extension JS loop only pumps while an `execute()`/event frame
 *      is on the stack — an un-awaited `custom()` launched from an event handler
 *      freezes the instant the handler returns (its render/poll timers stop), so
 *      a PERSISTENT overlay via `custom` cannot pump. Awaiting it would block the
 *      session forever.
 *   2. `custom`'s PiJS shim ignores `onHandle`, so `overlayHandle.setHidden()`
 *      does not exist.
 * The correct primitive is `ctx.ui.setWidget(widgetKey, lines)` — a
 * FIRE-AND-FORGET push (`void pi.ui('setWidget', …)`) that needs no ongoing
 * render loop. We recompute `statusStripLines` and push it on every registry
 * change and on the agent lifecycle events. This matches the reduced value of
 * the strip under the BLOCKING `task` design (§Phase-5 brief): the registry only
 * settles post-hoc, so this is a summary/last-state strip, not a live feed.
 *
 * Dropped vs. Node (§2 overlay-only): the split-pane `coreHook`/`__piSplitFrame`/
 * `installInput`/`composePagerFrame` path, keyboard paging, per-frame animation.
 *
 * Reused (Phase 4, do not re-port): `./registry.ts`, `./transcript.ts`.
 * Added here: `./strip.ts`, `./scrollback.ts`, `./view-state.ts`, `./frame.ts`.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { statusStripLines } from "./frame.ts";
import { subagentRegistry } from "./registry.ts";
import { SubagentViewState } from "./view-state.ts";

/** The widget key the strip is pushed under. */
const WIDGET_KEY = "subagent-strip";

/**
 * No terminal width is exposed to extensions at event/subscribe time under PiJS
 * (there is no `ctx.terminal`/size field, and `setWidget` gives no width
 * feedback). We render the strip at a fixed budget and let the host clip; a
 * generous 100 avoids dropping the position/name fields on typical terminals.
 * FORCED limitation: on terminals narrower than 100 columns the strip may wrap;
 * this cannot be fixed without the host exposing a terminal-width field.
 */
const STRIP_WIDTH = 100;

/**
 * Minimal duck-typed theme: plain-text passthrough (no ANSI). Widget rendering
 * of embedded ANSI is unconfirmed under PiJS, so we deliberately emit no color;
 * `strip.ts` guards `typeof theme.inverse/underline === "function"`, so omitting
 * them makes selection fall back to `[g]` brackets — still legible.
 */
const plainTheme = {
  fg: (_tone: string, text: string): string => String(text ?? ""),
  bold: (text: string): string => String(text ?? ""),
} as unknown as Theme;

/** Whether to draw ASCII glyphs (no-Unicode terminals). `process.env` is empty in the sandbox. */
function detectAscii(): boolean {
  const env = (typeof process !== "undefined" && process.env) || {};
  if (env.PI_ASCII === "1") return true;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return locale !== "" && !/utf-?8/i.test(locale);
}

interface HostCtx {
  hasUI?: boolean;
  ui?: { setWidget?: (key: string, lines: string[]) => void };
}

interface PiHost {
  on: (event: string, handler: (event: unknown, ctx: HostCtx) => unknown) => void;
  registerShortcut?: (key: string, spec: { description: string; handler: (ctx: HostCtx) => void }) => void;
}

export default function subagentViewExtension(pi: PiHost): void {
  let latestCtx: HostCtx | undefined;
  let state: SubagentViewState | undefined;
  const isAscii = detectAscii();

  const getState = (): SubagentViewState => {
    if (!state) state = new SubagentViewState(subagentRegistry, () => plainTheme);
    return state;
  };

  const pushWidget = (lines: string[]): void => {
    const setWidget = latestCtx?.ui?.setWidget;
    if (typeof setWidget === "function") {
      try {
        setWidget(WIDGET_KEY, lines);
      } catch {
        // Push is best-effort; a UI hiccup must never break the registry.
      }
    }
  };

  /** Recompute the strip from current registry state and push it (or clear it). */
  const pushStrip = (): void => {
    const ctx = latestCtx;
    if (!ctx || !ctx.hasUI) return;
    if (subagentRegistry.isEmpty()) {
      pushWidget([]);
      return;
    }
    try {
      getState().noteRegistryChange();
      const rows: 1 | 2 = STRIP_WIDTH >= 60 ? 2 : 1;
      const lines = statusStripLines(getState(), plainTheme, isAscii, STRIP_WIDTH, rows);
      pushWidget(lines);
    } catch {
      // Never let a render error propagate into the registry notify loop.
    }
  };

  // Best-effort live-ish updates: the registry notifies while the task tool's
  // execute() frame is on the stack (shared globalThis singleton — §9 #7), so
  // each mutation re-pushes. If the two extensions run in isolated QuickJS
  // runtimes this won't fire cross-extension; the lifecycle events below still
  // push the settled state.
  subagentRegistry.subscribe(pushStrip);

  if (typeof pi.registerShortcut === "function") {
    const cycle = (delta: number) => (): void => {
      getState().cycle(delta);
      pushStrip();
    };
    pi.registerShortcut("alt+]", { description: "Sub-agents: next channel", handler: cycle(1) });
    pi.registerShortcut("alt+[", { description: "Sub-agents: previous channel", handler: cycle(-1) });
    pi.registerShortcut("alt+s", { description: "Sub-agents: next channel", handler: cycle(1) });
    pi.registerShortcut("alt+a", { description: "Sub-agents: previous channel", handler: cycle(-1) });
    pi.registerShortcut("alt+l", {
      description: "Sub-agents: follow latest (live)",
      handler: (): void => {
        getState().scrollActiveToBottom();
        pushStrip();
      },
    });
  }

  const remember = (ctx: HostCtx): void => {
    if (ctx && ctx.hasUI) latestCtx = ctx;
  };

  pi.on("session_start", (_event, ctx) => {
    remember(ctx);
    pushStrip();
  });

  // Keep the strip current across turns. The task tool resets stale finished
  // agents at the start of a fresh batch and populates the registry by the time
  // it returns (blocking design), so agent_start clears and agent_end settles.
  pi.on("agent_start", (_event, ctx) => {
    remember(ctx);
    pushStrip();
  });

  pi.on("agent_end", (_event, ctx) => {
    remember(ctx);
    pushStrip();
  });

  pi.on("session_shutdown", () => {
    pushWidget([]);
    subagentRegistry.reset();
    state = undefined;
    latestCtx = undefined;
  });
}
