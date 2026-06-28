/**
 * Sub-agent split view.
 *
 * When the `task` tool spawns sub-agents, this extension divides the screen and
 * dedicates one half to a live feed of a single sub-agent (the user keeps
 * prompting the main agent in the other half). A status-symbol row shows every
 * sub-agent at once — watched, still-running, and finished — and hotkeys swap
 * which sub-agent the feed follows.
 *
 * Placement uses a persistent, non-capturing overlay so the main editor keeps
 * keyboard focus. The panel composes cleanly as a horizontal divider (feed on
 * top, main agent on the bottom). A vertical divider (feed on the left) is
 * available behind `PI_SUBAGENT_VERTICAL=1` for wide terminals.
 *
 * @see ./registry.ts for the shared state the `task` tool feeds.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { type OverlayPlacement, SubagentPanel, type TuiLike } from "./panel.ts";
import { subagentRegistry } from "./registry.ts";

/** Fallback placement used before the panel/terminal size is known. */
const DEFAULT_PLACEMENT: OverlayPlacement = {
  width: "100%",
  maxHeight: "50%",
  anchor: "top-center",
  nonCapturing: true,
  visible: (termWidth, termHeight) => termWidth >= 60 && termHeight >= 16,
};

const ANIMATION_INTERVAL_MS = 100;

function allowVertical(): boolean {
  return process.env.PI_SUBAGENT_VERTICAL === "1";
}

export default function subagentViewExtension(pi: ExtensionAPI): void {
  let latestCtx: ExtensionContext | undefined;
  let panel: SubagentPanel | undefined;
  let panelTui: TuiLike | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let closeOverlay: (() => void) | undefined;
  let opening = false;
  let appliedHidden: boolean | undefined;
  let userHidden = false;
  let animationTimer: ReturnType<typeof setInterval> | undefined;

  const ensureOverlay = (ctx: ExtensionContext): void => {
    if (overlayHandle || opening) return;
    if (ctx.mode !== "tui") return;
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
            allowVertical,
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
    const running = subagentRegistry.counts().running > 0;
    if (running && !animationTimer) {
      animationTimer = setInterval(() => panelTui?.requestRender(), ANIMATION_INTERVAL_MS);
      animationTimer.unref?.();
    } else if (!running && animationTimer) {
      clearInterval(animationTimer);
      animationTimer = undefined;
    }
  };

  /** Reconcile overlay visibility + repaint with current registry state. */
  const syncOverlay = (): void => {
    const ctx = latestCtx;
    if (!ctx || ctx.mode !== "tui") return;
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
    closeOverlay?.();
    closeOverlay = undefined;
    overlayHandle = undefined;
    panel = undefined;
    panelTui = undefined;
    opening = false;
    appliedHidden = undefined;
    userHidden = false;
  };

  subagentRegistry.subscribe(syncOverlay);

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("alt+s", {
      description: "Sub-agents: watch next",
      handler: () => {
        userHidden = false;
        subagentRegistry.cycle(1);
      },
    });
    pi.registerShortcut("alt+a", {
      description: "Sub-agents: watch previous",
      handler: () => {
        userHidden = false;
        subagentRegistry.cycle(-1);
      },
    });
    pi.registerShortcut("ctrl+\\", {
      description: "Sub-agents: toggle live panel",
      handler: () => {
        userHidden = !userHidden;
        syncOverlay();
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    latestCtx = ctx;
    syncOverlay();
  });

  // A fresh user turn starts with a clean slate of sub-agents.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode === "tui") latestCtx = ctx;
    userHidden = false;
    subagentRegistry.reset();
  });

  pi.on("session_shutdown", () => {
    teardown();
    subagentRegistry.reset();
    latestCtx = undefined;
  });
}
