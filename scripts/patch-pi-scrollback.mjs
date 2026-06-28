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
    addChild(component) {
        super.addChild(component);
        if (component?.isTranscriptLive?.()) {
            this.liveComponents.add(component);
        }
    }
    removeChild(component) {
        super.removeChild(component);
        this.liveComponents.delete(component);
    }
    clear() {
        super.clear();
        this.liveComponents.clear();
    }
    markLive(component) {
        if (component && this.children.includes(component)) {
            this.liveComponents.add(component);
        }
    }
    markFinal(component) {
        this.liveComponents.delete(component);
    }
    isLive(component) {
        return this.liveComponents.has(component) || component?.isTranscriptLive?.() === true;
    }
    render(width) {
        const lines = [];
        for (const child of this.children) {
            if (lines.length > 0 && child?.transcriptWantsLeadingSpacer?.()) {
                lines.push("");
            }
            lines.push(...child.render(width));
        }
        return lines;
    }
    getNativeScrollbackStableLineCount(width) {
        let count = 0;
        for (const child of this.children) {
            if (this.isLive(child)) {
                break;
            }
            if (count > 0 && child?.transcriptWantsLeadingSpacer?.()) {
                count += 1;
            }
            count += child.render(width).length;
        }
        return count;
    }
}

export class TranscriptContainer extends NativeScrollbackLiveRegion {
}
// ${PATCH_MARKER}:transcript-container
`;

export const TRANSCRIPT_CONTAINER_DTS = `import { Container, type Component } from "@earendil-works/pi-tui";
export declare class NativeScrollbackLiveRegion extends Container {
    private liveComponents;
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    markLive(component: Component): void;
    markFinal(component: Component): void;
    isLive(component: Component): boolean;
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
    renderNativeScrollbackFrame(width, height) {
        const lines = [];
        let lineOffset = 0;
        let stablePrefixLineCount = 0;
        let foundLiveRegion = false;
        for (const child of this.children) {
            const childLines = child.render(width);
            if (!foundLiveRegion && typeof child.getNativeScrollbackStableLineCount === "function") {
                const stableChildLines = Math.max(0, Math.min(childLines.length, child.getNativeScrollbackStableLineCount(width, height, childLines)));
                stablePrefixLineCount = lineOffset + stableChildLines;
                foundLiveRegion = true;
            }
            lines.push(...childLines);
            lineOffset += childLines.length;
        }
        return { lines, stablePrefixLineCount: foundLiveRegion ? stablePrefixLineCount : 0 };
    }
    applyNativeScrollbackFrame(lines, stablePrefixLineCount, height, widthChanged, heightChanged) {
        this.nativeScrollbackLastDelta = 0;
        const managedHeight = Math.max(1, height);
        if (widthChanged || heightChanged || globalThis.__piSplitFrame) {
            this.nativeScrollbackCommittedRows = 0;
            return lines;
        }
        const maxCommit = Math.max(0, lines.length - managedHeight);
        const targetCommittedRows = Math.max(0, Math.min(stablePrefixLineCount, maxCommit));
        if (targetCommittedRows < this.nativeScrollbackCommittedRows) {
            this.nativeScrollbackCommittedRows = 0;
            this.previousLines = [];
            this.previousKittyImageIds = new Set();
            this.cursorRow = 0;
            this.hardwareCursorRow = 0;
            this.previousViewportTop = 0;
            this.maxLinesRendered = 0;
            return lines;
        }
        const requestedDelta = targetCommittedRows - this.nativeScrollbackCommittedRows;
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
            }
        }
        return this.nativeScrollbackCommittedRows > 0 ? lines.slice(this.nativeScrollbackCommittedRows) : lines;
    }
    // ${PATCH_MARKER}:methods:end
`;

export function patchNativeScrollbackTuiSource(source) {
  if (source.includes(PATCH_MARKER)) return source;
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
    "        // Render all components to get new lines\n        let newLines = this.render(width);\n",
    "        // Render all components to get new lines\n        const nativeScrollbackFrame = this.renderNativeScrollbackFrame(width, height);\n        let newLines = nativeScrollbackFrame.lines;\n        let nativeStablePrefixLineCount = nativeScrollbackFrame.stablePrefixLineCount;\n",
    "TUI render-frame anchor",
  );
  patched = replaceRequired(
    patched,
    "        // Extract cursor position before applying line resets (marker must be found first)\n",
    "        newLines = this.applyNativeScrollbackFrame(newLines, nativeStablePrefixLineCount, height, widthChanged, heightChanged);\n        if (this.nativeScrollbackLastDelta > 0) {\n            const nativeScrollbackDelta = this.nativeScrollbackLastDelta;\n            prevViewportTop = Math.max(0, prevViewportTop - nativeScrollbackDelta);\n            viewportTop = Math.max(0, viewportTop - nativeScrollbackDelta);\n            hardwareCursorRow = Math.max(0, hardwareCursorRow - nativeScrollbackDelta);\n        }\n        // Extract cursor position before applying line resets (marker must be found first)\n",
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
  return patched;
}

export function patchToolExecutionSource(source) {
  if (source.includes(PATCH_MARKER)) return source;
  let patched = source;
  patched = replaceRequired(
    patched,
    "    hideComponent = false;\n    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {\n",
    `    hideComponent = false;\n    transcript; // ${PATCH_MARKER}:tool-live-region\n    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd, transcript) {\n`,
    "ToolExecutionComponent constructor",
  );
  patched = replaceRequired(
    patched,
    "        this.ui = ui;\n        this.cwd = cwd;\n        this.addChild(new Spacer(1));\n",
    "        this.ui = ui;\n        this.cwd = cwd;\n        this.transcript = transcript;\n        this.transcript?.markLive?.(this);\n",
    "ToolExecutionComponent leading spacer",
  );
  patched = replaceRequired(
    patched,
    "        this.result = result;\n        this.isPartial = isPartial;\n        this.updateDisplay();\n",
    "        this.result = result;\n        this.isPartial = isPartial;\n        if (isPartial) this.transcript?.markLive?.(this);\n        else this.transcript?.markFinal?.(this);\n        this.updateDisplay();\n",
    "ToolExecutionComponent result finalization",
  );
  patched = insertBeforeRequired(
    patched,
    "    render(width) {\n",
    `    transcriptWantsLeadingSpacer() {\n        return true;\n    }\n    isTranscriptLive() {\n        return this.isPartial || !this.result;\n    }\n    // ${PATCH_MARKER}:tool-live-methods\n`,
    "ToolExecutionComponent render method",
  );
  patched = replaceRequired(
    patched,
    "            if (contentLines.length > 0) {\n                lines.push(\"\");\n                lines.push(...contentLines);\n            }\n",
    "            if (contentLines.length > 0) {\n                lines.push(...contentLines);\n            }\n",
    "ToolExecutionComponent self-render spacer",
  );
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

export function applyNativeScrollbackFrameForTest(state, lines, stablePrefixLineCount, height, { widthChanged = false, heightChanged = false, splitFrame = false } = {}) {
  state.nativeScrollbackLastDelta = 0;
  const managedHeight = Math.max(1, height);
  if (widthChanged || heightChanged || splitFrame) {
    state.nativeScrollbackCommittedRows = 0;
    return lines;
  }
  const maxCommit = Math.max(0, lines.length - managedHeight);
  const targetCommittedRows = Math.max(0, Math.min(stablePrefixLineCount, maxCommit));
  if (targetCommittedRows < state.nativeScrollbackCommittedRows) {
    state.nativeScrollbackCommittedRows = 0;
    state.previousLines = [];
    state.cursorRow = 0;
    state.hardwareCursorRow = 0;
    state.previousViewportTop = 0;
    state.maxLinesRendered = 0;
    return lines;
  }
  const requestedDelta = targetCommittedRows - state.nativeScrollbackCommittedRows;
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
    }
  }
  return state.nativeScrollbackCommittedRows > 0 ? lines.slice(state.nativeScrollbackCommittedRows) : lines;
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
  patchFile(path.join(targetPackage, "dist", "modes", "interactive", "components", "tool-execution.js"), patchToolExecutionSource, "Pi tool execution live-region");
  patchFile(path.join(targetPackage, "dist", "modes", "interactive", "interactive-mode.js"), patchInteractiveModeSource, "Pi transcript scrollback mode");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  patchInstalledPiScrollback();
}
