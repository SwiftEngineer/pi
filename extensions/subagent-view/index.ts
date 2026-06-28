/**
 * Sub-agent split view.
 *
 * When the `task` tool spawns sub-agents, this extension divides the screen and
 * dedicates one half to a live feed of a single sub-agent (the user keeps
 * prompting the main agent in the other half). A status-symbol row shows every
 * sub-agent at once — watched, still-running, and finished — and hotkeys swap
 * which sub-agent the feed follows.
 *
 * Two rendering paths:
 *   - core: when Pi's render loop is patched (see scripts/patch-pi-tui-split.mjs),
 *     a `globalThis.__piSplitFrame` hook composes a TRUE reserved split-pane in
 *     both orientations — the main view reflows into its own half. Adaptive:
 *     horizontal divider on tall/portrait terminals, vertical on wide ones.
 *   - overlay: when unpatched, a persistent non-capturing overlay draws the feed
 *     on the top half (clean), keeping the editor focused below. The vertical
 *     overlay is opt-in (PI_SUBAGENT_VERTICAL=1) since overlays can't reflow the
 *     main transcript.
 *
 * @see ./registry.ts for the shared state the `task` tool feeds.
 * @see ./split.ts for the reserved split-pane composition.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { type OverlayPlacement, SubagentPanel, type TuiLike } from "./panel.ts";
import { subagentRegistry } from "./registry.ts";
import { composeSplitFrame } from "./split.ts";

type SplitHook = (tui: TuiLike, mainLines: string[], width: number, height: number) => string[];

interface SplitGlobals {
  __piSplitFrame?: SplitHook | undefined;
  __PI_SPLIT_PATCH__?: boolean | undefined;
}

const splitGlobals = globalThis as unknown as SplitGlobals;

/** Fallback overlay placement used before the panel/terminal size is known. */
const DEFAULT_PLACEMENT: OverlayPlacement = {
  width: "100%",
  maxHeight: "50%",
  anchor: "top-center",
  nonCapturing: true,
  visible: (termWidth, termHeight) => termWidth >= 60 && termHeight >= 16,
};

const ANIMATION_INTERVAL_MS = 100;

/**
 * Whether to use a vertical (left/right) divider on wide terminals. Clean only
 * under the core patch, so it is on by default there (disable with =0) and off
 * by default in overlay mode (enable, accepting transcript bleed, with =1).
 */
function allowVertical(corePatched: boolean): boolean {
  const env = process.env.PI_SUBAGENT_VERTICAL;
  return corePatched ? env !== "0" : env === "1";
}

export default function subagentViewExtension(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | undefined;
  let mode: "core" | "overlay" | undefined;

  // core-mode state
  let lastTui: TuiLike | undefined;
  let splitDisabled = false;

  // overlay-mode state
  let panel: SubagentPanel | undefined;
  let panelTui: TuiLike | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let closeOverlay: (() => void) | undefined;
  let opening = false;
  let appliedHidden: boolean | undefined;
  let userHidden = false;

  let animationTimer: ReturnType<typeof setInterval> | undefined;

  const requestRepaint = (): void => {
    (mode === "core" ? lastTui : panelTui)?.requestRender();
  };

  const installCoreHook = (): void => {
    const hook: SplitHook = (tui, mainLines, width, height) => {
      lastTui = tui;
      const ctx = latestCtx;
      if (splitDisabled || !ctx || subagentRegistry.isEmpty()) return mainLines;
      try {
        return composeSplitFrame(tui, mainLines, width, height, () => ctx.ui.theme, allowVertical(true));
      } catch {
        return mainLines;
      }
    };
    splitGlobals.__piSplitFrame = hook;
  };

  const ensureOverlay = (ctx: ExtensionContext): void => {
    if (overlayHandle || opening || ctx.mode !== "tui") return;
    opening = true;
    appliedHidden = undefined;
    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => {
          panelTui = tui as unknown as TuiLike;
          closeOverlay = () => done();
          panel = new SubagentPanel(
            panelTui,
            () => latestCtx?.ui.theme ?? theme,
            subagentRegistry,
            () => allowVertical(false),
          );
          return panel;
        },
        {
          overlay: true,
          overlayOptions: () => (panel ? panel.layout().overlay : DEFAULT_PLACEMENT),
          onHandle: (handle) => {
            overlayHandle = handle;
          },
        },
      )
      .catch(() => {
        // Overlay closed/disposed; refs are cleared by teardown().
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
      animationTimer = setInterval(() => requestRepaint(), ANIMATION_INTERVAL_MS);
      animationTimer.unref?.();
    } else if (!running && animationTimer) {
      clearInterval(animationTimer);
      animationTimer = undefined;
    }
  };

  /** Reconcile the split with current registry state. */
  const syncSplit = (): void => {
    const ctx = latestCtx;
    if (!ctx || ctx.mode !== "tui") return;
    if (mode === "core") {
      lastTui?.requestRender();
      syncAnimation();
      return;
    }
    if (subagentRegistry.isEmpty()) {
      applyHidden(true);
      syncAnimation();
      return;
    }
    ensureOverlay(ctx);
    applyHidden(userHidden);
    panelTui?.requestRender();
    syncAnimation();
  };

  const teardown = (): void => {
    if (animationTimer) {
      clearInterval(animationTimer);
      animationTimer = undefined;
    }
    if (splitGlobals.__piSplitFrame) splitGlobals.__piSplitFrame = undefined;
    closeOverlay?.();
    closeOverlay = undefined;
    overlayHandle = undefined;
    panel = undefined;
    panelTui = undefined;
    lastTui = undefined;
    opening = false;
    appliedHidden = undefined;
    userHidden = false;
    splitDisabled = false;
  };

  subagentRegistry.subscribe(syncSplit);

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("alt+s", {
      description: "Sub-agents: watch next",
      handler: () => {
        userHidden = false;
        splitDisabled = false;
        subagentRegistry.cycle(1);
      },
    });
    pi.registerShortcut("alt+a", {
      description: "Sub-agents: watch previous",
      handler: () => {
        userHidden = false;
        splitDisabled = false;
        subagentRegistry.cycle(-1);
      },
    });
    pi.registerShortcut("ctrl+\\", {
      description: "Sub-agents: toggle live panel",
      handler: () => {
        if (mode === "core") {
          splitDisabled = !splitDisabled;
          lastTui?.requestRender();
        } else {
          userHidden = !userHidden;
          syncSplit();
        }
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    latestCtx = ctx;
    mode = splitGlobals.__PI_SPLIT_PATCH__ ? "core" : "overlay";
    if (mode === "core") installCoreHook();
    syncSplit();
  });

  // Keep background sub-agents visible across top-level turns. The task tool
  // resets stale finished agents when starting a fresh background batch.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") latestCtx = ctx;
    userHidden = false;
    splitDisabled = false;
    syncSplit();
  });

  pi.on("session_shutdown", () => {
    teardown();
    subagentRegistry.reset();
    latestCtx = undefined;
    mode = undefined;
  });
}
