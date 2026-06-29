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
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey, type OverlayHandle, type OverlayOptions } from "@earendil-works/pi-tui";
import { composePagerFrame, type FrameTui, statusStripLines } from "./frame.ts";
import { subagentRegistry } from "./registry.ts";
import { SubagentViewState } from "./view-state.ts";

type HookTui = FrameTui & { requestRender(force?: boolean): void };
type SplitHook = (tui: HookTui, mainLines: string[], width: number, height: number) => string[];

interface SplitGlobals {
  __piSplitFrame?: SplitHook | undefined;
  /** True only while the split hook is actively replacing the frame. */
  __piSplitFrameActive?: boolean | undefined;
  __PI_SPLIT_PATCH__?: boolean | undefined;
}

const splitGlobals = globalThis as unknown as SplitGlobals;
const ANIMATION_INTERVAL_MS = 100;

/**
 * Opt-in geometry log (`PI_SUBAGENT_DEBUG=1`) for diagnosing scroll behaviour on
 * a real terminal — records the page jump vs. the actually-rendered viewport so
 * we can confirm a PgUp press can never out-jump the visible window.
 */
const debugLog: ((message: string) => void) | undefined =
  process.env.PI_SUBAGENT_DEBUG === "1"
    ? (message: string): void => {
        try {
          appendFileSync(path.join(os.homedir(), ".pi", "subagent-view-debug.log"), `${new Date().toISOString()} ${message}\n`);
        } catch {
          // Diagnostics must never break the render loop.
        }
      }
    : undefined;

/** A printable keystroke (not ESC-led, not a control byte) that should land in the prompt. */
function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

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
  let coreHook: SplitHook | undefined;
  let splitFrameActive = false;
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
    coreHook ??= (tui, mainLines, width, height) => {
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
    splitGlobals.__piSplitFrame = coreHook;
    splitGlobals.__piSplitFrameActive = splitFrameActive;
  };

  const uninstallCoreHook = (): void => {
    splitGlobals.__piSplitFrame = undefined;
    splitGlobals.__piSplitFrameActive = false;
  };

  const setSplitFrameActive = (active: boolean): boolean => {
    const globalActive = splitGlobals.__piSplitFrameActive === true;
    if (splitFrameActive === active && globalActive === active) return false;
    splitFrameActive = active;
    splitGlobals.__piSplitFrameActive = active;
    return true;
  };

  /**
   * Direct PgUp/PgDn scrolling of the active channel (no focus mode), plus
   * navigation back to the main agent while a sub-agent is selected. On the main
   * channel only PgUp/PgDn are intercepted, so the editor keeps every other key
   * (arrows/Home/End for text editing). On a sub-agent channel the prompt is
   * hidden, so any keystroke that would normally type returns to the main agent
   * (Escape/Enter consumed; a printable char switches and then lands in the
   * prompt) — preventing input from being lost into an invisible editor.
   */
  const installInput = (ctx: ExtensionContext): void => {
    if (removeInput || typeof ctx.ui.onTerminalInput !== "function") return;
    removeInput = ctx.ui.onTerminalInput((data) => {
      if (subagentRegistry.isEmpty()) return undefined;
      // Extension input listeners run before pi-tui filters key releases for the
      // focused component, so under the kitty keyboard protocol every press is
      // delivered twice (press + release). Acting on both would double every
      // scroll — ignore the release and handle only the press.
      if (isKeyRelease(data)) return undefined;
      const view = getState();
      const scroll = (delta: number): { consume: true } => {
        view.scrollActive(delta);
        requestRepaint();
        return { consume: true };
      };
      if (matchesKey(data, "pageUp")) {
        debugLog?.(`pageUp ${JSON.stringify(view.lastGeometry())}`);
        return scroll(-view.pageRows());
      }
      if (matchesKey(data, "pageDown")) {
        debugLog?.(`pageDown ${JSON.stringify(view.lastGeometry())}`);
        return scroll(view.pageRows());
      }
      if (!view.isMainSelected()) {
        if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
          view.selectMain();
          requestRepaint();
          return { consume: true };
        }
        if (isPrintable(data)) {
          // Switch to main and let the keystroke flow into the now-visible prompt.
          view.selectMain();
          requestRepaint();
          return undefined;
        }
      }
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
      const hasSubagents = !subagentRegistry.isEmpty();
      const activeChanged = setSplitFrameActive(hasSubagents);
      if (hasSubagents) installCoreHook();
      else uninstallCoreHook();
      if (hasSubagents || activeChanged) requestRepaint();
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
    uninstallCoreHook();
    splitGlobals.__piSplitFrameActive = undefined;
    splitFrameActive = false;
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
      splitFrameActive = false;
      uninstallCoreHook();
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
    latestCtx = undefined;
    mode = undefined;
    subagentRegistry.reset();
    state = undefined;
  });
}
