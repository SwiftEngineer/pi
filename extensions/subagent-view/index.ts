/**
 * Sub-agent pager view.
 *
 * When the `task` tool spawns sub-agents, the whole scrollback becomes a
 * switchable pager: a permanently-pinned 1–2 line status strip sits at the very
 * bottom (below the prompt + powerline), and the area above shows ONE selected
 * channel — the main agent (channel 0) or a sub-agent — scrollable on its own.
 * Switching channels and scrolling are O(viewport), so they stay snappy no
 * matter how massive the history is.
 *
 * Two rendering paths:
 *   - core: when Pi's render loop is patched (scripts/patch-pi-tui-split.mjs), a
 *     `globalThis.__piSplitFrame` hook composes the reserved layout — the editor
 *     and powerline stay pinned (cursor never lost) while the transcript region
 *     is replaced by the active channel's window. Key-only scroll (no mouse
 *     capture) scrolls the active channel with PgUp/PgDn.
 *   - overlay: when unpatched, a bottom non-capturing overlay shows the status
 *     strip only (no paging); the main scrollback stays native.
 *
 * @see ./frame.ts (composition) · ./view-state.ts (selection/scroll) · ./registry.ts.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import { composePagerFrame, type FrameTui, statusStripLines } from "./frame.ts";
import { subagentRegistry } from "./registry.ts";
import { SubagentViewState } from "./view-state.ts";

type HookTui = FrameTui & { requestRender(force?: boolean): void };
type SplitHook = (tui: HookTui, mainLines: string[], width: number, height: number) => string[];

interface SplitGlobals {
  __piSplitFrame?: SplitHook | undefined;
  __PI_SPLIT_PATCH__?: boolean | undefined;
}

const splitGlobals = globalThis as unknown as SplitGlobals;
const ANIMATION_INTERVAL_MS = 100;

/** Whether to draw ASCII glyphs (no-Unicode terminals). */
function detectAscii(): boolean {
  if (process.env.PI_ASCII === "1") return true;
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return locale !== "" && !/utf-?8/i.test(locale);
}

export default function subagentViewExtension(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | undefined;
  let mode: "core" | "overlay" | undefined;
  let lastTui: { requestRender(force?: boolean): void } | undefined;
  let state: SubagentViewState | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  let removeInput: (() => void) | undefined;
  const isAscii = detectAscii();

  // overlay-mode refs
  let overlayHandle: OverlayHandle | undefined;
  let closeOverlay: (() => void) | undefined;
  let opening = false;
  let panelTui: { requestRender(force?: boolean): void } | undefined;
  let appliedHidden: boolean | undefined;

  const getState = (): SubagentViewState => {
    if (!state) state = new SubagentViewState(subagentRegistry, () => latestCtx?.ui.theme as Theme);
    return state;
  };

  const requestRepaint = (): void => {
    (mode === "core" ? lastTui : panelTui)?.requestRender();
  };

  const installCoreHook = (): void => {
    const hook: SplitHook = (tui, mainLines, width, height) => {
      lastTui = tui;
      const ctx = latestCtx;
      if (!ctx || subagentRegistry.isEmpty()) return mainLines;
      try {
        return composePagerFrame(tui, mainLines, width, height, {
          state: getState(),
          getTheme: () => ctx.ui.theme,
          ascii: isAscii,
        });
      } catch {
        return mainLines;
      }
    };
    splitGlobals.__piSplitFrame = hook;
  };

  /**
   * Scroll the active channel directly with PgUp/PgDn — no focus mode. Only
   * these two keys are intercepted (and only while sub-agents exist), so the
   * editor keeps every other key, including arrows/Home/End for text editing.
   */
  const installInput = (ctx: ExtensionContext): void => {
    if (removeInput || typeof ctx.ui.onTerminalInput !== "function") return;
    removeInput = ctx.ui.onTerminalInput((data) => {
      if (subagentRegistry.isEmpty()) return undefined;
      const view = getState();
      const scroll = (delta: number): { consume: true } => {
        view.scrollActive(delta);
        requestRepaint();
        return { consume: true };
      };
      if (matchesKey(data, "pageUp")) return scroll(-view.pageRows());
      if (matchesKey(data, "pageDown")) return scroll(view.pageRows());
      return undefined;
    });
  };

  const overlayOptions = (): OverlayOptions => ({
    width: "100%",
    anchor: "bottom-center",
    nonCapturing: true,
  });

  const ensureOverlay = (ctx: ExtensionContext): void => {
    if (overlayHandle || opening || ctx.mode !== "tui") return;
    opening = true;
    appliedHidden = undefined;
    const overlay: Component = {
      invalidate: () => {},
      render: (width: number): string[] => {
        const current = latestCtx;
        if (!current || subagentRegistry.isEmpty()) return [];
        try {
          return statusStripLines(getState(), current.ui.theme, isAscii, width, width >= 60 ? 2 : 1);
        } catch {
          return [];
        }
      },
    };
    void ctx.ui
      .custom<void>(
        (tui, _theme, _keybindings, done) => {
          panelTui = tui as unknown as { requestRender(force?: boolean): void };
          closeOverlay = () => done();
          return overlay;
        },
        { overlay: true, overlayOptions, onHandle: (handle) => { overlayHandle = handle; } },
      )
      .catch(() => {
        // Overlay disposed; refs cleared by teardown().
      });
  };

  const applyHidden = (hidden: boolean): void => {
    if (!overlayHandle || appliedHidden === hidden) return;
    overlayHandle.setHidden(hidden);
    appliedHidden = hidden;
  };

  const syncAnimation = (): void => {
    const running = !subagentRegistry.isEmpty() && subagentRegistry.counts().running > 0;
    if (running && !animationTimer) {
      animationTimer = setInterval(() => {
        if (state) state.spinnerFrame++;
        requestRepaint();
      }, ANIMATION_INTERVAL_MS);
      animationTimer.unref?.();
    } else if (!running && animationTimer) {
      clearInterval(animationTimer);
      animationTimer = undefined;
    }
  };

  /** Reconcile the view with current registry state. */
  const syncSplit = (): void => {
    const ctx = latestCtx;
    if (!ctx || ctx.mode !== "tui") return;
    getState().noteRegistryChange();
    if (mode === "core") {
      requestRepaint();
      syncAnimation();
      return;
    }
    if (subagentRegistry.isEmpty()) {
      applyHidden(true);
      syncAnimation();
      return;
    }
    ensureOverlay(ctx);
    applyHidden(false);
    panelTui?.requestRender();
    syncAnimation();
  };

  const teardown = (): void => {
    if (animationTimer) {
      clearInterval(animationTimer);
      animationTimer = undefined;
    }
    if (splitGlobals.__piSplitFrame) splitGlobals.__piSplitFrame = undefined;
    removeInput?.();
    removeInput = undefined;
    closeOverlay?.();
    closeOverlay = undefined;
    overlayHandle = undefined;
    panelTui = undefined;
    lastTui = undefined;
    opening = false;
    appliedHidden = undefined;
    state?.reset();
  };

  subagentRegistry.subscribe(syncSplit);

  if (typeof pi.registerShortcut === "function") {
    const select = (fn: (view: SubagentViewState) => void) => () => {
      fn(getState());
      requestRepaint();
    };
    pi.registerShortcut("alt+]", { description: "Sub-agents: next channel", handler: select((v) => v.cycle(1)) });
    pi.registerShortcut("alt+[", { description: "Sub-agents: previous channel", handler: select((v) => v.cycle(-1)) });
    // Muscle-memory aliases for the previous bindings.
    pi.registerShortcut("alt+s", { description: "Sub-agents: next channel", handler: select((v) => v.cycle(1)) });
    pi.registerShortcut("alt+a", { description: "Sub-agents: previous channel", handler: select((v) => v.cycle(-1)) });
    pi.registerShortcut("alt+l", { description: "Sub-agents: follow latest (live)", handler: select((v) => v.scrollActiveToBottom()) });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    latestCtx = ctx;
    mode = splitGlobals.__PI_SPLIT_PATCH__ ? "core" : "overlay";
    if (mode === "core") {
      installCoreHook();
      installInput(ctx);
    }
    syncSplit();
  });

  // Keep background sub-agents visible across top-level turns. The task tool
  // resets stale finished agents when starting a fresh background batch.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") latestCtx = ctx;
    syncSplit();
  });

  pi.on("session_shutdown", () => {
    teardown();
    subagentRegistry.reset();
    state = undefined;
    latestCtx = undefined;
    mode = undefined;
  });
}
