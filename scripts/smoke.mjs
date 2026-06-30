import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
process.env.PI_TASK_MAX_RUNTIME_MS ??= "100";
process.env.PI_TASK_KILL_GRACE_MS ??= "50";
const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
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
  "extensions/animated-pi-header.ts",
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

const sessionStartHandlers = handlers.filter((handler) => handler.event === "session_start");
const animatedHeaderSessionStart = sessionStartHandlers[1];
if (!animatedHeaderSessionStart) throw new Error("animated Pi header session_start handler smoke failed");
let capturedHeaderFactory;
animatedHeaderSessionStart.handler({ type: "session_start", reason: "new" }, {
  cwd: root,
  mode: "tui",
  hasUI: true,
  ui: {
    setHeader(factory) { capturedHeaderFactory = factory; },
  },
  model: { id: "smoke-model", provider: "smoke", contextWindow: 100000, reasoning: true },
  sessionManager: {
    getCwd() { return root; },
  },
});
if (!capturedHeaderFactory) throw new Error("animated Pi header registration smoke failed");
let headerRenderRequests = 0;
const animatedHeader = capturedHeaderFactory({ requestRender() { headerRenderRequests++; } }, titaniumTheme);
try {
  const animatedHeaderOutput = animatedHeader.render(100).join("\n");
  for (const expected of ["Welcome back!", "smoke-model", "▀", "▄", "/ commands", "@ files", "! bash + send", "!! bash local"]) {
    if (!animatedHeaderOutput.includes(expected)) throw new Error(`animated Pi header smoke failed: ${expected}`);
  }
  if (animatedHeaderOutput.includes("# prompt actions")) throw new Error("animated Pi header should not show stale prompt-actions hint");
  if (!animatedHeaderOutput.includes("\x1b[38;2;")) throw new Error("animated Pi header should use truecolor gradient escapes");
  if (headerRenderRequests < 1) throw new Error("animated Pi header should request an initial animation render");
} finally {
  animatedHeader.dispose?.();
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

const { patchStartupResourceDisplaySource } = await import(pathToFileURL(path.join(root, "scripts/patch-pi-startup-resources.mjs")).href);
const startupResourceSample = [
  "export function names() {",
  "    const added = [];",
  "        const addLoadedSection = (name, collapsedBody, expandedBody = collapsedBody, color = \"mdHeading\") => {",
  "            added.push(name);",
  "        };",
  "        addLoadedSection(\"Context\", \"context\");",
  "        addLoadedSection(\"Skills\", \"skills\");",
  "        addLoadedSection(\"Prompts\", \"prompts\");",
  "        addLoadedSection(\"Extensions\", \"extensions\");",
  "        addLoadedSection(\"Themes\", \"themes\");",
  "    return added;",
  "}",
  "",
].join("\n");
const patchedStartupResourceSample = patchStartupResourceDisplaySource(startupResourceSample);
if (patchStartupResourceDisplaySource(patchedStartupResourceSample) !== patchedStartupResourceSample) throw new Error("startup resource display patch idempotence smoke failed");
if (!patchedStartupResourceSample.includes('name === "Skills" || name === "Extensions" || name === "Themes"')) throw new Error("startup resource display patch guard smoke failed");
const { names: startupResourceNames } = await import(`data:text/javascript,${encodeURIComponent(patchedStartupResourceSample)}`);
const visibleStartupResourceSections = startupResourceNames().join(",");
if (visibleStartupResourceSections !== "Context,Prompts") throw new Error(`startup resource display patch smoke failed: ${visibleStartupResourceSections}`);

const { subagentRegistry } = await jiti.import(path.join(root, "extensions/subagent-view/registry.ts"));
const { renderStrip, bannerLine } = await jiti.import(path.join(root, "extensions/subagent-view/strip.ts"));
const { SubagentViewState } = await jiti.import(path.join(root, "extensions/subagent-view/view-state.ts"));
const { composePagerFrame } = await jiti.import(path.join(root, "extensions/subagent-view/frame.ts"));
const { messageToBlocks } = await jiti.import(path.join(root, "extensions/subagent-view/transcript.ts"));
const { visibleWidth } = await import("@earendil-works/pi-tui");

// Shortcuts the redesigned pager registers (new bindings + muscle-memory aliases).
for (const shortcut of ["alt+]", "alt+[", "alt+l", "alt+s", "alt+a"]) {
  if (!shortcuts.has(shortcut)) throw new Error(`subagent-view shortcut missing: ${shortcut}`);
}

// Double-scroll guard: under the kitty keyboard protocol a key RELEASE for PgUp
// still satisfies matchesKey("pageUp"), so the input handler must skip releases
// (via isKeyRelease) — otherwise every press scrolls twice (one press jumped
// ~2x a page, blowing past the buffer). Pin that contract here.
const { isKeyRelease: isKeyReleaseFn, matchesKey: matchesKeyFn } = await import("@earendil-works/pi-tui");
const pgUpRelease = "\x1b[5;1:3~";
if (!matchesKeyFn(pgUpRelease, "pageUp")) throw new Error("pageUp release no longer matches pageUp — revisit double-scroll guard");
if (!isKeyReleaseFn(pgUpRelease)) throw new Error("pageUp release not detected as key release — double-scroll guard broken");
if (isKeyReleaseFn("\x1b[5~")) throw new Error("pageUp press misdetected as key release");

// Core split hook is absent while idle so old native-scrollback patches do not
// treat normal prompt typing as split-frame mode. It is installed only while
// sub-agents exist, and removed again when the registry empties.
const subagentSessionStart = handlers.filter((handler) => handler.event === "session_start").at(-1);
const subagentSessionShutdown = handlers.filter((handler) => handler.event === "session_shutdown").at(-1);
if (!subagentSessionStart || !subagentSessionShutdown) throw new Error("subagent-view session handlers smoke failed");
const previousSplitPatchFlag = globalThis.__PI_SPLIT_PATCH__;
const previousSplitHook = globalThis.__piSplitFrame;
const previousSplitActive = globalThis.__piSplitFrameActive;
globalThis.__PI_SPLIT_PATCH__ = true;
globalThis.__piSplitFrame = undefined;
globalThis.__piSplitFrameActive = undefined;
try {
  let splitRenderRequests = 0;
  subagentRegistry.reset();
  subagentSessionStart.handler({ type: "session_start", reason: "new" }, {
    mode: "tui",
    hasUI: true,
    ui: { theme: titaniumTheme, onTerminalInput() { return () => {}; } },
  });
  if (globalThis.__piSplitFrame !== undefined) throw new Error("subagent split hook should not install while idle");
  if (globalThis.__piSplitFrameActive !== false) throw new Error("subagent split hook should be inactive while idle");
  subagentRegistry.add("active:1", "active agent", "task");
  if (typeof globalThis.__piSplitFrame !== "function" || globalThis.__piSplitFrameActive !== true) throw new Error("subagent split hook activation smoke failed");
  const activeSplitHook = globalThis.__piSplitFrame;
  const activeFrame = activeSplitHook({ terminal: { rows: 10, columns: 80 }, children: [], requestRender() { splitRenderRequests++; } }, ["active"], 80, 10);
  if (activeFrame.join("|") !== "active") throw new Error("subagent active split hook passthrough smoke failed");
  subagentRegistry.reset();
  if (globalThis.__piSplitFrame !== undefined || globalThis.__piSplitFrameActive !== false || splitRenderRequests === 0) {
    throw new Error("subagent split hook idle reset smoke failed");
  }
} finally {
  subagentSessionShutdown.handler({ type: "session_shutdown" });
  if (previousSplitPatchFlag === undefined) delete globalThis.__PI_SPLIT_PATCH__;
  else globalThis.__PI_SPLIT_PATCH__ = previousSplitPatchFlag;
  if (previousSplitHook === undefined) delete globalThis.__piSplitFrame;
  else globalThis.__piSplitFrame = previousSplitHook;
  if (previousSplitActive === undefined) delete globalThis.__piSplitFrameActive;
  else globalThis.__piSplitFrameActive = previousSplitActive;
}

// --- registry: append-only transcript keeps full history (not a rolling tail) ---
subagentRegistry.reset();
subagentRegistry.add("call:One", "explore auth", "explore");
subagentRegistry.add("call:Two", "review diff", "reviewer");
subagentRegistry.add("call:Three", "write docs", "task");
subagentRegistry.start("call:One");
subagentRegistry.appendMessage("call:One", { role: "assistant", content: [{ type: "thinking", thinking: "tracing the refresh path" }, { type: "text", text: "Found the bug in refresh.ts" }] });
subagentRegistry.start("call:Two");
subagentRegistry.finish("call:Three", { state: "done", final: "Docs written.", exitInfo: "completed" });
const subagentCounts = subagentRegistry.counts();
if (subagentCounts.total !== 3 || subagentCounts.finished !== 1 || subagentCounts.running !== 2) throw new Error("subagent registry counts smoke failed");
const oneBlocks = subagentRegistry.list().find((agent) => agent.id === "call:One")?.blocks ?? [];
if (oneBlocks.length !== 2 || !oneBlocks.some((block) => block.kind === "thinking") || !oneBlocks.some((block) => block.text.includes("Found the bug"))) {
  throw new Error("subagent transcript blocks smoke failed");
}

// --- status strip: width-safe, shows symbols + selected name + position ---
const stripModel = {
  channels: [
    { kind: "main", activity: "idle", selected: false, hasNewOutput: false },
    { kind: "running", activity: "reasoning", selected: true, hasNewOutput: false },
    { kind: "done", activity: "idle", selected: false, hasNewOutput: true },
  ],
  selectedIndex: 1, selectedLabel: "explore auth", selectedStatus: "reasoning", offMain: true,
  spinner: true, spinnerFrame: 2, scrolledUp: false, percent: 100, linesBelow: 0, ascii: false,
};
for (const w of [30, 44, 80, 120]) {
  for (const rows of [1, 2]) {
    const lines = renderStrip(stripModel, w, titaniumTheme, rows);
    if (lines.length !== rows) throw new Error(`subagent strip row count smoke failed @${w}/${rows}`);
    for (const line of lines) if (visibleWidth(line) > w) throw new Error(`subagent strip width smoke failed @${w}`);
    if (!lines[0].includes("2/3")) throw new Error(`subagent strip position smoke failed @${w}`);
  }
}
// At the live tail there is no scroll readout and no alt+l hint (noise-free);
// scrolled off the tail both appear. Esc hint is shown only on a sub-agent channel.
const liveStrip = renderStrip(stripModel, 120, titaniumTheme, 2);
if (liveStrip.join("\n").includes("live")) throw new Error("subagent strip should hide live badge at tail");
if (liveStrip[1].includes("alt+l")) throw new Error("subagent strip should hide alt+l hint at tail");
if (!liveStrip[1].includes("Esc")) throw new Error("subagent strip should show Esc hint off-main");
const scrolledStrip = renderStrip({ ...stripModel, scrolledUp: true, percent: 40, linesBelow: 30 }, 120, titaniumTheme, 2);
if (!scrolledStrip[1].includes("alt+l")) throw new Error("subagent strip should show alt+l hint when scrolled");
if (!scrolledStrip[0].includes("▲")) throw new Error("subagent strip should show scroll position when scrolled");
const mainStrip = renderStrip({ ...stripModel, offMain: false }, 120, titaniumTheme, 2);
if (mainStrip[1].includes("Esc")) throw new Error("subagent strip should hide Esc hint on main");
const banner = bannerLine(8, 100, titaniumTheme);
if (visibleWidth(banner) > 100 || !banner.includes("VIEWING HISTORY")) throw new Error("subagent strip banner smoke failed");

// --- view-state: selection includes main (channel 0) + sub-agents ---
const viewState = new SubagentViewState(subagentRegistry, () => titaniumTheme);
viewState.noteRegistryChange();
if (viewState.selectedId !== "main" || viewState.channelIds().length !== 4) throw new Error("view-state channels smoke failed");
viewState.cycle(1);
if (viewState.selectedId !== "call:One") throw new Error("view-state cycle smoke failed");
viewState.selectMain();
if (!viewState.isMainSelected()) throw new Error("view-state selectMain smoke failed");

// --- frame composition: pinned chrome + switchable window + loud history banner ---
const MARKER = "_pi:c";
const mkChild = (lines) => ({ render: () => lines });
const pagerTranscript = Array.from({ length: 60 }, (_, i) => `main row ${i}`);
const editorLine = "> prompt " + MARKER;
const footerLine = "[ powerline ]";
const pagerChildren = [mkChild(pagerTranscript), mkChild([editorLine]), mkChild([footerLine])];
const mainFrame = [...pagerTranscript, editorLine, footerLine];
const pagerTui = { terminal: { rows: 40, columns: 120 }, children: pagerChildren };
const pagerDeps = { state: viewState, getTheme: () => titaniumTheme, ascii: false };

let pagerFrame = composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps);
if (pagerFrame.length !== 40) throw new Error("pager frame height smoke failed");
if (!pagerFrame.join("\n").includes(MARKER)) throw new Error("pager cursor-marker pinned smoke failed");
if (!pagerFrame.some((line) => line.includes(footerLine))) throw new Error("pager footer pinned smoke failed");
if (!pagerFrame.some((line) => line.includes("main row 59"))) throw new Error("pager main tail smoke failed");
for (const line of pagerFrame) if (visibleWidth(line) > 120) throw new Error("pager width smoke failed");

viewState.select("call:One");
pagerFrame = composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps);
if (!pagerFrame.some((line) => line.includes("Found the bug"))) throw new Error("pager sub-agent transcript smoke failed");
if (pagerFrame.some((line) => line.includes("main row 59"))) throw new Error("pager channel-swap smoke failed");
// Off the main channel the prompt is hidden: no cursor marker (so pi-tui hides
// the hardware cursor), but the powerline footer below it stays pinned.
if (pagerFrame.join("\n").includes(MARKER)) throw new Error("pager prompt should be hidden off-main smoke failed");
if (!pagerFrame.some((line) => line.includes(footerLine))) throw new Error("pager footer pinned off-main smoke failed");
// Returning to the main channel restores the prompt + cursor marker.
viewState.selectMain();
pagerFrame = composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps);
if (!pagerFrame.join("\n").includes(MARKER)) throw new Error("pager prompt restored on main smoke failed");

viewState.selectMain();
composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps);
viewState.scrollActive(-12);
pagerFrame = composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps);
if (!pagerFrame.some((line) => line.includes("VIEWING HISTORY"))) throw new Error("pager scroll banner smoke failed");
viewState.scrollActiveToBottom();
pagerFrame = composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps);
if (pagerFrame.some((line) => line.includes("VIEWING HISTORY"))) throw new Error("pager jump-to-live smoke failed");

const noMarkerTui = { terminal: { rows: 40, columns: 120 }, children: [mkChild(pagerTranscript), mkChild(["no marker"])] };
if (composePagerFrame(noMarkerTui, mainFrame, 120, 40, pagerDeps) !== mainFrame) throw new Error("pager passthrough (no marker) smoke failed");
subagentRegistry.reset();
if (composePagerFrame(pagerTui, mainFrame, 120, 40, pagerDeps) !== mainFrame) throw new Error("pager passthrough (empty) smoke failed");

// --- P4: transcript fidelity — every message role becomes blocks ---
const bashOk = messageToBlocks({ role: "bashExecution", command: "ls -la", output: "file-a\nfile-b", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 });
if (!bashOk.some((b) => b.kind === "toolcall" && b.text.includes("ls -la"))) throw new Error("bashExecution command block smoke failed");
if (!bashOk.some((b) => b.kind === "toolresult" && b.text.includes("file-b") && !b.isError)) throw new Error("bashExecution output block smoke failed");
const bashErr = messageToBlocks({ role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, truncated: false, timestamp: 0 });
if (!bashErr.some((b) => b.kind === "toolresult" && b.isError)) throw new Error("bashExecution error flag smoke failed");
const bashSanitized = messageToBlocks({ role: "bashExecution", command: `echo ${String.fromCharCode(27)}[2Jhi`, output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 });
if (bashSanitized.some((b) => b.text.includes(String.fromCharCode(27)))) throw new Error("bashExecution sanitize smoke failed");
const compactBlocks = messageToBlocks({ role: "compactionSummary", summary: "older turns summarized", tokensBefore: 1234, timestamp: 0 });
if (!compactBlocks.some((b) => b.kind === "meta" && b.text.includes("compacted") && b.text.includes("older turns"))) throw new Error("compactionSummary meta smoke failed");
const branchBlocks = messageToBlocks({ role: "branchSummary", summary: "explored an alternative", fromId: "x", timestamp: 0 });
if (!branchBlocks.some((b) => b.kind === "meta" && b.text.includes("branch"))) throw new Error("branchSummary meta smoke failed");
const customShown = messageToBlocks({ role: "custom", customType: "note", content: "visible note", display: true, timestamp: 0 });
if (!customShown.some((b) => b.kind === "meta" && b.text.includes("visible note"))) throw new Error("custom display meta smoke failed");
if (messageToBlocks({ role: "custom", customType: "note", content: "hidden", display: false, timestamp: 0 }).length !== 0) throw new Error("custom hidden should yield no blocks smoke failed");

// --- P4: per-channel memory cap trims oldest blocks + tracks the count ---
subagentRegistry.reset();
subagentRegistry.add("cap:1", "long agent", "task");
for (let i = 0; i < 5200; i++) subagentRegistry.appendMessage("cap:1", { role: "assistant", content: [{ type: "text", text: `MSG_${i}` }] });
const capAgent = subagentRegistry.list().find((agent) => agent.id === "cap:1");
if (capAgent.blocks.length > 5000) throw new Error("memory cap not enforced smoke failed");
if (capAgent.trimmedBlocks <= 0) throw new Error("memory cap trimmedBlocks not tracked smoke failed");
if (!capAgent.blocks.some((b) => b.text === "MSG_5199")) throw new Error("memory cap dropped newest smoke failed");
if (capAgent.blocks.some((b) => b.text === "MSG_0")) throw new Error("memory cap kept oldest smoke failed");
const capState = new SubagentViewState(subagentRegistry, () => titaniumTheme);
capState.noteRegistryChange();
capState.select("cap:1");
const capChildren = [mkChild(["t"]), mkChild([editorLine]), mkChild([footerLine])];
const capMain = ["t", editorLine, footerLine];
composePagerFrame({ terminal: { rows: 40, columns: 100 }, children: capChildren }, capMain, 100, 40, { state: capState, getTheme: () => titaniumTheme, ascii: false });
capState.scrollActiveToTop();
const capTopFrame = composePagerFrame({ terminal: { rows: 40, columns: 100 }, children: capChildren }, capMain, 100, 40, { state: capState, getTheme: () => titaniumTheme, ascii: false });
if (!capTopFrame.some((line) => line.includes("trimmed"))) throw new Error("memory cap trimmed marker not rendered smoke failed");
// retry meta marker
subagentRegistry.appendMeta("cap:1", "retrying after a transient error (attempt 2/3)");
if (!subagentRegistry.list().find((a) => a.id === "cap:1").blocks.some((b) => b.kind === "meta" && b.text.includes("retrying"))) throw new Error("appendMeta retry marker smoke failed");

// --- P3: scroll anchor survives a width change (re-wrap on resize) ---
subagentRegistry.reset();
subagentRegistry.add("rz:1", "resize agent", "task");
for (let i = 0; i < 90; i++) subagentRegistry.appendMessage("rz:1", { role: "assistant", content: [{ type: "text", text: `RZBLOCK_${i} ${"lorem ipsum ".repeat(8)}` }] });
const rzState = new SubagentViewState(subagentRegistry, () => titaniumTheme);
rzState.noteRegistryChange();
rzState.select("rz:1");
const rzChildren = [mkChild(["top"]), mkChild([editorLine]), mkChild([footerLine])];
const rzMain = ["top", editorLine, footerLine];
const rzFrame = (cols) => composePagerFrame({ terminal: { rows: 40, columns: cols }, children: rzChildren }, rzMain, cols, 40, { state: rzState, getTheme: () => titaniumTheme, ascii: false });
const firstBlock = (frame) => { for (const line of frame) { const m = line.match(/RZBLOCK_(\d+)/); if (m) return Number(m[1]); } return -1; };
rzFrame(120); // establish geometry at the wide width
rzState.scrollActive(-rzState.pageRows());
rzState.scrollActive(-rzState.pageRows());
const wideTopBlock = firstBlock(rzFrame(120));
const narrowTopBlock = firstBlock(rzFrame(60)); // halve width → roughly doubles wrapped lines
if (wideTopBlock < 0 || narrowTopBlock < 0) throw new Error("resize anchor smoke setup failed (no block visible)");
if (Math.abs(wideTopBlock - narrowTopBlock) > 1) throw new Error(`resize anchor drifted ${wideTopBlock} -> ${narrowTopBlock} smoke failed`);
subagentRegistry.reset();


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

// Native scrollback patch: source idempotence, transcript finalization, and no clear-on-shrink during live updates.
const {
  TRANSCRIPT_CONTAINER_SOURCE,
  applyNativeScrollbackFrameForTest,
  patchInteractiveModeSource,
  patchNativeScrollbackTuiSource,
  patchToolExecutionSource,
} = await import(pathToFileURL(path.join(root, "scripts/patch-pi-scrollback.mjs")).href);
const scrollbackTuiSample = [
  "export class TUI {",
  "    previousLines = [];",
  "    previousKittyImageIds = new Set();",
  "    previousWidth = 0;",
  "    previousHeight = 0;",
  "    cursorRow = 0;",
  "    hardwareCursorRow = 0;",
  "    clearOnShrink = true;",
  "    maxLinesRendered = 0;",
  "    previousViewportTop = 0; // Track previous viewport top for resize-aware cursor moves",
  "    requestRender(force = false) {",
  "        if (force) {",
  "            this.previousLines = [];",
  "            this.previousWidth = -1; // -1 triggers widthChanged, forcing a full clear",
  "            this.previousHeight = -1; // -1 triggers heightChanged, forcing a full clear",
  "            this.cursorRow = 0;",
  "        }",
  "    }",
  "    collectKittyImageIds(lines) { return new Set(); }",
  "    render(width) { return []; }",
  "    /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */",
  "    compositeOverlays(lines, width, height) { return lines; }",
  "    extractCursorPosition(lines, height) { return null; }",
  "    applyLineResets(lines) { return lines; }",
  "    doRender() {",
  "        const width = this.terminal.columns;",
  "        const height = this.terminal.rows;",
  "        const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;",
  "        const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;",
  "        const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;",
  "        let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;",
  "        let viewportTop = prevViewportTop;",
  "        let hardwareCursorRow = this.hardwareCursorRow;",
  "        // Render all components to get new lines",
  "        let newLines = this.render(width);",
  "        // Composite overlays into the rendered lines (before differential compare)",
  "        if (this.overlayStack.length > 0) {",
  "            newLines = this.compositeOverlays(newLines, width, height);",
  "        }",
  "        // Extract cursor position before applying line resets (marker must be found first)",
  "        const cursorPos = this.extractCursorPosition(newLines, height);",
  "        newLines = this.applyLineResets(newLines);",
  "        const fullRender = (_clear) => {};",
  "        const logRedraw = (_reason) => {};",
  "        // First render - just output everything without clearing (assumes clean screen)",
  "        if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {",
  "            fullRender(false);",
  "            return;",
  "        }",
  "        if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {",
  "            fullRender(true);",
  "        }",
  "    }",
  "}",
  "//# sourceMappingURL=tui.js.map",
  "",
].join("\n");
const scrollbackPatchedTui = patchNativeScrollbackTuiSource(scrollbackTuiSample);
if (patchNativeScrollbackTuiSource(scrollbackPatchedTui) !== scrollbackPatchedTui) throw new Error("native scrollback tui patch idempotence smoke failed");
if (!scrollbackPatchedTui.includes("this.nativeScrollbackCommittedRows === 0 && newLines.length < this.maxLinesRendered")) throw new Error("native scrollback clearOnShrink guard smoke failed");
if (scrollbackPatchedTui.indexOf("applyNativeScrollbackFrame") > scrollbackPatchedTui.indexOf("Extract cursor position")) throw new Error("native scrollback frame application order smoke failed");
if (scrollbackPatchedTui.indexOf("nativeCanOmitCommittedRows") > scrollbackPatchedTui.indexOf("renderNativeScrollbackFrame(width, height, nativeCanOmitCommittedRows)")) throw new Error("native scrollback reset-before-render smoke failed");
if (!scrollbackPatchedTui.includes("child.renderNativeScrollbackFrame") || scrollbackPatchedTui.includes("getNativeScrollbackStableLineCount(width, height")) throw new Error("native scrollback lazy child frame smoke failed");
if (!scrollbackPatchedTui.includes("this.overlayStack?.length")) throw new Error("native scrollback overlay full-render trigger smoke failed");
if (!scrollbackPatchedTui.includes("nativeSplitFrameActive") || !scrollbackPatchedTui.includes("__piSplitFrameActive !== false")) throw new Error("native scrollback split-active guard smoke failed");
if (!scrollbackPatchedTui.includes("PI_NATIVE_SCROLLBACK_PATCH:reset-full-render") || !scrollbackPatchedTui.includes('logRedraw("native scrollback reset")')) throw new Error("native scrollback reset full-render smoke failed");
if (!scrollbackPatchedTui.includes("if (resetNativeScrollback) {\n            this.nativeScrollbackCommittedRows = 0;\n            this.previousLines = [];")) throw new Error("native scrollback reset state clearing smoke failed");
const eagerSplitNativeTui = scrollbackPatchedTui.replace(
  "        const nativeSplitFrameActive = Boolean(globalThis.__piSplitFrame) && globalThis.__piSplitFrameActive !== false;\n        const nativeCanOmitCommittedRows = !(widthChanged || heightChanged || nativeSplitFrameActive || ((this.overlayStack?.length ?? 0) > 0));\n",
  "        const nativeCanOmitCommittedRows = !(widthChanged || heightChanged || globalThis.__piSplitFrame || ((this.overlayStack?.length ?? 0) > 0));\n",
);
const upgradedEagerSplitNativeTui = patchNativeScrollbackTuiSource(eagerSplitNativeTui);
if (!upgradedEagerSplitNativeTui.includes("nativeSplitFrameActive") || upgradedEagerSplitNativeTui.includes("globalThis.__piSplitFrame ||")) throw new Error("native scrollback eager-split upgrade smoke failed");
const legacyNativeMethods = [
  "    // PI_NATIVE_SCROLLBACK_PATCH:methods:start",
  "    renderNativeScrollbackFrame(width, height) {",
  "        const lines = this.render(width);",
  "        return { lines, stablePrefixLineCount: 0 };",
  "    }",
  "    applyNativeScrollbackFrame(lines, stablePrefixLineCount, height, widthChanged, heightChanged) {",
  "        return lines;",
  "    }",
  "    // PI_NATIVE_SCROLLBACK_PATCH:methods:end",
  "",
].join("\n");
const legacyNativeTui = scrollbackPatchedTui.replace(/    \/\/ PI_NATIVE_SCROLLBACK_PATCH:methods:start\n[\s\S]*?    \/\/ PI_NATIVE_SCROLLBACK_PATCH:methods:end\n/, legacyNativeMethods);
const upgradedNativeTui = patchNativeScrollbackTuiSource(legacyNativeTui);
if (!upgradedNativeTui.includes("canOmitCommittedRows = true") || upgradedNativeTui.includes("const lines = this.render(width);")) throw new Error("native scrollback old-patch upgrade smoke failed");
const { TUI: SmokeNativeTui } = await import(`data:text/javascript,${encodeURIComponent(scrollbackPatchedTui)}`);
const prefixedTui = new SmokeNativeTui();
let nativeCommittedSeen = "not called";
prefixedTui.nativeScrollbackCommittedRows = 3;
prefixedTui.children = [
  { render() { return ["prefix"]; } },
  { renderNativeScrollbackFrame(_width, committedRows) { nativeCommittedSeen = committedRows; return { lines: ["stable", "live"], stablePrefixLineCount: 1, resetRequired: false }; } },
];
let prefixedFrame = prefixedTui.renderNativeScrollbackFrame(80, 10, true);
if (!prefixedFrame.resetRequired || nativeCommittedSeen !== "not called") throw new Error("native scrollback non-prefix reset smoke failed");
prefixedFrame = prefixedTui.renderNativeScrollbackFrame(80, 10, false);
if (nativeCommittedSeen !== 0 || prefixedFrame.stablePrefixLineCount !== 0 || prefixedFrame.lines.join("|") !== "prefix|stable|live") throw new Error("native scrollback non-prefix full-frame smoke failed");

const toolExecutionSample = [
  "import { Box, Container, getCapabilities, Image, Spacer, Text } from \"@earendil-works/pi-tui\";",
  "class ToolExecutionComponent {",
  "    hideComponent = false;",
  "    constructor(toolName, toolCallId, args, options = {}, toolDefinition, ui, cwd) {",
  "        this.ui = ui;",
  "        this.cwd = cwd;",
  "        this.addChild(new Spacer(1));",
  "    }",
  "    updateResult(result, isPartial = false) {",
  "        this.result = result;",
  "        this.isPartial = isPartial;",
  "        this.updateDisplay();",
  "        this.maybeConvertImagesForKitty();",
  "    }",
  "    render(width) {",
  "        if (this.hideComponent) {",
  "            return [];",
  "        }",
  "        if (this.hasRendererDefinition() && this.getRenderShell() === \"self\") {",
  "            const contentLines = this.selfRenderContainer.render(width);",
  "            if (contentLines.length === 0 && this.imageComponents.length === 0) {",
  "                return [];",
  "            }",
  "            const lines = [];",
  "            if (contentLines.length > 0) {",
  "                lines.push(\"\");",
  "                lines.push(...contentLines);",
  "            }",
  "            for (let i = 0; i < this.imageComponents.length; i++) {",
  "                const spacer = this.imageSpacers[i];",
  "                if (spacer) {",
  "                    lines.push(...spacer.render(width));",
  "                }",
  "                const imageComponent = this.imageComponents[i];",
  "                if (imageComponent) {",
  "                    lines.push(...imageComponent.render(width));",
  "                }",
  "            }",
  "            return lines;",
  "        }",
  "        return super.render(width);",
  "    }",
  "    updateDisplay() {}",
  "}",
].join("\n");
const patchedToolExecution = patchToolExecutionSource(toolExecutionSample);
if (patchToolExecutionSource(patchedToolExecution) !== patchedToolExecution) throw new Error("tool execution patch idempotence smoke failed");
if (!patchedToolExecution.includes("markFinal") || patchedToolExecution.includes("this.addChild(new Spacer(1));")) throw new Error("tool execution live/final spacing smoke failed");
if (!patchedToolExecution.includes("tool-frame-render") || !patchedToolExecution.includes("toolFrameBashCallLines")) throw new Error("tool execution frame render smoke failed");
if (!patchedToolExecution.includes("truncateToWidth") || !patchedToolExecution.includes("visibleWidth")) throw new Error("tool execution width helpers smoke failed");
if (!patchedToolExecution.includes("tool-frame-background") || !patchedToolExecution.includes("theme.bg(this.toolFrameBgColor(), line)") || !patchedToolExecution.includes("this.toolFrameBg(this.toolFrameRule")) throw new Error("tool execution frame background smoke failed");
const legacyToolExecutionFrame = patchedToolExecution
  .replace(/    toolFrameBgColor\(\) \{[\s\S]*?    \/\/ PI_NATIVE_SCROLLBACK_PATCH:tool-frame-background\n/, "")
  .replaceAll('this.toolFrameBg(this.toolFrameRule(frameWidth, "top", " " + this.toolFrameTitle() + " "))', 'this.toolFrameRule(frameWidth, "top", " " + this.toolFrameTitle() + " ")')
  .replaceAll('this.toolFrameBg(this.toolFrameBodyLine(frameWidth, line))', 'this.toolFrameBodyLine(frameWidth, line)')
  .replaceAll('this.toolFrameBg(this.toolFrameRule(frameWidth, "middle", " Output "))', 'this.toolFrameRule(frameWidth, "middle", " Output ")')
  .replaceAll('this.toolFrameBg(this.toolFrameRule(frameWidth, "bottom"))', 'this.toolFrameRule(frameWidth, "bottom")');
const upgradedToolExecutionFrame = patchToolExecutionSource(legacyToolExecutionFrame);
if (!upgradedToolExecutionFrame.includes("tool-frame-background") || !upgradedToolExecutionFrame.includes("this.toolFrameBg(this.toolFrameRule")) throw new Error("tool execution old-frame background upgrade smoke failed");

const interactiveModeSample = [
  "import { ToolExecutionComponent } from \"./components/tool-execution.js\";",
  "class InteractiveMode {",
  "  constructor() {",
  "        this.chatContainer = new Container();",
  "  }",
  "  f(content, event) {",
  "                    this.chatContainer.addChild(this.streamingComponent);",
  "                    this.streamingComponent.updateContent(this.streamingMessage);",
  "    new ToolExecutionComponent(content.name, content.id, content.arguments, {}, this.getRegisteredToolDefinition(content.name), this.ui, this.sessionManager.getCwd());",
  "    new ToolExecutionComponent(event.toolName, event.toolCallId, event.args, {}, this.getRegisteredToolDefinition(event.toolName), this.ui, this.sessionManager.getCwd());",
  "                    this.streamingComponent = undefined;",
  "                    this.streamingMessage = undefined;",
  "                    this.footer.invalidate();",
  "            this.chatContainer.addChild(this.streamingComponent);",
  "        }",
  "        this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? \"hidden\" : \"visible\"}`);",
  "  }",
  "}",
].join("\n");
const patchedInteractiveMode = patchInteractiveModeSource(interactiveModeSample);
if (patchInteractiveModeSource(patchedInteractiveMode) !== patchedInteractiveMode) throw new Error("interactive mode scrollback patch idempotence smoke failed");
if (!patchedInteractiveMode.includes("new TranscriptContainer()") || patchedInteractiveMode.includes("this.ui, this.sessionManager.getCwd());")) throw new Error("interactive mode transcript wiring smoke failed");

const transcriptTestSource = TRANSCRIPT_CONTAINER_SOURCE.replace(
  'import { Container } from "@earendil-works/pi-tui";',
  'class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); } removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); } clear() { this.children = []; } }',
);
const { TranscriptContainer } = await import(`data:text/javascript,${encodeURIComponent(transcriptTestSource)}`);
const transcript = new TranscriptContainer();
const stableChild = { render() { return ["stable"]; } };
const liveTool = { render() { return ["tool", "tail"]; }, transcriptWantsLeadingSpacer() { return true; } };
transcript.addChild(stableChild);
transcript.addChild(liveTool);
transcript.markLive(liveTool);
let transcriptFrame = transcript.renderNativeScrollbackFrame(80, 0);
if (transcriptFrame.stablePrefixLineCount !== 1 || transcriptFrame.lines.join("|") !== "stable||tool|tail") throw new Error("transcript live-prefix smoke failed");
transcript.markFinal(liveTool);
transcriptFrame = transcript.renderNativeScrollbackFrame(80, 0);
if (transcriptFrame.stablePrefixLineCount !== 4 || transcriptFrame.lines.join("|") !== "stable||tool|tail") throw new Error("transcript finalization smoke failed");

let stableRenderCount = 0;
const lazyTranscript = new TranscriptContainer();
const countedStable = { render() { stableRenderCount++; return ["s1", "s2"]; } };
const countedLive = { render() { return ["live"]; }, transcriptWantsLeadingSpacer() { return true; } };
lazyTranscript.addChild(countedStable);
lazyTranscript.addChild(countedLive);
lazyTranscript.markLive(countedLive);
transcriptFrame = lazyTranscript.renderNativeScrollbackFrame(80, 0);
if (stableRenderCount !== 1 || transcriptFrame.lines.join("|") !== "s1|s2||live") throw new Error("transcript initial lazy render smoke failed");
transcriptFrame = lazyTranscript.renderNativeScrollbackFrame(80, 2);
if (stableRenderCount !== 1 || transcriptFrame.lines.join("|") !== "|live" || transcriptFrame.stablePrefixLineCount !== 0 || transcriptFrame.omittedRows !== 2) throw new Error("transcript committed stable omission smoke failed");

const partialTranscript = new TranscriptContainer();
partialTranscript.addChild({ render() { return ["a", "b", "c"]; } });
transcriptFrame = partialTranscript.renderNativeScrollbackFrame(80, 1);
if (transcriptFrame.lines.join("|") !== "b|c" || transcriptFrame.stablePrefixLineCount !== 2 || transcriptFrame.omittedRows !== 1) throw new Error("transcript partial omission smoke failed");

transcriptFrame = lazyTranscript.renderNativeScrollbackFrame(80, 99);
if (!transcriptFrame.resetRequired || transcriptFrame.lines.join("|") !== "s1|s2||live") throw new Error("transcript over-omission reset smoke failed");

const nativeState = {
  nativeScrollbackCommittedRows: 0,
  previousLines: Array.from({ length: 60 }, (_, i) => `old ${i}`),
  cursorRow: 59,
  hardwareCursorRow: 59,
  previousViewportTop: 50,
  maxLinesRendered: 60,
};
const managedLines = applyNativeScrollbackFrameForTest(nativeState, Array.from({ length: 60 }, (_, i) => `new ${i}`), 50, 10);
if (managedLines.length !== 10 || nativeState.nativeScrollbackCommittedRows !== 50 || nativeState.maxLinesRendered !== 10) throw new Error("native scrollback viewport-tail smoke failed");
if (nativeState.maxLinesRendered > managedLines.length) throw new Error("native scrollback live tool update would trigger clear-on-shrink smoke failed");
const deltaState = {
  nativeScrollbackCommittedRows: 50,
  previousLines: Array.from({ length: 12 }, (_, i) => `old delta ${i}`),
  cursorRow: 11,
  hardwareCursorRow: 11,
  previousViewportTop: 2,
  maxLinesRendered: 12,
};
const deltaLines = applyNativeScrollbackFrameForTest(deltaState, Array.from({ length: 12 }, (_, i) => `new delta ${i}`), 2, 10);
if (deltaLines.length !== 10 || deltaState.nativeScrollbackCommittedRows !== 52 || deltaState.nativeScrollbackLastDelta !== 2) throw new Error("native scrollback delta-commit smoke failed");
const boundedState = {
  nativeScrollbackCommittedRows: 20,
  previousLines: Array.from({ length: 11 }, (_, i) => `old bounded ${i}`),
  cursorRow: 10,
  hardwareCursorRow: 10,
  previousViewportTop: 1,
  maxLinesRendered: 11,
};
const boundedLines = applyNativeScrollbackFrameForTest(boundedState, Array.from({ length: 12 }, (_, i) => `new bounded ${i}`), 5, 10);
if (boundedLines.length !== 11 || boundedState.nativeScrollbackCommittedRows !== 21 || boundedState.nativeScrollbackLastDelta !== 1) throw new Error("native scrollback delta previous-frame bound smoke failed");
const maxLinesBeforeReset = deltaState.maxLinesRendered;
const previousLineCountBeforeReset = deltaState.previousLines.length;
const resetLines = applyNativeScrollbackFrameForTest(deltaState, ["full"], 0, 10, { resetNativeScrollback: true });
if (
  resetLines.length !== 1 ||
  deltaState.nativeScrollbackCommittedRows !== 0 ||
  deltaState.maxLinesRendered !== maxLinesBeforeReset ||
  deltaState.previousLines.length !== previousLineCountBeforeReset ||
  deltaState.nativeScrollbackLastDelta !== 0
) throw new Error("native scrollback reset smoke failed");

for (const required of ["search", "ast_grep", "ast_edit", "todo_write", "ask", "web_search", "task"]) {
  if (!tools.has(required)) throw new Error(`missing tool: ${required}`);
}

console.log(`registered tools: ${Array.from(tools.keys()).sort().join(", ")}`);
console.log(`registered handlers: ${handlers.map((handler) => handler.event).sort().join(", ")}`);
