import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

// Logo animation ported from oh-my-pi's WelcomeComponent renderer.
const MODEL_ICON = "󰚩";
const DIRECTORY_ICON = "";

function padding(width: number): string {
  return " ".repeat(Math.max(0, width));
}

function sanitizeInline(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatDirectory(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const normalizedHome = home.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedCwd = cwd.replace(/\\/g, "/");
  return normalizedCwd === normalizedHome
    ? "~"
    : normalizedCwd.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedCwd.slice(normalizedHome.length + 1)}`
      : cwd;
}

export const PI_LOGO = ["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "];

/** Multi-stop palette for the diagonal gradient. */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 92, 200], // hot pink
  [200, 110, 255], // violet
  [120, 130, 255], // periwinkle
  [60, 200, 255], // bright cyan
  [120, 255, 220], // mint
];

/** 256-color ramp fallback when truecolor isn't available. */
const GRADIENT_RAMP_256 = [199, 171, 135, 99, 75, 51, 87];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
  /** Overall opacity of the shine overlay, in [0, 1]. */
  strength: number;
  /** Center of the shine band along the diagonal, in [0, 1]. */
  pos: number;
}

let trueColor = true;
const TERMINAL = {
  get trueColor(): boolean {
    return trueColor;
  },
};

function withThemeColorMode<T>(theme: Theme, fn: () => T): T {
  const previous = trueColor;
  trueColor = theme.getColorMode() === "truecolor";
  try {
    return fn();
  } finally {
    trueColor = previous;
  }
}

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Shared by {@link gradientLogo} and the setup splash so both stay
 * color-identical (truecolor when available, 256-color ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
  const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
  const shinePos = shine ? shine.pos : 0;
  if (TERMINAL.trueColor) {
    // 5-stop palette widens the visible color range and avoids the
    // deep-blue valley a naive HSL lerp falls into.
    const stops = GRADIENT_STOPS;
    const seg = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(seg));
    const f = seg - i;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    let r = a[0] + (b[0] - a[0]) * f;
    let g = a[1] + (b[1] - a[1]) * f;
    let bl = a[2] + (b[2] - a[2]) * f;
    if (shineStrength > 0) {
      const dist = Math.abs(t - shinePos);
      const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
      if (intensity > 0) {
        r += (255 - r) * intensity;
        g += (255 - g) * intensity;
        bl += (255 - bl) * intensity;
      }
    }
    return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
  }
  const ramp = GRADIENT_RAMP_256;
  let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
  if (shineStrength > 0) {
    const dist = Math.abs(t - shinePos);
    const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
    // Promote strongly at the intro peak, and lift only the settled peak.
    if (intensity > 0.5) idx = ramp.length - 1;
    else if (intensity > 0.09) idx = Math.min(ramp.length - 1, idx + 1);
  }
  return `\x1b[38;5;${ramp[idx]}m`;
}

/**
 * Apply a multi-stop diagonal gradient (bottom-left → top-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
  const reset = "\x1b[0m";
  const rows = lines.length;
  const cols = Math.max(...lines.map(l => l.length));
  // span+1 so `base` stays strictly < 1: avoids the wrap-around at the
  // far corner mapping back to t=0 (hot pink) on the base frame.
  const span = Math.max(1, cols + rows - 1);
  return lines.map((line, y) => {
    let result = "";
    for (let x = 0; x < line.length; x++) {
      const char = line[x];
      if (char === " ") {
        result += char;
        continue;
      }
      // Diagonal: bottom-left (x=0, y=rows-1) → top-right (x=cols-1, y=0)
      const base = (x + (rows - 1 - y)) / span;
      const t = (((base + phase) % 1) + 1) % 1;
      result += gradientEscape(t, shine) + char + reset;
    }
    return result;
  });
}

/** Total length of the fast intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Render cadence once the logo has settled into its quiet shimmer. */
const SETTLED_TICK_MS = 100;
/** Duration of one subtle shine pass after the intro settles. */
const SETTLED_SHIMMER_MS = 6000;
/** Subtle shine opacity retained after the intro. */
const SETTLED_SHINE_STRENGTH = 0.14;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

function wrapUnit(value: number): number {
  return ((value % 1) + 1) % 1;
}

/**
 * Logo frame for a normalized intro progress in [0, 1).
 *
 * Ease-out cubic so the spin decelerates into the settled shimmer. The
 * gradient sweeps backward through INTRO_SWEEPS full rotations (`eased == 1` →
 * phase = 0 = settled base frame) while the shine traverses the diagonal at a
 * steady pace, decoupled from the gradient phase so the two layers parallax;
 * its strength fades with the same ease-out curve down to the quiet settled
 * shimmer strength.
 */
function introLogoFrame(progress: number, lines: readonly string[] = PI_LOGO): string[] {
  const eased = 1 - (1 - progress) ** 3;
  const phase = wrapUnit((1 - eased) * INTRO_SWEEPS);
  const shinePos = wrapUnit(progress * INTRO_SHINE_TRAVERSALS);
  const shineStrength = SETTLED_SHINE_STRENGTH +
    (1 - SETTLED_SHINE_STRENGTH) * (1 - eased) ** 1.5;
  return gradientLogo(lines, phase, { strength: shineStrength, pos: shinePos });
}

function settledLogoFrame(settledElapsedMs: number, lines: readonly string[] = PI_LOGO): string[] {
  const shinePos = wrapUnit(settledElapsedMs / SETTLED_SHIMMER_MS);
  return gradientLogo(lines, 0, { strength: SETTLED_SHINE_STRENGTH, pos: shinePos });
}

export class AnimatedPiHeaderComponent implements Component {
  #animStart: number | null = null;
  #animTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly ctx: ExtensionContext,
  ) {
    this.playIntro(() => this.tui.requestRender());
  }

  invalidate(): void {
    // Rendering is derived from live animation time and the session context.
  }

  /**
   * Play the fast intro, then continue with the quiet settled shimmer. Safe to
   * call multiple times — subsequent calls reset and replay.
   */
  playIntro(requestRender: () => void): void {
    this.#stopAnimation();
    this.#animStart = performance.now();
    requestRender();
    this.#animTimer = setInterval(() => {
      const start = this.#animStart;
      if (start == null) return;
      const elapsed = performance.now() - start;
      if (elapsed >= INTRO_MS) {
        this.#startSettledShimmer(requestRender);
        return;
      }
      requestRender();
    }, INTRO_TICK_MS);
    this.#animTimer.unref?.();
  }

  dispose(): void {
    this.#stopAnimation();
  }

  #startSettledShimmer(requestRender: () => void): void {
    if (this.#animTimer != null) {
      clearInterval(this.#animTimer);
      this.#animTimer = null;
    }
    requestRender();
    this.#animTimer = setInterval(() => {
      requestRender();
    }, SETTLED_TICK_MS);
    this.#animTimer.unref?.();
  }

  #stopAnimation(): void {
    if (this.#animTimer != null) {
      clearInterval(this.#animTimer);
      this.#animTimer = null;
    }
    this.#animStart = null;
    this.invalidate();
  }

  render(termWidth: number): string[] {
    const width = Math.max(1, termWidth);
    const contentWidth = Math.min(76, Math.max(0, width - 2));
    if (contentWidth < 12) return this.#renderTiny(width);

    const title = this.theme.bold("Welcome back!");
    const logoColored = this.#currentLogoFrame();
    const model = this.ctx.model;
    const modelLine = model
      ? `${MODEL_ICON} ${sanitizeInline(model.id)}${model.provider ? this.theme.fg("dim", ` via ${sanitizeInline(model.provider)}`) : ""}`
      : `${MODEL_ICON} no model selected`;
    const cwd = formatDirectory(this.ctx.sessionManager.getCwd?.() ?? this.ctx.cwd);
    const cwdLine = `${DIRECTORY_ICON} ${sanitizeInline(cwd)}`;
    const hintLine = "/ commands  ·  @ files  ·  ! bash + send  ·  !! bash local";

    return [
      this.#centerText(this.theme.fg("accent", title), contentWidth),
      "",
      ...logoColored.map(line => this.#centerText(line, contentWidth)),
      "",
      this.#centerText(this.theme.fg("muted", modelLine), contentWidth),
      this.#centerText(this.theme.fg("dim", cwdLine), contentWidth),
      this.#centerText(this.theme.fg("dim", hintLine), contentWidth),
    ].map(line => this.#fitToWidth(line, width));
  }

  #renderTiny(width: number): string[] {
    const mark = this.#currentLogoFrame(["π"])[0] ?? "π";
    return [this.#fitToWidth(this.#centerText(mark, width), width)];
  }

  /** Pick the logo frame for the current intro phase or settled shimmer. */
  #currentLogoFrame(lines: readonly string[] = PI_LOGO): readonly string[] {
    return withThemeColorMode(this.theme, () => {
      if (this.#animStart == null) return gradientLogo(lines, 0);
      const elapsed = Math.max(0, performance.now() - this.#animStart);
      if (elapsed >= INTRO_MS) return settledLogoFrame(elapsed - INTRO_MS, lines);
      return introLogoFrame(elapsed / INTRO_MS, lines);
    });
  }

  /** Center text within a given width */
  #centerText(text: string, width: number): string {
    const visLen = visibleWidth(text);
    if (visLen >= width) {
      return truncateToWidth(text, width);
    }
    const leftPad = Math.floor((width - visLen) / 2);
    const rightPad = width - visLen - leftPad;
    return padding(leftPad) + text + padding(rightPad);
  }

  /** Fit string to exact width with ANSI-aware truncation/padding */
  #fitToWidth(str: string, width: number): string {
    const visLen = visibleWidth(str);
    if (visLen > width) return truncateToWidth(str, width);
    return str + padding(width - visLen);
  }
}

export default function animatedPiHeaderExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((tui, theme) => new AnimatedPiHeaderComponent(tui, theme, ctx));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader(undefined);
  });
}
