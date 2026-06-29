import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Backports oh-my-pi-style native scrollback into Pi 0.80.x.
 *
 * The patch keeps finalized transcript rows stable in the terminal's native
 * scrollback while Pi continues to diff-render only the live viewport tail.
 * It is intentionally limited to compiled upstream files and is idempotent.
 */

const PATCH_MARKER = "PI_NATIVE_SCROLLBACK_PATCH";
const SOURCEMAP_TUI_ANCHOR = "//# sourceMappingURL=tui.js.map";

export const TRANSCRIPT_CONTAINER_SOURCE = `import { Container } from "@earendil-works/pi-tui";

export class NativeScrollbackLiveRegion extends Container {
    liveComponents = new Set();
    stableRenderCache = new WeakMap();
    addChild(component) {
        super.addChild(component);
        if (component?.isTranscriptLive?.()) {
            this.liveComponents.add(component);
            this.stableRenderCache.delete(component);
        }
    }
    removeChild(component) {
        super.removeChild(component);
        this.liveComponents.delete(component);
        this.stableRenderCache.delete(component);
    }
    clear() {
        super.clear();
        this.liveComponents.clear();
        this.stableRenderCache = new WeakMap();
    }
    markLive(component) {
        if (component && this.children.includes(component)) {
            this.liveComponents.add(component);
            this.stableRenderCache.delete(component);
        }
    }
    markFinal(component) {
        this.liveComponents.delete(component);
    }
    isLive(component) {
        return this.liveComponents.has(component) || component?.isTranscriptLive?.() === true;
    }
    stableLines(component, width) {
        const cached = this.stableRenderCache.get(component);
        if (cached?.width === width) {
            return cached.lines;
        }
        const lines = component.render(width);
        this.stableRenderCache.set(component, { width, lines });
        return lines;
    }
    childSegmentLines(child, width, hasPreviousRows, stable) {
        const childLines = stable ? this.stableLines(child, width) : child.render(width);
        return hasPreviousRows && child?.transcriptWantsLeadingSpacer?.() ? ["", ...childLines] : childLines;
    }
    renderNativeScrollbackFrame(width, committedRows = 0) {
        const lines = [];
        let stablePrefixLineCount = 0;
        let omittedRows = 0;
        let hasPreviousRows = false;
        let inStablePrefix = true;
        const requestedOmit = Math.max(0, Math.floor(committedRows));
        for (const child of this.children) {
            const live = this.isLive(child);
            const stable = inStablePrefix && !live;
            if (live) {
                inStablePrefix = false;
            }
            const segmentLines = this.childSegmentLines(child, width, hasPreviousRows, stable);
            const segmentLength = segmentLines.length;
            if (segmentLength > 0) {
                hasPreviousRows = true;
            }
            if (stable) {
                if (omittedRows + segmentLength <= requestedOmit) {
                    omittedRows += segmentLength;
                    continue;
                }
                let start = 0;
                if (requestedOmit > omittedRows) {
                    start = requestedOmit - omittedRows;
                    omittedRows = requestedOmit;
                }
                const remaining = start > 0 ? segmentLines.slice(start) : segmentLines;
                stablePrefixLineCount += remaining.length;
                lines.push(...remaining);
            } else {
                lines.push(...segmentLines);
            }
        }
        if (requestedOmit > omittedRows) {
            const full = this.renderNativeScrollbackFrame(width, 0);
            return { ...full, omittedRows: 0, resetRequired: true };
        }
        return { lines, stablePrefixLineCount, omittedRows, resetRequired: false };
    }
    render(width) {
        return this.renderNativeScrollbackFrame(width, 0).lines;
    }
    getNativeScrollbackStableLineCount(width) {
        return this.renderNativeScrollbackFrame(width, 0).stablePrefixLineCount;
    }
}

export class TranscriptContainer extends NativeScrollbackLiveRegion {
}
// ${PATCH_MARKER}:transcript-container
`;

export const TRANSCRIPT_CONTAINER_DTS = `import { Container, type Component } from "@earendil-works/pi-tui";
export interface NativeScrollbackFrame {
    lines: string[];
    stablePrefixLineCount: number;
    omittedRows: number;
    resetRequired: boolean;
}
export declare class NativeScrollbackLiveRegion extends Container {
    private liveComponents;
    private stableRenderCache;
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    markLive(component: Component): void;
    markFinal(component: Component): void;
    isLive(component: Component): boolean;
    private stableLines;
    private childSegmentLines;
    renderNativeScrollbackFrame(width: number, committedRows?: number): NativeScrollbackFrame;
    render(width: number): string[];
    getNativeScrollbackStableLineCount(width: number): number;
}
export declare class TranscriptContainer extends NativeScrollbackLiveRegion {}
`;

function globalNodeModules() {
  const configured = process.env.PI_GLOBAL_NODE_MODULES;
  if (configured) return configured;
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

function packageDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) return configured;
  return path.join(globalNodeModules(), "@earendil-works", "pi-coding-agent");
}

function requireTargetFile(filePath) {
  if (!existsSync(filePath)) throw new Error(`Expected Pi file at ${filePath}`);
  return readFileSync(filePath, "utf8");
}

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Pi native scrollback patch could not find ${label}.`);
  return source.replace(oldText, newText);
}

function insertBeforeRequired(source, anchor, insertion, label) {
  const index = source.indexOf(anchor);
  if (index < 0) throw new Error(`Pi native scrollback patch could not find ${label}.`);
  return source.slice(0, index) + insertion + source.slice(index);
}

const NATIVE_TUI_FIELD = `    nativeScrollbackCommittedRows = 0; // ${PATCH_MARKER}:committed rows already delegated to terminal scrollback
    nativeScrollbackLastDelta = 0; // ${PATCH_MARKER}:rows committed during the current frame
`;

const NATIVE_TUI_METHODS = `    // ${PATCH_MARKER}:methods:start
    renderNativeScrollbackFrame(width, height, canOmitCommittedRows = true) {
        const lines = [];
        let stablePrefixLineCount = 0;
        let foundNativeRegion = false;
        let resetRequired = false;
        for (const child of this.children) {
            let childLines;
            if (!foundNativeRegion && typeof child.renderNativeScrollbackFrame === "function") {
                const nativeRegionAtFrameHead = lines.length === 0;
                if (!nativeRegionAtFrameHead && canOmitCommittedRows && this.nativeScrollbackCommittedRows > 0) {
                    resetRequired = true;
                    break;
                }
                const committedRows = canOmitCommittedRows && nativeRegionAtFrameHead ? this.nativeScrollbackCommittedRows : 0;
                const frame = child.renderNativeScrollbackFrame(width, committedRows);
                if (frame?.resetRequired && canOmitCommittedRows) {
                    resetRequired = true;
                    break;
                }
                childLines = Array.isArray(frame?.lines) ? frame.lines : [];
                stablePrefixLineCount = nativeRegionAtFrameHead ? Math.max(0, frame?.stablePrefixLineCount ?? 0) : 0;
                foundNativeRegion = true;
            }
            else {
                childLines = child.render(width);
            }
            lines.push(...childLines);
        }
        return { lines, stablePrefixLineCount: foundNativeRegion ? stablePrefixLineCount : 0, resetRequired };
    }
    applyNativeScrollbackFrame(lines, stablePrefixLineCount, height, resetNativeScrollback = false) {
        this.nativeScrollbackLastDelta = 0;
        const managedHeight = Math.max(1, height);
        if (resetNativeScrollback) {
            this.nativeScrollbackCommittedRows = 0;
            this.previousLines = [];
            this.previousKittyImageIds = new Set();
            this.cursorRow = 0;
            this.hardwareCursorRow = 0;
            this.previousViewportTop = 0;
            this.maxLinesRendered = 0;
            return lines;
        }
        const maxCommit = Math.max(0, lines.length - managedHeight);
        const requestedDelta = Math.max(0, Math.min(stablePrefixLineCount, maxCommit));
        if (requestedDelta > 0) {
            const offscreenPreviousRows = Math.max(0, this.previousLines.length - managedHeight);
            const safeDelta = Math.min(requestedDelta, offscreenPreviousRows);
            if (safeDelta > 0) {
                this.previousLines = this.previousLines.slice(safeDelta);
                this.previousKittyImageIds = this.collectKittyImageIds(this.previousLines);
                this.cursorRow = Math.max(0, this.cursorRow - safeDelta);
                this.hardwareCursorRow = Math.max(0, this.hardwareCursorRow - safeDelta);
                this.previousViewportTop = Math.max(0, this.previousViewportTop - safeDelta);
                this.maxLinesRendered = Math.max(0, this.maxLinesRendered - safeDelta);
                this.nativeScrollbackCommittedRows += safeDelta;
                this.nativeScrollbackLastDelta = safeDelta;
                return lines.slice(safeDelta);
            }
        }
        return lines;
    }
    // ${PATCH_MARKER}:methods:end
`;

const NATIVE_RENDER_FRAME_UPSTREAM = "        // Render all components to get new lines\n        let newLines = this.render(width);\n";
const NATIVE_RENDER_FRAME_OLD_PATCH = "        // Render all components to get new lines\n        const nativeScrollbackFrame = this.renderNativeScrollbackFrame(width, height);\n        let newLines = nativeScrollbackFrame.lines;\n        let nativeStablePrefixLineCount = nativeScrollbackFrame.stablePrefixLineCount;\n";
const NATIVE_RENDER_FRAME_EAGER_SPLIT_PATCH = "        // Render all components to get new lines\n        const nativeCanOmitCommittedRows = !(widthChanged || heightChanged || globalThis.__piSplitFrame || ((this.overlayStack?.length ?? 0) > 0));\n        let nativeScrollbackFrame = this.renderNativeScrollbackFrame(width, height, nativeCanOmitCommittedRows);\n        let nativeScrollbackResetRequired = !nativeCanOmitCommittedRows || nativeScrollbackFrame.resetRequired === true;\n        if (nativeScrollbackFrame.resetRequired === true && nativeCanOmitCommittedRows) {\n            this.nativeScrollbackCommittedRows = 0;\n            this.nativeScrollbackLastDelta = 0;\n            nativeScrollbackFrame = this.renderNativeScrollbackFrame(width, height, false);\n        }\n        let newLines = nativeScrollbackFrame.lines;\n        let nativeStablePrefixLineCount = nativeScrollbackFrame.stablePrefixLineCount;\n";
const NATIVE_RENDER_FRAME_PATCH = "        // Render all components to get new lines\n        const nativeSplitFrameActive = Boolean(globalThis.__piSplitFrame) && globalThis.__piSplitFrameActive !== false;\n        const nativeCanOmitCommittedRows = !(widthChanged || heightChanged || nativeSplitFrameActive || ((this.overlayStack?.length ?? 0) > 0));\n        let nativeScrollbackFrame = this.renderNativeScrollbackFrame(width, height, nativeCanOmitCommittedRows);\n        let nativeScrollbackResetRequired = !nativeCanOmitCommittedRows || nativeScrollbackFrame.resetRequired === true;\n        if (nativeScrollbackFrame.resetRequired === true && nativeCanOmitCommittedRows) {\n            this.nativeScrollbackCommittedRows = 0;\n            this.nativeScrollbackLastDelta = 0;\n            nativeScrollbackFrame = this.renderNativeScrollbackFrame(width, height, false);\n        }\n        let newLines = nativeScrollbackFrame.lines;\n        let nativeStablePrefixLineCount = nativeScrollbackFrame.stablePrefixLineCount;\n";
const NATIVE_APPLY_FRAME_ANCHOR = "        // Extract cursor position before applying line resets (marker must be found first)\n";
const NATIVE_APPLY_FRAME_OLD_PATCH = "        newLines = this.applyNativeScrollbackFrame(newLines, nativeStablePrefixLineCount, height, widthChanged, heightChanged);\n        if (this.nativeScrollbackLastDelta > 0) {\n            const nativeScrollbackDelta = this.nativeScrollbackLastDelta;\n            prevViewportTop = Math.max(0, prevViewportTop - nativeScrollbackDelta);\n            viewportTop = Math.max(0, viewportTop - nativeScrollbackDelta);\n            hardwareCursorRow = Math.max(0, hardwareCursorRow - nativeScrollbackDelta);\n        }\n        // Extract cursor position before applying line resets (marker must be found first)\n";
const NATIVE_APPLY_FRAME_PATCH = "        newLines = this.applyNativeScrollbackFrame(newLines, nativeStablePrefixLineCount, height, nativeScrollbackResetRequired);\n        if (this.nativeScrollbackLastDelta > 0) {\n            const nativeScrollbackDelta = this.nativeScrollbackLastDelta;\n            prevViewportTop = Math.max(0, prevViewportTop - nativeScrollbackDelta);\n            viewportTop = Math.max(0, viewportTop - nativeScrollbackDelta);\n            hardwareCursorRow = Math.max(0, hardwareCursorRow - nativeScrollbackDelta);\n        }\n        // Extract cursor position before applying line resets (marker must be found first)\n";
const NATIVE_FIRST_RENDER_ANCHOR = "        // First render - just output everything without clearing (assumes clean screen)\n";
const NATIVE_RESET_FULL_RENDER_PATCH = `        // ${PATCH_MARKER}:reset-full-render
        if (nativeScrollbackResetRequired && this.previousLines.length > 0) {
            logRedraw("native scrollback reset");
            fullRender(true);
            return;
        }
`;

const TOOL_EXECUTION_TUI_IMPORT = `import { Box, Container, getCapabilities, Image, Spacer, Text } from "@earendil-works/pi-tui";\n`;
const TOOL_EXECUTION_TUI_IMPORT_WITH_WIDTH = `import { Box, Container, getCapabilities, Image, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";\n`;
const TOOL_EXECUTION_FRAME_RENDER_PATTERN = new RegExp(`    // ${PATCH_MARKER}:tool-frame-render\\n[\\s\\S]*?    render\\(width\\) \\{[\\s\\S]*?\\n    \\}\\n(?=    updateDisplay\\(\\) \\{)`);

const TOOL_EXECUTION_RENDER_UPSTREAM = `    render(width) {
        if (this.hideComponent) {
            return [];
        }
        if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
            const contentLines = this.selfRenderContainer.render(width);
            if (contentLines.length === 0 && this.imageComponents.length === 0) {
                return [];
            }
            const lines = [];
            if (contentLines.length > 0) {
                lines.push("");
                lines.push(...contentLines);
            }
            for (let i = 0; i < this.imageComponents.length; i++) {
                const spacer = this.imageSpacers[i];
                if (spacer) {
                    lines.push(...spacer.render(width));
                }
                const imageComponent = this.imageComponents[i];
                if (imageComponent) {
                    lines.push(...imageComponent.render(width));
                }
            }
            return lines;
        }
        return super.render(width);
    }
`;

const TOOL_EXECUTION_RENDER_OLD_PATCH = `    render(width) {
        if (this.hideComponent) {
            return [];
        }
        if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
            const contentLines = this.selfRenderContainer.render(width);
            if (contentLines.length === 0 && this.imageComponents.length === 0) {
                return [];
            }
            const lines = [];
            if (contentLines.length > 0) {
                lines.push(...contentLines);
            }
            for (let i = 0; i < this.imageComponents.length; i++) {
                const spacer = this.imageSpacers[i];
                if (spacer) {
                    lines.push(...spacer.render(width));
                }
                const imageComponent = this.imageComponents[i];
                if (imageComponent) {
                    lines.push(...imageComponent.render(width));
                }
            }
            return lines;
        }
        return super.render(width);
    }
`;

const TOOL_EXECUTION_FRAME_RENDER = `    // ${PATCH_MARKER}:tool-frame-render
    toolFrameStripAnsi(text) {
        return String(text ?? "")
            .replace(/\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)/g, "")
            .replace(/\\x1b\\[[0-?]*[ -/]*[@-~]/g, "");
    }
    toolFrameVisibleWidth(text) {
        const value = String(text ?? "");
        if (typeof visibleWidth === "function") return visibleWidth(value);
        return Array.from(this.toolFrameStripAnsi(value)).length;
    }
    toolFrameTruncate(text, width) {
        if (width <= 0) return "";
        const value = String(text ?? "");
        if (this.toolFrameVisibleWidth(value) <= width) return value;
        if (typeof truncateToWidth === "function") return truncateToWidth(value, width, "…");
        const chars = Array.from(this.toolFrameStripAnsi(value));
        if (width === 1) return "…";
        return chars.slice(0, width - 1).join("") + "…";
    }
    toolFramePad(text, width) {
        if (width <= 0) return "";
        const fitted = this.toolFrameVisibleWidth(text) > width ? this.toolFrameTruncate(text, width) : text;
        return fitted + " ".repeat(Math.max(0, width - this.toolFrameVisibleWidth(fitted)));
    }
    toolFrameBgColor() {
        return this.isPartial || !this.result
            ? "toolPendingBg"
            : this.result?.isError
                ? "toolErrorBg"
                : "toolSuccessBg";
    }
    toolFrameBg(line) {
        return theme.bg(this.toolFrameBgColor(), line);
    }
    // ${PATCH_MARKER}:tool-frame-background
    toolFrameRule(width, kind, label = "") {
        const left = kind === "top" ? "┌" : kind === "middle" ? "├" : "└";
        const right = kind === "top" ? "┐" : kind === "middle" ? "┤" : "┘";
        const innerWidth = Math.max(0, width - 2);
        if (innerWidth <= 0) return theme.fg("border", left);
        if (!label) return theme.fg("border", left + "─".repeat(innerWidth) + right);
        const maxLabelWidth = Math.max(0, innerWidth - 4);
        const fittedLabel = this.toolFrameVisibleWidth(label) > maxLabelWidth ? this.toolFrameTruncate(label, maxLabelWidth) : label;
        const labelWidth = this.toolFrameVisibleWidth(fittedLabel);
        const leftRuleWidth = Math.min(2, Math.max(0, innerWidth - labelWidth));
        const rightRuleWidth = Math.max(0, innerWidth - labelWidth - leftRuleWidth);
        return theme.fg("border", left + "─".repeat(leftRuleWidth)) + fittedLabel + theme.fg("border", "─".repeat(rightRuleWidth) + right);
    }
    toolFrameBodyLine(width, line) {
        if (width < 4) return this.toolFramePad(line, width);
        const bodyWidth = Math.max(0, width - 4);
        return theme.fg("border", "│") + " " + this.toolFramePad(line, bodyWidth) + " " + theme.fg("border", "│");
    }
    toolFrameDisplayName() {
        const raw = this.toolDefinition?.label ?? this.builtInToolDefinition?.label ?? this.toolName;
        const label = String(raw || this.toolName);
        if (/^[a-z0-9_-]+$/.test(label)) {
            return label.replace(/[_-]+/g, " ").replace(/\\b\\w/g, (ch) => ch.toUpperCase());
        }
        return label;
    }
    toolFrameTitle() {
        const mark = this.isPartial || !this.result
            ? theme.fg("warning", "●")
            : this.result?.isError
                ? theme.fg("error", "✗")
                : theme.fg("success", "✓");
        return mark + " " + theme.fg("accent", this.toolFrameDisplayName());
    }
    toolFrameRenderLines(component, width) {
        if (!component) return [];
        return component.render(Math.max(1, width)).map((line) => line ?? "");
    }
    toolFrameBashCallLines(width) {
        if (this.toolName !== "bash") return undefined;
        const command = typeof this.args?.command === "string" ? this.args.command : "";
        if (!command) return undefined;
        const timeout = typeof this.args?.timeout === "number" && Number.isFinite(this.args.timeout)
            ? theme.fg("muted", " (timeout " + this.args.timeout + "s)")
            : "";
        const line = theme.fg("muted", "$") + " " + theme.fg("bashMode", command) + timeout;
        return new Text(line, 0, 0).render(Math.max(1, width));
    }
    toolFrameCallLines(width) {
        if (!this.hasRendererDefinition()) return this.toolFrameRenderLines(this.contentText, width);
        const bashLines = this.toolFrameBashCallLines(width);
        if (bashLines) return bashLines;
        if (this.callRendererComponent) return this.toolFrameRenderLines(this.callRendererComponent, width);
        return this.createCallFallback().render(Math.max(1, width));
    }
    toolFrameWithoutBashTiming(lines) {
        if (this.toolName !== "bash") return lines;
        const next = [...lines];
        let index = next.length - 1;
        while (index >= 0 && this.toolFrameStripAnsi(next[index]).trim() === "") index--;
        if (index >= 0 && /^(?:Took|Elapsed) \\d+(?:\\.\\d+)?s$/.test(this.toolFrameStripAnsi(next[index]).trim())) {
            next.splice(index, 1);
            if (index > 0 && this.toolFrameStripAnsi(next[index - 1]).trim() === "") next.splice(index - 1, 1);
        }
        return next;
    }
    toolFrameFormatDuration(ms) {
        const seconds = Math.max(0, ms) / 1000;
        return (seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)) + "s";
    }
    toolFrameFooterLines(existingLines) {
        const lines = [];
        const fullOutputPath = this.result?.details?.fullOutputPath;
        if (fullOutputPath && !existingLines.some((line) => this.toolFrameStripAnsi(line).includes(fullOutputPath))) {
            lines.push(theme.fg("dim", "[raw output: " + fullOutputPath + "]"));
        }
        if (this.toolName === "bash") {
            const startedAt = typeof this.rendererState?.startedAt === "number" ? this.rendererState.startedAt : undefined;
            if (startedAt !== undefined) {
                const endedAt = typeof this.rendererState?.endedAt === "number" ? this.rendererState.endedAt : Date.now();
                const timeout = typeof this.args?.timeout === "number" && Number.isFinite(this.args.timeout) ? " | Timeout: " + this.args.timeout + "s" : "";
                lines.push(theme.fg("dim", "<Wall: " + this.toolFrameFormatDuration(endedAt - startedAt) + timeout + ">"));
            }
        }
        return lines;
    }
    toolFrameResultLines(width) {
        if (!this.result) return [];
        let lines = this.resultRendererComponent ? this.toolFrameRenderLines(this.resultRendererComponent, width) : [];
        if (lines.length === 0) {
            const fallback = this.createResultFallback();
            if (fallback) lines = fallback.render(Math.max(1, width));
        }
        lines = this.toolFrameWithoutBashTiming(lines);
        const footerLines = this.toolFrameFooterLines(lines);
        if (footerLines.length > 0) {
            if (lines.length > 0 && this.toolFrameStripAnsi(lines[lines.length - 1]).trim() !== "") lines.push("");
            lines.push(...footerLines);
        }
        return lines;
    }
    render(width) {
        if (this.hideComponent) {
            return [];
        }
        const frameWidth = Math.max(1, width);
        if (frameWidth < 8) return super.render(width);
        const bodyWidth = Math.max(1, frameWidth - 4);
        const callLines = this.toolFrameCallLines(bodyWidth);
        const resultLines = this.toolFrameResultLines(bodyWidth);
        if (callLines.length === 0 && resultLines.length === 0 && this.imageComponents.length === 0) {
            return [];
        }
        const lines = [];
        if (callLines.length > 0 || resultLines.length > 0) {
            lines.push(this.toolFrameBg(this.toolFrameRule(frameWidth, "top", " " + this.toolFrameTitle() + " ")));
            for (const line of callLines) lines.push(this.toolFrameBg(this.toolFrameBodyLine(frameWidth, line)));
            if (resultLines.length > 0) {
                lines.push(this.toolFrameBg(this.toolFrameRule(frameWidth, "middle", " Output ")));
                for (const line of resultLines) lines.push(this.toolFrameBg(this.toolFrameBodyLine(frameWidth, line)));
            }
            lines.push(this.toolFrameBg(this.toolFrameRule(frameWidth, "bottom")));
        }
        for (let i = 0; i < this.imageComponents.length; i++) {
            const spacer = this.imageSpacers[i];
            if (spacer) {
                lines.push(...spacer.render(width));
            }
            const imageComponent = this.imageComponents[i];
            if (imageComponent) {
                lines.push(...imageComponent.render(width));
            }
        }
        return lines;
    }
`;

function ensureNativeResetFullRender(source) {
  if (source.includes(`${PATCH_MARKER}:reset-full-render`)) return source;
  return insertBeforeRequired(
    source,
    NATIVE_FIRST_RENDER_ANCHOR,
    NATIVE_RESET_FULL_RENDER_PATCH,
    "TUI first-render native scrollback reset anchor",
  );
}

function upgradeNativeScrollbackTuiSource(source) {
  let patched = source;
  const methodsPattern = new RegExp(`    // ${PATCH_MARKER}:methods:start\\n[\\s\\S]*?    // ${PATCH_MARKER}:methods:end\\n`);
  patched = patched.replace(methodsPattern, NATIVE_TUI_METHODS);
  patched = patched.replace(NATIVE_RENDER_FRAME_OLD_PATCH, NATIVE_RENDER_FRAME_PATCH);
  patched = patched.replace(NATIVE_RENDER_FRAME_EAGER_SPLIT_PATCH, NATIVE_RENDER_FRAME_PATCH);
  patched = patched.replace(NATIVE_APPLY_FRAME_OLD_PATCH, NATIVE_APPLY_FRAME_PATCH);
  patched = ensureNativeResetFullRender(patched);
  return patched;
}

export function patchNativeScrollbackTuiSource(source) {
  if (source.includes(PATCH_MARKER)) return upgradeNativeScrollbackTuiSource(source);
  let patched = source;
  patched = replaceRequired(
    patched,
    "    previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves\n",
    "    previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves\n" + NATIVE_TUI_FIELD,
    "TUI previousViewportTop field",
  );
  patched = insertBeforeRequired(
    patched,
    "    /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */\n",
    NATIVE_TUI_METHODS,
    "TUI compositeOverlays method",
  );
  patched = replaceRequired(
    patched,
    "            this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear\n            this.cursorRow = 0;\n",
    "            this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear\n            this.nativeScrollbackCommittedRows = 0;\n            this.nativeScrollbackLastDelta = 0;\n            this.cursorRow = 0;\n",
    "TUI force-render reset",
  );
  patched = replaceRequired(
    patched,
    NATIVE_RENDER_FRAME_UPSTREAM,
    NATIVE_RENDER_FRAME_PATCH,
    "TUI render-frame anchor",
  );
  patched = replaceRequired(
    patched,
    NATIVE_APPLY_FRAME_ANCHOR,
    NATIVE_APPLY_FRAME_PATCH,
    "TUI cursor-extraction anchor",
  );
  patched = replaceRequired(
    patched,
    "        if (this.overlayStack.length > 0) {\n            newLines = this.compositeOverlays(newLines, width, height);\n        }\n",
    "        if (this.overlayStack.length > 0) {\n            newLines = this.compositeOverlays(newLines, width, height);\n            nativeStablePrefixLineCount = 0;\n        }\n",
    "TUI overlay block",
  );
  patched = replaceRequired(
    patched,
    "        if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {\n",
    "        if (this.clearOnShrink && this.nativeScrollbackCommittedRows === 0 && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {\n",
    "TUI clearOnShrink guard",
  );
  patched = ensureNativeResetFullRender(patched);
  return patched;
}

function patchToolExecutionRenderSource(source) {
  if (source.includes(`${PATCH_MARKER}:tool-frame-render`)) {
    if (source.includes(`${PATCH_MARKER}:tool-frame-background`)) return source;
    const upgraded = source.replace(TOOL_EXECUTION_FRAME_RENDER_PATTERN, TOOL_EXECUTION_FRAME_RENDER);
    if (upgraded === source) throw new Error("Pi native scrollback patch could not upgrade ToolExecutionComponent frame render method.");
    return upgraded;
  }
  if (source.includes(TOOL_EXECUTION_RENDER_OLD_PATCH)) {
    return source.replace(TOOL_EXECUTION_RENDER_OLD_PATCH, TOOL_EXECUTION_FRAME_RENDER);
  }
  if (source.includes(TOOL_EXECUTION_RENDER_UPSTREAM)) {
    return source.replace(TOOL_EXECUTION_RENDER_UPSTREAM, TOOL_EXECUTION_FRAME_RENDER);
  }
  throw new Error("Pi native scrollback patch could not find ToolExecutionComponent render method.");
}

export function patchToolExecutionSource(source) {
  let patched = source;
  if (patched.includes(TOOL_EXECUTION_TUI_IMPORT)) {
    patched = patched.replace(TOOL_EXECUTION_TUI_IMPORT, TOOL_EXECUTION_TUI_IMPORT_WITH_WIDTH);
  }
  if (!patched.includes(`${PATCH_MARKER}:tool-live-region`)) {
    patched = replaceRequired(
      patched,
      "    hideComponent = false;\n    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {\n",
      `    hideComponent = false;\n    transcript; // ${PATCH_MARKER}:tool-live-region\n    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd, transcript) {\n`,
      "ToolExecutionComponent constructor",
    );
  }
  if (!patched.includes("this.transcript?.markLive?.(this);")) {
    patched = replaceRequired(
      patched,
      "        this.ui = ui;\n        this.cwd = cwd;\n        this.addChild(new Spacer(1));\n",
      "        this.ui = ui;\n        this.cwd = cwd;\n        this.transcript = transcript;\n        this.transcript?.markLive?.(this);\n",
      "ToolExecutionComponent leading spacer",
    );
  }
  if (!patched.includes("if (isPartial) this.transcript?.markLive?.(this);")) {
    patched = replaceRequired(
      patched,
      "        this.result = result;\n        this.isPartial = isPartial;\n        this.updateDisplay();\n",
      "        this.result = result;\n        this.isPartial = isPartial;\n        if (isPartial) this.transcript?.markLive?.(this);\n        else this.transcript?.markFinal?.(this);\n        this.updateDisplay();\n",
      "ToolExecutionComponent result finalization",
    );
  }
  if (!patched.includes(`${PATCH_MARKER}:tool-live-methods`)) {
    patched = insertBeforeRequired(
      patched,
      "    render(width) {\n",
      `    transcriptWantsLeadingSpacer() {\n        return true;\n    }\n    isTranscriptLive() {\n        return this.isPartial || !this.result;\n    }\n    // ${PATCH_MARKER}:tool-live-methods\n`,
      "ToolExecutionComponent render method",
    );
  }
  patched = patchToolExecutionRenderSource(patched);
  return patched;
}

export function patchInteractiveModeSource(source) {
  if (source.includes(PATCH_MARKER)) return source;
  let patched = source;
  patched = replaceRequired(
    patched,
    "import { ToolExecutionComponent } from \"./components/tool-execution.js\";\n",
    `import { ToolExecutionComponent } from "./components/tool-execution.js";\nimport { TranscriptContainer } from "./components/transcript-container.js"; // ${PATCH_MARKER}:interactive-import\n`,
    "InteractiveMode tool import",
  );
  patched = replaceRequired(
    patched,
    "        this.chatContainer = new Container();\n",
    "        this.chatContainer = new TranscriptContainer();\n",
    "InteractiveMode chat container",
  );
  patched = patched.replaceAll(
    "}, this.getRegisteredToolDefinition(content.name), this.ui, this.sessionManager.getCwd());",
    "}, this.getRegisteredToolDefinition(content.name), this.ui, this.sessionManager.getCwd(), this.chatContainer);",
  );
  patched = patched.replaceAll(
    "}, this.getRegisteredToolDefinition(event.toolName), this.ui, this.sessionManager.getCwd());",
    "}, this.getRegisteredToolDefinition(event.toolName), this.ui, this.sessionManager.getCwd(), this.chatContainer);",
  );
  patched = replaceRequired(
    patched,
    "                    this.chatContainer.addChild(this.streamingComponent);\n                    this.streamingComponent.updateContent(this.streamingMessage);\n",
    "                    this.chatContainer.addChild(this.streamingComponent);\n                    this.chatContainer.markLive?.(this.streamingComponent);\n                    this.streamingComponent.updateContent(this.streamingMessage);\n",
    "InteractiveMode streaming message start",
  );
  patched = replaceRequired(
    patched,
    "                    this.streamingComponent = undefined;\n                    this.streamingMessage = undefined;\n                    this.footer.invalidate();\n",
    "                    this.chatContainer.markFinal?.(this.streamingComponent);\n                    this.streamingComponent = undefined;\n                    this.streamingMessage = undefined;\n                    this.footer.invalidate();\n",
    "InteractiveMode streaming message end",
  );
  patched = replaceRequired(
    patched,
    "            this.chatContainer.addChild(this.streamingComponent);\n        }\n        this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? \"hidden\" : \"visible\"}`);\n",
    "            this.chatContainer.addChild(this.streamingComponent);\n            this.chatContainer.markLive?.(this.streamingComponent);\n        }\n        this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? \"hidden\" : \"visible\"}`);\n",
    "InteractiveMode streaming re-add",
  );
  if (patched.includes("this.ui, this.sessionManager.getCwd());")) {
    throw new Error("InteractiveMode still has unpatched ToolExecutionComponent callsites.");
  }
  return patched;
}

export function applyNativeScrollbackFrameForTest(state, lines, stablePrefixLineCount, height, { widthChanged = false, heightChanged = false, splitFrame = false, resetNativeScrollback = false } = {}) {
  state.nativeScrollbackLastDelta = 0;
  const managedHeight = Math.max(1, height);
  if (widthChanged || heightChanged || splitFrame || resetNativeScrollback) {
    state.nativeScrollbackCommittedRows = 0;
    return lines;
  }
  const maxCommit = Math.max(0, lines.length - managedHeight);
  const requestedDelta = Math.max(0, Math.min(stablePrefixLineCount, maxCommit));
  if (requestedDelta > 0) {
    const offscreenPreviousRows = Math.max(0, state.previousLines.length - managedHeight);
    const safeDelta = Math.min(requestedDelta, offscreenPreviousRows);
    if (safeDelta > 0) {
      state.previousLines = state.previousLines.slice(safeDelta);
      state.cursorRow = Math.max(0, state.cursorRow - safeDelta);
      state.hardwareCursorRow = Math.max(0, state.hardwareCursorRow - safeDelta);
      state.previousViewportTop = Math.max(0, state.previousViewportTop - safeDelta);
      state.maxLinesRendered = Math.max(0, state.maxLinesRendered - safeDelta);
      state.nativeScrollbackCommittedRows += safeDelta;
      state.nativeScrollbackLastDelta = safeDelta;
      return lines.slice(safeDelta);
    }
  }
  return lines;
}

function writeTranscriptContainer(targetPackage) {
  const componentsDir = path.join(targetPackage, "dist", "modes", "interactive", "components");
  mkdirSync(componentsDir, { recursive: true });
  const jsPath = path.join(componentsDir, "transcript-container.js");
  const dtsPath = path.join(componentsDir, "transcript-container.d.ts");
  const previousJs = existsSync(jsPath) ? readFileSync(jsPath, "utf8") : undefined;
  if (previousJs !== TRANSCRIPT_CONTAINER_SOURCE) {
    writeFileSync(jsPath, TRANSCRIPT_CONTAINER_SOURCE, "utf8");
    console.log(`Patched Pi transcript container: ${jsPath}`);
  }
  const previousDts = existsSync(dtsPath) ? readFileSync(dtsPath, "utf8") : undefined;
  if (previousDts !== TRANSCRIPT_CONTAINER_DTS) {
    writeFileSync(dtsPath, TRANSCRIPT_CONTAINER_DTS, "utf8");
  }
}

function patchFile(filePath, patcher, label) {
  const source = requireTargetFile(filePath);
  const patched = patcher(source);
  if (patched !== source) {
    writeFileSync(filePath, patched, "utf8");
    console.log(`Patched ${label}: ${filePath}`);
  } else {
    console.log(`${label} already patched: ${filePath}`);
  }
}

export function resolveTuiPath() {
  const override = process.env.PI_TUI_DIST;
  const candidates = override
    ? [override]
    : [
        path.join(packageDir(), "node_modules", "@earendil-works", "pi-tui", "dist", "tui.js"),
        path.join(globalNodeModules(), "@earendil-works", "pi-tui", "dist", "tui.js"),
      ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`Could not locate Pi's tui.js. Looked in:\n  ${candidates.join("\n  ")}`);
}

export function patchInstalledPiScrollback() {
  const targetPackage = packageDir();
  writeTranscriptContainer(targetPackage);
  patchFile(resolveTuiPath(), patchNativeScrollbackTuiSource, "Pi native scrollback TUI");
  patchFile(path.join(targetPackage, "dist", "modes", "interactive", "components", "tool-execution.js"), patchToolExecutionSource, "Pi tool execution scrollback frame");
  patchFile(path.join(targetPackage, "dist", "modes", "interactive", "interactive-mode.js"), patchInteractiveModeSource, "Pi transcript scrollback mode");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  patchInstalledPiScrollback();
}
