import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_MARKER = "SWIFTENGINEER_TABBED_SETTINGS_PATCH";

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
  if (!existsSync(filePath)) {
    throw new Error(`Expected Pi settings selector at ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

function insertAfterRequired(source, anchor, insertion, label) {
  const index = source.indexOf(anchor);
  if (index < 0) {
    throw new Error(`Could not restore ${label}; expected patched Pi settings selector anchor was not found.`);
  }
  return source.slice(0, index + anchor.length) + insertion + source.slice(index + anchor.length);
}

function insertBeforeRequired(source, anchor, insertion, label) {
  const index = source.indexOf(anchor);
  if (index < 0) {
    throw new Error(`Could not restore ${label}; expected patched Pi settings selector anchor was not found.`);
  }
  return source.slice(0, index) + insertion + source.slice(index);
}

function ensureProviderSettings(source) {
  const needsTransport = !source.includes('id: "transport"');
  const needsHttpIdleTimeout = !source.includes('id: "http-idle-timeout"');
  if (!needsTransport && !needsHttpIdleTimeout) return source;

  let patched = source;
  let tabMappings = "";
  if (needsTransport) tabMappings += '    transport: "network",\n';
  if (needsHttpIdleTimeout) tabMappings += '    "http-idle-timeout": "network",\n';
  patched = insertAfterRequired(
    patched,
    '    "follow-up-mode": "interaction",\n',
    tabMappings,
    "provider settings tab mappings",
  );

  let settingItems = "";
  if (needsTransport) {
    settingItems += `            {
                id: "transport",
                label: "Transport",
                description: "Preferred transport for providers that support multiple transports. Choose sse to disable OpenAI Codex WebSockets.",
                currentValue: config.transport,
                values: ["sse", "websocket", "websocket-cached", "auto"],
            },
`;
  }
  if (needsHttpIdleTimeout) {
    settingItems += `            {
                id: "http-idle-timeout",
                label: "HTTP idle timeout",
                description: "Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
                currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
                values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
            },
`;
  }
  patched = insertBeforeRequired(
    patched,
    '            {\n                id: "hide-thinking",\n',
    settingItems,
    "provider settings list items",
  );

  let changeHandlers = "";
  if (needsTransport) {
    changeHandlers += `                case "transport":
                    callbacks.onTransportChange(newValue);
                    break;
`;
  }
  if (needsHttpIdleTimeout) {
    changeHandlers += `                case "http-idle-timeout": {
                    const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
                    if (choice) callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
                    break;
                }
`;
  }
  return insertAfterRequired(
    patched,
    '                case "follow-up-mode":\n                    callbacks.onFollowUpModeChange(newValue);\n                    break;\n',
    changeHandlers,
    "provider settings change handlers",
  );
}

export function patchSettingsSelector(source) {
  if (source.includes(PATCH_MARKER)) {
    let patched = source;
    if (patched.includes("/*const SETTINGS_TABS")) {
      patched = patched.replace("/*const SETTINGS_TABS", "const SETTINGS_TABS");
    }
    if (patched.includes("muted: (this.settingsListsByTab[tab.id]?.render(1).length ?? 0) === 0")) {
      patched = patched.replace(
        'this.tabBar = new TabBar("Settings", SETTINGS_TABS.map((tab) => ({ ...tab, muted: (this.settingsListsByTab[tab.id]?.render(1).length ?? 0) === 0 })), tabTheme());',
        'this.tabBar = new TabBar("Settings", SETTINGS_TABS.map((tab) => ({ ...tab })), tabTheme());',
      );
    }
    patched = patched.replace(
      'description: "Preferred transport for providers that support multiple transports",',
      'description: "Preferred transport for providers that support multiple transports. Choose sse to disable OpenAI Codex WebSockets.",',
    );
    return ensureProviderSettings(patched);
  }

  const originalImport = 'import { Container, getCapabilities, SelectList, SettingsList, Spacer, Text, } from "@earendil-works/pi-tui";';
  const patchedImport = 'import { Container, getCapabilities, matchesKey, SelectList, SettingsList, Spacer, Text, truncateToWidth, visibleWidth, } from "@earendil-works/pi-tui";';
  if (!source.includes(originalImport)) {
    throw new Error("Pi settings selector import did not match the expected upstream shape.");
  }

  const classStart = source.indexOf("export class SettingsSelectorComponent extends Container {");
  const replaceStart = source.lastIndexOf("/**", classStart);
  const sourceMapStart = source.lastIndexOf("\n//# sourceMappingURL=settings-selector.js.map");
  if (classStart < 0 || replaceStart < 0 || sourceMapStart < 0 || sourceMapStart <= classStart) {
    throw new Error("Pi settings selector class did not match the expected upstream shape.");
  }

  const replacementClass = String.raw`const SETTINGS_TABS = [
    { id: "interaction", label: "Interaction", short: "Interact" },
    { id: "display", label: "Display", short: "Display" },
    { id: "images", label: "Images", short: "Images" },
    { id: "context", label: "Context", short: "Context" },
    { id: "network", label: "Network", short: "Network" },
    { id: "project", label: "Project", short: "Project" },
];
const SETTINGS_TAB_BY_ID = {
    autocompact: "context",
    "show-images": "images",
    "image-width-cells": "images",
    "auto-resize-images": "images",
    "block-images": "images",
    "skill-commands": "context",
    "steering-mode": "interaction",
    "follow-up-mode": "interaction",
    transport: "network",
    "http-idle-timeout": "network",
    "hide-thinking": "display",
    "collapse-changelog": "display",
    "quiet-startup": "display",
    "install-telemetry": "network",
    "default-project-trust": "project",
    "double-escape-action": "interaction",
    "tree-filter-mode": "project",
    warnings: "project",
    thinking: "context",
    theme: "display",
    "show-hardware-cursor": "display",
    "editor-padding": "display",
    "autocomplete-max-visible": "display",
    "clear-on-shrink": "display",
    "terminal-progress": "display",
};
function settingsTabIdForItem(item) {
    return SETTINGS_TAB_BY_ID[item.id] ?? "interaction";
}
function tabTheme() {
    return {
        label: (text) => theme.fg("muted", text),
        activeTab: (text) => theme.bold(theme.fg("accent", text)),
        inactiveTab: (text) => theme.fg("text", text),
        hint: (text) => theme.fg("dim", text),
        mutedTab: (text) => theme.fg("dim", text),
        hoverTab: (text) => theme.underline(theme.fg("accent", text)),
    };
}
class TabBar {
    tabs;
    activeIndex;
    tabTheme;
    label;
    hoverTabId = null;
    hitZones = [];
    onTabChange;
    showHint = true;
    constructor(label, tabs, tabBarTheme, initialIndex = 0) {
        this.label = label;
        this.tabs = tabs;
        this.tabTheme = tabBarTheme;
        this.activeIndex = Math.max(0, Math.min(initialIndex, Math.max(0, tabs.length - 1)));
    }
    getActiveTab() {
        return this.tabs[this.activeIndex];
    }
    setActiveIndex(index) {
        if (this.tabs.length === 0) {
            this.activeIndex = 0;
            return;
        }
        const newIndex = Math.max(0, Math.min(index, this.tabs.length - 1));
        if (newIndex !== this.activeIndex) {
            this.activeIndex = newIndex;
            const tab = this.tabs[this.activeIndex];
            if (tab) this.onTabChange?.(tab, this.activeIndex);
        }
    }
    nextTab() {
        this.stepTab(1);
    }
    prevTab() {
        this.stepTab(-1);
    }
    stepTab(delta) {
        const length = this.tabs.length;
        if (length === 0) return;
        for (let step = 1; step <= length; step++) {
            const index = (((this.activeIndex + delta * step) % length) + length) % length;
            const tab = this.tabs[index];
            if (tab && !tab.muted) {
                this.setActiveIndex(index);
                return;
            }
        }
    }
    handleInput(data) {
        if (matchesKey(data, "tab") || matchesKey(data, "right")) {
            this.nextTab();
            return true;
        }
        if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
            this.prevTab();
            return true;
        }
        return false;
    }
    render(width) {
        const maxWidth = Math.max(1, width);
        const labels = this.tabs.map((tab) => tab.label);
        let chunks = this.buildChunks(labels);
        if (this.totalWidth(chunks) > maxWidth) {
            const collapseOrder = this.tabs
                .map((_, index) => index)
                .filter((index) => index !== this.activeIndex && this.tabs[index]?.short !== undefined)
                .sort((a, b) => Math.abs(b - this.activeIndex) - Math.abs(a - this.activeIndex));
            for (const index of collapseOrder) {
                const tab = this.tabs[index];
                if (!tab) continue;
                labels[index] = tab.short ?? tab.label;
                chunks = this.buildChunks(labels);
                if (this.totalWidth(chunks) <= maxWidth) break;
            }
        }
        return this.renderChunks(chunks, maxWidth);
    }
    buildChunks(labels) {
        const chunks = [];
        if (this.label) {
            chunks.push({ text: this.tabTheme.label(this.label + ":") });
            chunks.push({ text: "  " });
        }
        for (let index = 0; index < this.tabs.length; index++) {
            const tab = this.tabs[index];
            if (!tab) continue;
            const hovered = tab.id === this.hoverTabId && !tab.muted && index !== this.activeIndex;
            const style = tab.muted
                ? (this.tabTheme.mutedTab ?? this.tabTheme.inactiveTab)
                : index === this.activeIndex
                    ? this.tabTheme.activeTab
                    : hovered
                        ? (this.tabTheme.hoverTab ?? this.tabTheme.inactiveTab)
                        : this.tabTheme.inactiveTab;
            chunks.push({ text: style(" " + (labels[index] ?? tab.label) + " "), tabIndex: index });
            if (index < this.tabs.length - 1) chunks.push({ text: "  " });
        }
        if (this.showHint) {
            chunks.push({ text: "  " });
            chunks.push({ text: this.tabTheme.hint("(tab/←/→)") });
        }
        return chunks;
    }
    totalWidth(chunks) {
        return chunks.reduce((sum, chunk) => sum + visibleWidth(chunk.text), 0);
    }
    renderChunks(chunks, maxWidth) {
        this.hitZones = [];
        const lines = [];
        let currentLine = "";
        let currentWidth = 0;
        for (const chunk of chunks) {
            const chunkWidth = visibleWidth(chunk.text);
            if (chunkWidth <= 0) continue;
            if (chunkWidth > maxWidth) {
                if (currentLine) {
                    lines.push(currentLine);
                    currentLine = "";
                    currentWidth = 0;
                }
                if (chunk.tabIndex !== undefined) {
                    this.hitZones.push({ line: lines.length, start: 0, end: maxWidth, index: chunk.tabIndex });
                }
                lines.push(truncateToWidth(chunk.text, maxWidth));
                continue;
            }
            if (currentWidth > 0 && currentWidth + chunkWidth > maxWidth) {
                lines.push(currentLine);
                currentLine = "";
                currentWidth = 0;
            }
            if (chunk.tabIndex !== undefined) {
                this.hitZones.push({ line: lines.length, start: currentWidth, end: currentWidth + chunkWidth, index: chunk.tabIndex });
            }
            currentLine += chunk.text;
            currentWidth += chunkWidth;
        }
        if (currentLine) lines.push(currentLine);
        return lines.length > 0 ? lines : [""];
    }
    tabAt(line, col) {
        for (const zone of this.hitZones) {
            if (zone.line === line && col >= zone.start && col < zone.end) {
                return this.tabs[zone.index];
            }
        }
        return undefined;
    }
    setHoverTab(id) {
        this.hoverTabId = id;
    }
    invalidate() {
        this.hitZones = [];
    }
}
/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
    settingsList;
    tabBar;
    settingsListsByTab = {};
    topBorder = new DynamicBorder();
    bottomBorder = new DynamicBorder();
    constructor(config, callbacks) {
        super();
        const supportsImages = getCapabilities().images;
        const followUpKey = keyDisplayText("app.message.followUp");
        let currentWarnings = { ...config.warnings };
        const items = [
            {
                id: "autocompact",
                label: "Auto-compact",
                description: "Automatically compact context when it gets too large",
                currentValue: config.autoCompact ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "steering-mode",
                label: "Steering mode",
                description: "Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
                currentValue: config.steeringMode,
                values: ["one-at-a-time", "all"],
            },
            {
                id: "follow-up-mode",
                label: "Follow-up mode",
                description: followUpKey + " queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
                currentValue: config.followUpMode,
                values: ["one-at-a-time", "all"],
            },
            {
                id: "transport",
                label: "Transport",
                description: "Preferred transport for providers that support multiple transports. Choose sse to disable OpenAI Codex WebSockets.",
                currentValue: config.transport,
                values: ["sse", "websocket", "websocket-cached", "auto"],
            },
            {
                id: "http-idle-timeout",
                label: "HTTP idle timeout",
                description: "Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
                currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
                values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
            },
            {
                id: "hide-thinking",
                label: "Hide thinking",
                description: "Hide thinking blocks in assistant responses",
                currentValue: config.hideThinkingBlock ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "collapse-changelog",
                label: "Collapse changelog",
                description: "Show condensed changelog after updates",
                currentValue: config.collapseChangelog ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "quiet-startup",
                label: "Quiet startup",
                description: "Disable verbose printing at startup",
                currentValue: config.quietStartup ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "install-telemetry",
                label: "Install telemetry",
                description: "Send an anonymous version/update ping after changelog-detected updates",
                currentValue: config.enableInstallTelemetry ? "true" : "false",
                values: ["true", "false"],
            },
            {
                id: "default-project-trust",
                label: "Default project trust",
                description: "Fallback behavior when no extension or saved trust decision decides project trust",
                currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
                values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
            },
            {
                id: "double-escape-action",
                label: "Double-escape action",
                description: "Action when pressing Escape twice with empty editor",
                currentValue: config.doubleEscapeAction,
                values: ["tree", "fork", "none"],
            },
            {
                id: "tree-filter-mode",
                label: "Tree filter mode",
                description: "Default filter when opening /tree",
                currentValue: config.treeFilterMode,
                values: ["default", "no-tools", "user-only", "labeled-only", "all"],
            },
            {
                id: "warnings",
                label: "Warnings",
                description: "Enable or disable individual warnings",
                currentValue: "configure",
                submenu: (_currentValue, done) => new WarningSettingsSubmenu(currentWarnings, (warnings) => {
                    currentWarnings = warnings;
                    callbacks.onWarningsChange(warnings);
                }, () => done()),
            },
            {
                id: "thinking",
                label: "Thinking level",
                description: "Reasoning depth for thinking-capable models",
                currentValue: config.thinkingLevel,
                submenu: (currentValue, done) => new SelectSubmenu("Thinking Level", "Select reasoning depth for thinking-capable models", config.availableThinkingLevels.map((level) => ({
                    value: level,
                    label: level,
                    description: THINKING_DESCRIPTIONS[level],
                })), currentValue, (value) => {
                    callbacks.onThinkingLevelChange(value);
                    done(value);
                }, () => done()),
            },
            {
                id: "theme",
                label: "Theme",
                description: "Color theme for the interface",
                currentValue: config.currentTheme,
                submenu: (currentValue, done) => new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
            },
        ];
        if (supportsImages) {
            items.splice(1, 0, {
                id: "show-images",
                label: "Show images",
                description: "Render images inline in terminal",
                currentValue: config.showImages ? "true" : "false",
                values: ["true", "false"],
            });
            items.splice(2, 0, {
                id: "image-width-cells",
                label: "Image width",
                description: "Preferred inline image width in terminal cells",
                currentValue: String(config.imageWidthCells),
                values: ["60", "80", "120"],
            });
        }
        items.splice(supportsImages ? 3 : 1, 0, {
            id: "auto-resize-images",
            label: "Auto-resize images",
            description: "Resize large images to 2000x2000 max for better model compatibility",
            currentValue: config.autoResizeImages ? "true" : "false",
            values: ["true", "false"],
        });
        const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
        items.splice(autoResizeIndex + 1, 0, {
            id: "block-images",
            label: "Block images",
            description: "Prevent images from being sent to LLM providers",
            currentValue: config.blockImages ? "true" : "false",
            values: ["true", "false"],
        });
        const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
        items.splice(blockImagesIndex + 1, 0, {
            id: "skill-commands",
            label: "Skill commands",
            description: "Register skills as /skill:name commands",
            currentValue: config.enableSkillCommands ? "true" : "false",
            values: ["true", "false"],
        });
        const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
        items.splice(skillCommandsIndex + 1, 0, {
            id: "show-hardware-cursor",
            label: "Show hardware cursor",
            description: "Show the terminal cursor while still positioning it for IME support",
            currentValue: config.showHardwareCursor ? "true" : "false",
            values: ["true", "false"],
        });
        const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
        items.splice(hardwareCursorIndex + 1, 0, {
            id: "editor-padding",
            label: "Editor padding",
            description: "Horizontal padding for input editor (0-3)",
            currentValue: String(config.editorPaddingX),
            values: ["0", "1", "2", "3"],
        });
        const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
        items.splice(editorPaddingIndex + 1, 0, {
            id: "autocomplete-max-visible",
            label: "Autocomplete max items",
            description: "Max visible items in autocomplete dropdown (3-20)",
            currentValue: String(config.autocompleteMaxVisible),
            values: ["3", "5", "7", "10", "15", "20"],
        });
        const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
        items.splice(autocompleteIndex + 1, 0, {
            id: "clear-on-shrink",
            label: "Clear on shrink",
            description: "Clear empty rows when content shrinks (may cause flicker)",
            currentValue: config.clearOnShrink ? "true" : "false",
            values: ["true", "false"],
        });
        const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
        items.splice(clearOnShrinkIndex + 1, 0, {
            id: "terminal-progress",
            label: "Terminal progress",
            description: "Show OSC 9;4 progress indicators in the terminal tab bar",
            currentValue: config.showTerminalProgress ? "true" : "false",
            values: ["true", "false"],
        });
        const onSettingChange = (id, newValue) => {
            switch (id) {
                case "autocompact":
                    callbacks.onAutoCompactChange(newValue === "true");
                    break;
                case "show-images":
                    callbacks.onShowImagesChange(newValue === "true");
                    break;
                case "image-width-cells":
                    callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
                    break;
                case "auto-resize-images":
                    callbacks.onAutoResizeImagesChange(newValue === "true");
                    break;
                case "block-images":
                    callbacks.onBlockImagesChange(newValue === "true");
                    break;
                case "skill-commands":
                    callbacks.onEnableSkillCommandsChange(newValue === "true");
                    break;
                case "steering-mode":
                    callbacks.onSteeringModeChange(newValue);
                    break;
                case "follow-up-mode":
                    callbacks.onFollowUpModeChange(newValue);
                    break;
                case "transport":
                    callbacks.onTransportChange(newValue);
                    break;
                case "http-idle-timeout": {
                    const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
                    if (choice) callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
                    break;
                }
                case "hide-thinking":
                    callbacks.onHideThinkingBlockChange(newValue === "true");
                    break;
                case "collapse-changelog":
                    callbacks.onCollapseChangelogChange(newValue === "true");
                    break;
                case "quiet-startup":
                    callbacks.onQuietStartupChange(newValue === "true");
                    break;
                case "install-telemetry":
                    callbacks.onEnableInstallTelemetryChange(newValue === "true");
                    break;
                case "default-project-trust": {
                    const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
                    if (defaultProjectTrust) callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
                    break;
                }
                case "double-escape-action":
                    callbacks.onDoubleEscapeActionChange(newValue);
                    break;
                case "tree-filter-mode":
                    callbacks.onTreeFilterModeChange(newValue);
                    break;
                case "show-hardware-cursor":
                    callbacks.onShowHardwareCursorChange(newValue === "true");
                    break;
                case "editor-padding":
                    callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
                    break;
                case "autocomplete-max-visible":
                    callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
                    break;
                case "clear-on-shrink":
                    callbacks.onClearOnShrinkChange(newValue === "true");
                    break;
                case "terminal-progress":
                    callbacks.onShowTerminalProgressChange(newValue === "true");
                    break;
                case "theme":
                    callbacks.onThemeChange(newValue);
                    break;
            }
        };
        for (const tab of SETTINGS_TABS) {
            const tabItems = items.filter((item) => settingsTabIdForItem(item) === tab.id);
            this.settingsListsByTab[tab.id] = new SettingsList(tabItems, 10, getSettingsListTheme(), onSettingChange, callbacks.onCancel, { enableSearch: true });
        }
        this.tabBar = new TabBar("Settings", SETTINGS_TABS.map((tab) => ({ ...tab })), tabTheme());
        this.tabBar.showHint = true;
        this.tabBar.onTabChange = (tab) => {
            const list = this.settingsListsByTab[tab.id];
            if (list) this.settingsList = list;
        };
        const initialTab = this.tabBar.getActiveTab();
        const initialList = initialTab ? this.settingsListsByTab[initialTab.id] : undefined;
        this.settingsList = initialList ?? new SettingsList(items, 10, getSettingsListTheme(), onSettingChange, callbacks.onCancel, { enableSearch: true });
    }
    handleInput(data) {
        if (this.tabBar.handleInput(data)) return;
        this.settingsList.handleInput(data);
    }
    invalidate() {
        this.tabBar.invalidate();
        this.settingsList.invalidate();
        this.topBorder.invalidate();
        this.bottomBorder.invalidate();
    }
    render(width) {
        const lines = [];
        lines.push(...this.topBorder.render(width));
        lines.push(...this.tabBar.render(width));
        const dividerWidth = Math.max(1, width);
        lines.push(theme.fg("borderMuted", "─".repeat(dividerWidth)));
        lines.push(...this.settingsList.render(width));
        lines.push(...this.bottomBorder.render(width));
        return lines;
    }
    getSettingsList() {
        return this;
    }
}
// ${PATCH_MARKER}`;

  return (source.slice(0, replaceStart) + replacementClass + source.slice(sourceMapStart))
    .replace(originalImport, patchedImport);
}

export function patchSettingsManager(source) {
  const upstreamDefault = '        return this.settings.transport ?? "auto";';
  const patchedDefault = '        return this.settings.transport ?? "sse";';
  if (source.includes(patchedDefault)) return source;
  if (!source.includes(upstreamDefault)) {
    throw new Error("Pi settings manager transport default did not match the expected upstream shape.");
  }
  return source.replace(upstreamDefault, patchedDefault);
}


export function patchInstalledSettingsSelector() {
  const targetPackage = packageDir();
  const settingsSelectorPath = path.join(targetPackage, "dist", "modes", "interactive", "components", "settings-selector.js");
  const settingsSelectorSource = requireTargetFile(settingsSelectorPath);
  const patchedSettingsSelector = patchSettingsSelector(settingsSelectorSource);
  if (patchedSettingsSelector !== settingsSelectorSource) {
    writeFileSync(settingsSelectorPath, patchedSettingsSelector, "utf8");
    console.log(`Patched Pi tabbed settings selector: ${settingsSelectorPath}`);
  } else {
    console.log(`Pi tabbed settings selector already patched: ${settingsSelectorPath}`);
  }

  const settingsManagerPath = path.join(targetPackage, "dist", "core", "settings-manager.js");
  const settingsManagerSource = requireTargetFile(settingsManagerPath);
  const patchedSettingsManager = patchSettingsManager(settingsManagerSource);
  if (patchedSettingsManager !== settingsManagerSource) {
    writeFileSync(settingsManagerPath, patchedSettingsManager, "utf8");
    console.log(`Patched Pi transport default: ${settingsManagerPath}`);
  } else {
    console.log(`Pi transport default already patched: ${settingsManagerPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  patchInstalledSettingsSelector();
}
