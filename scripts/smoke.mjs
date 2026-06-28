import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
process.env.PI_TASK_MAX_RUNTIME_MS ??= "100";
process.env.PI_TASK_KILL_GRACE_MS ??= "50";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const tools = new Map();
const commands = new Map();
const renderers = new Map();
const shortcuts = new Map();
const sentMessages = [];
const handlers = [];

function execCommand(command, args, options = {}) {
  const completion = Promise.withResolvers();
  const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.on("close", (code, signal) => completion.resolve({ stdout, stderr, code: code ?? 0, killed: signal !== null }));
  child.on("error", (error) => completion.resolve({ stdout, stderr: `${stderr}${error.message}\n`, code: 1, killed: false }));
  options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  return completion.promise;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for smoke condition");
}

const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
  registerShortcut(shortcut, options) { shortcuts.set(shortcut, options); },
  on(event, handler) { handlers.push({ event, handler }); },
  sendMessage(message, options) { sentMessages.push({ ...message, options }); },
  exec: execCommand,
  getActiveTools() { return Array.from(tools.keys()); },
  getAllTools() {
    return Array.from(tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
      sourceInfo: { source: "smoke" },
    }));
  },
};

for (const file of [
  "extensions/system-prompt.ts",
  "extensions/tool-policy.ts",
  "extensions/search.ts",
  "extensions/ast-tools.ts",
  "extensions/todo-write.ts",
  "extensions/ask.ts",
  "extensions/web-search.ts",
  "extensions/context.ts",
  "extensions/tui-powerline.ts",
  "extensions/task/index.ts",
  "extensions/subagent-view/index.ts",
]) {
  const mod = await jiti.import(path.join(root, file));
  mod.default(pi);
}

const ctx = { cwd: root, hasUI: false, ui: {} };

const search = tools.get("search");
const searchResult = await search.execute("smoke-search", { pattern: "AGENT_PROMPTS", paths: "extensions/task/index.ts" }, undefined, undefined, ctx);
if (!searchResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("search smoke failed");

const smokeTmp = await mkdtemp(path.join(os.tmpdir(), "pi-harness-smoke-"));
try {
  const longLineFile = path.join(smokeTmp, "huge.js.map");
  await writeFile(longLineFile, `needle${"x".repeat(200_000)}\n`, "utf8");
  const cappedSearchResult = await search.execute("smoke-search-cap", { pattern: "needle", paths: longLineFile, context: 0, gitignore: false }, undefined, undefined, ctx);
  const cappedSearchText = cappedSearchResult.content[0].text;
  if (Buffer.byteLength(cappedSearchText, "utf8") > 60 * 1024) throw new Error("search cap smoke failed");
  if (!cappedSearchText.includes("line truncated")) throw new Error("search long-line truncation smoke failed");

  const fakePi = path.join(smokeTmp, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
const event = {
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "background result" }] },
};
console.log(JSON.stringify(event));
`, "utf8");
  await chmod(fakePi, 0o755);
  const previousPiCommand = process.env.SWIFT_PI_COMMAND;
  process.env.SWIFT_PI_COMMAND = fakePi;
  try {
    const task = tools.get("task");
    const sentStart = sentMessages.length;
    const taskResult = await task.execute("smoke-task-background", { agent: "task", tasks: [{ id: "Background", description: "Background", assignment: "Run" }] }, undefined, undefined, ctx);
    if (!taskResult.content[0].text.includes("Started 1 background sub-agent")) throw new Error("task background start smoke failed");
    if (taskResult.details.background !== true || taskResult.details.jobId !== "subagents:smoke-task-background") throw new Error("task background details smoke failed");
    const finalMessage = await waitFor(() => sentMessages.slice(sentStart).find((message) => message.customType === "subagent-results"));
    if (!finalMessage.content.includes("background result")) throw new Error("task background final message smoke failed");
    if (finalMessage.options?.triggerTurn !== true || finalMessage.options?.deliverAs !== "followUp") throw new Error("task background final delivery smoke failed");
    if (finalMessage.details.results[0].exitCode !== 0) throw new Error("task background result details smoke failed");
  } finally {
    if (previousPiCommand === undefined) delete process.env.SWIFT_PI_COMMAND;
    else process.env.SWIFT_PI_COMMAND = previousPiCommand;
  }
} finally {
  await rm(smokeTmp, { recursive: true, force: true });
}

const todo = tools.get("todo_write");
const todoResult = await todo.execute("smoke-todo", { ops: [{ op: "init", list: [{ phase: "Smoke", items: ["Run smoke"] }] }, { op: "done", task: "Run smoke" }] }, undefined, undefined, ctx);
if (!todoResult.content[0].text.includes("✓ Run smoke")) throw new Error("todo smoke failed");

const ask = tools.get("ask");
const askResult = await ask.execute("smoke-ask", { questions: [{ id: "choice", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 1 }] }, undefined, undefined, ctx);
if (!askResult.content[0].text.includes("B")) throw new Error("ask smoke failed");

const ast = tools.get("ast_grep");
const astResult = await ast.execute("smoke-ast", { pat: "AGENT_PROMPTS", paths: ["extensions/task/index.ts"], lang: "ts" }, undefined, undefined, ctx);
if (!astResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("ast_grep smoke failed");

const web = tools.get("web_search");
const webResult = await web.execute("smoke-web", { query: "example" }, undefined, undefined, ctx);
if (!webResult.content[0].text.includes("BRAVE_API_KEY")) throw new Error("web_search smoke failed");

const { loadThemeFromPath } = await import(pathToFileURL(
  path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"),
).href);
const titaniumTheme = loadThemeFromPath(path.join(root, "themes/titanium.json"), "truecolor");
if (titaniumTheme.name !== "titanium") throw new Error("titanium theme load smoke failed");

let capturedFooterFactory;
let capturedTitle;
const powerlineSessionStart = handlers.find((handler) => handler.event === "session_start");
if (!powerlineSessionStart) throw new Error("powerline footer session_start handler smoke failed");
powerlineSessionStart.handler({ type: "session_start", reason: "new" }, {
  cwd: root,
  mode: "tui",
  hasUI: true,
  ui: {
    setFooter(factory) { capturedFooterFactory = factory; },
    setTitle(title) { capturedTitle = title; },
  },
  model: { id: "smoke-model", provider: "smoke", contextWindow: 100000, reasoning: true },
  getContextUsage() { return { tokens: 76000, contextWindow: 100000, percent: 76 }; },
  sessionManager: {
    getCwd() { return root; },
    getSessionName() { return "Smoke Session"; },
    getHeader() { return { type: "session", id: "smoke-session-id", timestamp: new Date(0).toISOString(), cwd: root }; },
    getEntries() { return [{ type: "thinking_level_change", thinkingLevel: "high" }]; },
  },
});
if (!capturedFooterFactory || capturedTitle !== "Smoke Session") throw new Error("powerline footer registration smoke failed");
const powerlineFooter = capturedFooterFactory({}, titaniumTheme, {
  getGitBranch() { return "main"; },
  getExtensionStatuses() { return new Map(); },
  getAvailableProviderCount() { return 1; },
  onBranchChange() { return () => {}; },
});
const powerlineLines = powerlineFooter.render(160);
if (powerlineLines.length !== 1) throw new Error("powerline footer should render session on the main segment line");
const powerlineOutput = powerlineLines.join("\n");
for (const expected of ["", "Smoke Session", "smoke-model", "high", " main", " 76k/100k", "76%"] ) {
  if (!powerlineOutput.includes(expected)) throw new Error(`powerline footer smoke failed: ${expected}`);
}
for (const forbidden of [" Pi", "Effort", " 76k/100k 76%"] ) {
  if (powerlineOutput.includes(forbidden)) throw new Error(`powerline footer should not include: ${forbidden}`);
}
if (powerlineOutput.lastIndexOf("Smoke Session") <= powerlineOutput.indexOf("76%")) {
  throw new Error("powerline footer session badge should be on the right side of the main line");
}
if (!powerlineOutput.includes("\x1b[38;2;248;250;252m\x1b[48;2;239;68;68m 76% ")) {
  throw new Error("powerline footer red context percentage should use white text");
}

capturedFooterFactory = undefined;
capturedTitle = undefined;
powerlineSessionStart.handler({ type: "session_start", reason: "new" }, {
  cwd: root,
  mode: "tui",
  hasUI: true,
  ui: {
    setFooter(factory) { capturedFooterFactory = factory; },
    setTitle(title) { capturedTitle = title; },
  },
  model: { id: "smoke-model", provider: "smoke", contextWindow: 100000, reasoning: true },
  getContextUsage() { return { tokens: 20000, contextWindow: 100000, percent: 20 }; },
  sessionManager: {
    getCwd() { return root; },
    getSessionName() { return undefined; },
    getHeader() { return { type: "session", id: "smoke-session-id", timestamp: new Date(0).toISOString(), cwd: root }; },
    getEntries() { return []; },
  },
});
if (!capturedFooterFactory || capturedTitle !== undefined) throw new Error("powerline footer unnamed session title smoke failed");
const unnamedPowerlineOutput = capturedFooterFactory({}, titaniumTheme, {
  getGitBranch() { return null; },
  getExtensionStatuses() { return new Map(); },
  getAvailableProviderCount() { return 1; },
  onBranchChange() { return () => {}; },
}).render(160).join("\n");
for (const forbidden of ["Smoke Session", "smoke-session-id", "Untitled", "Session"]) {
  if (unnamedPowerlineOutput.includes(forbidden)) throw new Error(`powerline footer unnamed session should not include: ${forbidden}`);
}
if (!unnamedPowerlineOutput.includes("\x1b[38;2;2;6;23m\x1b[48;2;34;197;94m 20% ")) {
  throw new Error("powerline footer low context percentage should be green with readable text");
}

const contextCommand = commands.get("context");
if (!contextCommand) throw new Error("missing command: context");
const contextSentStart = sentMessages.length;
const contextCtx = {
  cwd: root,
  mode: "tui",
  hasUI: true,
  ui: {
    notify() {},
    theme: titaniumTheme,
  },
  model: { id: "smoke-model", name: "Smoke Model", contextWindow: 100000 },
  getContextUsage() { return { tokens: null, contextWindow: 100000, percent: null }; },
  getSystemPrompt() { return "System prompt for smoke."; },
  getSystemPromptOptions() {
    return { cwd: root, contextFiles: [{ path: "AGENTS.md", content: "smoke context" }], skills: [] };
  },
  sessionManager: {
    getBranch() {
      return [{
        type: "message",
        id: "smoke-user",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: "hello context", timestamp: 0 },
      }];
    },
  },
};
await contextCommand.handler("", contextCtx);
const contextMessage = sentMessages[contextSentStart];
if (!contextMessage) throw new Error("context command message smoke failed");
if (contextMessage.customType !== "context-usage") throw new Error("context command message type smoke failed");
if (!renderers.has("context-usage")) throw new Error("context renderer registration smoke failed");
const contextRenderer = renderers.get("context-usage");
const contextComponent = contextRenderer?.(contextMessage, { expanded: false }, titaniumTheme);
if (!contextComponent) throw new Error("context renderer smoke failed");
const contextOutput = contextComponent.render(120).join("\n");
if (!contextOutput.includes("⛁")) throw new Error("context command grid smoke failed");
if (!contextOutput.includes("Estimated usage by category")) throw new Error("context command legend smoke failed");
if (!contextOutput.includes("\u001b[38;2;0;180;255m")) throw new Error("context command titanium color smoke failed");


const { TabBar } = await jiti.import(path.join(root, "extensions/settings/tab-bar.ts"));
const identityTheme = {
  label: (text) => text,
  activeTab: (text) => `[${text}]`,
  inactiveTab: (text) => text,
  hint: (text) => text,
  mutedTab: (text) => `(${text})`,
  hoverTab: (text) => `{${text}}`,
};
const tabBar = new TabBar("Settings", [
  { id: "appearance", label: "Appearance", short: "A" },
  { id: "disabled", label: "Disabled", short: "D", muted: true },
  { id: "tools", label: "Tools", short: "T" },
], identityTheme);
tabBar.showHint = false;
let changedTab = "";
tabBar.onTabChange = (tab) => { changedTab = tab.id; };
if (!tabBar.render(80)[0].includes("Settings:")) throw new Error("tab bar smoke render failed");
tabBar.nextTab();
if (tabBar.getActiveTab().id !== "tools" || changedTab !== "tools") throw new Error("tab bar smoke navigation failed");
const renderedTabLine = tabBar.render(80)[0];
const disabledColumn = renderedTabLine.indexOf("( Disabled ") + 1;
if (tabBar.tabAt(0, 0)?.id !== undefined) throw new Error("tab bar smoke hit zone boundary failed");
if (disabledColumn <= 0 || tabBar.tabAt(0, disabledColumn)?.id !== "disabled") throw new Error("tab bar smoke hit zone failed");

const { patchSettingsManager, patchSettingsSelector } = await import(pathToFileURL(path.join(root, "scripts/patch-pi-settings.mjs")).href);
const legacyPatchedSettingsSelector = `
const SETTINGS_TAB_BY_ID = {
    "follow-up-mode": "interaction",
    "hide-thinking": "display",
};
const items = [
            {
                id: "follow-up-mode",
            },
            {
                id: "hide-thinking",
            },
];
function applySetting(callbacks, newValue) {
            switch ("follow-up-mode") {
                case "follow-up-mode":
                    callbacks.onFollowUpModeChange(newValue);
                    break;
                case "hide-thinking":
                    callbacks.onHideThinkingBlockChange(newValue === "true");
                    break;
            }
}
this.tabBar = new TabBar("Settings", SETTINGS_TABS.map((tab) => ({ ...tab, muted: (this.settingsListsByTab[tab.id]?.render(1).length ?? 0) === 0 })), tabTheme());
// SWIFTENGINEER_TABBED_SETTINGS_PATCH
`;
const restoredSettingsSelector = patchSettingsSelector(legacyPatchedSettingsSelector);
if (!restoredSettingsSelector.includes('transport: "network"')) throw new Error("settings patch transport tab mapping smoke failed");
if (!restoredSettingsSelector.includes('id: "transport"')) throw new Error("settings patch transport item smoke failed");
if (!restoredSettingsSelector.includes('values: ["sse", "websocket", "websocket-cached", "auto"]')) throw new Error("settings patch transport values smoke failed");
if (!restoredSettingsSelector.includes("Choose sse to disable OpenAI Codex WebSockets")) throw new Error("settings patch transport description smoke failed");
if (!restoredSettingsSelector.includes("callbacks.onTransportChange(newValue);")) throw new Error("settings patch transport handler smoke failed");
if (restoredSettingsSelector.includes("muted: (this.settingsListsByTab")) throw new Error("settings patch stale muted tab smoke failed");
const upstreamSettingsManager = `
    getTransport() {
        return this.settings.transport ?? "auto";
    }
`;
const restoredSettingsManager = patchSettingsManager(upstreamSettingsManager);
if (!restoredSettingsManager.includes('return this.settings.transport ?? "sse";')) throw new Error("settings manager transport default smoke failed");
if (patchSettingsManager(restoredSettingsManager) !== restoredSettingsManager) throw new Error("settings manager transport default idempotence smoke failed");


const { subagentRegistry } = await jiti.import(path.join(root, "extensions/subagent-view/registry.ts"));
const { SubagentPanel, chooseLayout } = await jiti.import(path.join(root, "extensions/subagent-view/panel.ts"));
const { visibleWidth } = await import("@earendil-works/pi-tui");

for (const shortcut of ["alt+s", "alt+a", "ctrl+\\"]) {
  if (!shortcuts.has(shortcut)) throw new Error(`subagent-view shortcut missing: ${shortcut}`);
}

if (chooseLayout(200, 50, true).orientation !== "vertical") throw new Error("subagent layout wide-vertical smoke failed");
if (chooseLayout(200, 50, false).orientation !== "horizontal") throw new Error("subagent layout vertical opt-out smoke failed");
if (chooseLayout(80, 70, true).orientation !== "horizontal") throw new Error("subagent layout tall-horizontal smoke failed");

subagentRegistry.reset();
subagentRegistry.add("call:One", "explore auth", "explore");
subagentRegistry.add("call:Two", "review diff", "reviewer");
subagentRegistry.add("call:Three", "write docs", "task");
subagentRegistry.start("call:One");
subagentRegistry.update("call:One", { appendText: "Inspecting the auth module", phase: "writing" });
subagentRegistry.start("call:Two");
subagentRegistry.finish("call:Three", { state: "done", final: "Docs written.", exitInfo: "completed" });

const subagentCounts = subagentRegistry.counts();
if (subagentCounts.total !== 3 || subagentCounts.finished !== 1 || subagentCounts.running !== 2) {
  throw new Error("subagent registry counts smoke failed");
}

const fakeSubagentTui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
const subagentPanel = new SubagentPanel(fakeSubagentTui, () => titaniumTheme, subagentRegistry, () => false);
const subagentPanelWidth = 120;
const subagentPanelLines = subagentPanel.render(subagentPanelWidth);
if (subagentPanelLines.length === 0) throw new Error("subagent panel should render when agents exist");
for (const line of subagentPanelLines) {
  if (visibleWidth(line) > subagentPanelWidth) throw new Error("subagent panel line exceeds width");
}
// Lines must stay within bounds at narrow widths too (border/hint must not overflow).
for (const narrow of [30, 34, 48, 80]) {
  for (const line of subagentPanel.render(narrow)) {
    if (visibleWidth(line) > narrow) throw new Error(`subagent panel line exceeds narrow width ${narrow}`);
  }
}
const subagentPanelText = subagentPanelLines.join("\n");
for (const expected of ["Sub-agents 1/3", "◉", "✓", "●", "explore auth"]) {
  if (!subagentPanelText.includes(expected)) throw new Error(`subagent panel smoke failed: ${expected}`);
}
// Auto-select follows the first running sub-agent and stays there.
if (subagentRegistry.watched()?.label !== "explore auth") throw new Error("subagent auto-select smoke failed");
subagentRegistry.cycle(1);
if (subagentRegistry.watched()?.label !== "review diff") throw new Error("subagent cycle smoke failed");
if (subagentPanel.render(120).length === 0) throw new Error("subagent panel re-render smoke failed");
subagentRegistry.reset();
if (!subagentRegistry.isEmpty() || subagentPanel.render(120).length !== 0) throw new Error("subagent registry reset smoke failed");

// Reserved split-pane composition (core-patch path).
const { composeSplitFrame, splitRegions } = await jiti.import(path.join(root, "extensions/subagent-view/split.ts"));

if (splitRegions(160, 40, true).orientation !== "vertical") throw new Error("splitRegions wide-vertical smoke failed");
if (splitRegions(160, 40, false).orientation !== "horizontal") throw new Error("splitRegions opt-out smoke failed");
if (splitRegions(80, 60, true).orientation !== "horizontal") throw new Error("splitRegions tall-horizontal smoke failed");

subagentRegistry.reset();
subagentRegistry.add("s:1", "explore", "explore");
subagentRegistry.start("s:1");
subagentRegistry.update("s:1", { appendText: "scanning files", phase: "writing" });
subagentRegistry.add("s:2", "review", "reviewer");

const fakeMain = Array.from({ length: 60 }, (_, i) => `main row ${i}`);
const splitRender = (w) => fakeMain.map((line) => line.slice(0, w));

const hTui = { terminal: { rows: 40, columns: 120 }, requestRender() {}, render: splitRender };
const hFrame = composeSplitFrame(hTui, fakeMain, 120, 40, () => titaniumTheme, false);
if (hFrame.length !== 40) throw new Error("split horizontal frame height smoke failed");
if (!hFrame.slice(0, 20).join("\n").includes("Sub-agents")) throw new Error("split horizontal panel region smoke failed");
if (!hFrame.slice(20).join("\n").includes("main row 59")) throw new Error("split horizontal main tail smoke failed");
for (const line of hFrame) if (visibleWidth(line) > 120) throw new Error("split horizontal width smoke failed");

const vTui = { terminal: { rows: 40, columns: 160 }, requestRender() {}, render: splitRender };
const vFrame = composeSplitFrame(vTui, fakeMain, 160, 40, () => titaniumTheme, true);
if (vFrame.length !== 40) throw new Error("split vertical frame height smoke failed");
for (const line of vFrame) if (visibleWidth(line) > 160) throw new Error("split vertical width smoke failed");
const vText = vFrame.join("\n");
if (!vText.includes("Sub-agents")) throw new Error("split vertical panel region smoke failed");
if (!vText.includes("main row 59")) throw new Error("split vertical main region smoke failed");
if (!vText.includes("│")) throw new Error("split vertical divider smoke failed");

subagentRegistry.reset();
if (composeSplitFrame(hTui, fakeMain, 120, 40, () => titaniumTheme, false) !== fakeMain) {
  throw new Error("split passthrough smoke failed");
}

// TUI render-loop patch: round-trip + idempotence.
const { patchTuiSource, unpatchTuiSource } = await import(pathToFileURL(path.join(root, "scripts/patch-pi-tui-split.mjs")).href);
const tuiSample = [
  "    doRender() {",
  "        const width = this.terminal.columns;",
  "        const height = this.terminal.rows;",
  "        let newLines = this.render(width);",
  "        if (this.overlayStack.length > 0) {",
  "            newLines = this.compositeOverlays(newLines, width, height);",
  "        }",
  "    }",
  "//# sourceMappingURL=tui.js.map",
  "",
].join("\n");
const patchedTui = patchTuiSource(tuiSample);
if (!patchedTui.includes("globalThis.__piSplitFrame(this, newLines, width, height)")) throw new Error("tui patch hook smoke failed");
if (!patchedTui.includes("globalThis.__PI_SPLIT_PATCH__ = true;")) throw new Error("tui patch flag smoke failed");
if (patchTuiSource(patchedTui) !== patchedTui) throw new Error("tui patch idempotence smoke failed");
if (unpatchTuiSource(patchedTui) !== tuiSample) throw new Error("tui patch reversibility smoke failed");

for (const required of ["search", "ast_grep", "ast_edit", "todo_write", "ask", "web_search", "task"]) {
  if (!tools.has(required)) throw new Error(`missing tool: ${required}`);
}

console.log(`registered tools: ${Array.from(tools.keys()).sort().join(", ")}`);
console.log(`registered handlers: ${handlers.map((handler) => handler.event).sort().join(", ")}`);
