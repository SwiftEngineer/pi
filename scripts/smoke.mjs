import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

// The subagents extension registers nothing when it detects a subagent child;
// the smoke asserts its full registration, so force the parent role.
delete process.env.SWIFT_PI_SUBAGENT;
const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const tools = new Map();
const commands = new Map();
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

const shortcuts = [];
const messageRenderers = new Map();
const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  on(event, handler) { handlers.push({ event, handler }); },
  getActiveTools() { return ["read", "bash", "edit", "write", ...tools.keys()]; },
  registerShortcut(keyId, options) { shortcuts.push({ keyId, options }); },
  registerMessageRenderer(customType, renderer) { messageRenderers.set(customType, renderer); },
  registerCommand(name, options) { commands.set(name, options); },
  getAllTools() { return []; },
  sendMessage(message) { sentMessages.push(message); },
  sendUserMessage() {},
  appendEntry() {},
  exec: execCommand,
};

for (const file of [
  "extensions/system-prompt.ts",
  "extensions/tool-policy.ts",
  "extensions/fs-tools.ts",
  "extensions/default-model.ts",
  "extensions/search.ts",
  "extensions/ast-tools.ts",
  "extensions/todo-write.ts",
  "extensions/ask.ts",
  "extensions/context.ts",
  "extensions/subagents/index.ts",
]) {
  const mod = await jiti.import(path.join(root, file));
  mod.default(pi);
}

const ctx = { cwd: root, hasUI: false, ui: {} };

// system-prompt: custom prompts must re-attach the tool promptGuidelines that
// pi's buildSystemPrompt() drops on the customPrompt path (D11). Fixtures use
// the shipped edit-anchor phrasing (hash anchors copied from the served read).
{
  let systemPrompt = "base";
  const anchorGuideline =
    "Copy edit anchors (the 3-char hash before │) byte-for-byte from your latest read of the file";
  for (const { handler } of handlers.filter((handler) => handler.event === "before_agent_start")) {
    const result = await handler(
      {
        type: "before_agent_start",
        prompt: "smoke",
        systemPrompt,
        systemPromptOptions: {
          cwd: root,
          promptGuidelines: [
            anchorGuideline,
            "",
            "  Keep each edit span as small as possible while still being unique.  ",
            anchorGuideline,
          ],
        },
      },
      ctx,
    );
    if (result?.systemPrompt) systemPrompt = result.systemPrompt;
  }
  if (!systemPrompt.includes("staff-level coding agent")) throw new Error("system-prompt smoke failed: compact prompt missing");
  if (!systemPrompt.includes("ls for directory listings")) throw new Error("system-prompt smoke failed: ls/find routing missing");
  if (!systemPrompt.includes("3-char hash before │")) throw new Error("system-prompt smoke failed: tool guidelines not restored");
  // Exactly two occurrences: once from the compact prompt itself, once from the
  // restored guidelines (the duplicate fixture entry must be deduplicated).
  if (systemPrompt.split(anchorGuideline).length !== 3) {
    throw new Error("system-prompt smoke failed: guidelines not restored exactly once / not deduplicated");
  }
  if (systemPrompt.split("Keep each edit span as small as possible").length !== 2) {
    throw new Error("system-prompt smoke failed: guidelines not trimmed/deduplicated");
  }
}

// tool-policy: bash command policy.
{
  const emitToolCall = async (event) => {
    for (const { handler } of handlers.filter((handler) => handler.event === "tool_call")) {
      const result = await handler(event, ctx);
      if (result?.block) return result;
    }
    return undefined;
  };
  const expectBlocked = (result, needle, label) => {
    if (!result?.block || !result.reason.includes(needle)) {
      throw new Error(`tool-policy smoke failed: ${label}`);
    }
  };
  const expectAllowed = async (command, label) => {
    if (await emitToolCall({ type: "tool_call", toolName: "bash", input: { command } })) {
      throw new Error(`tool-policy smoke failed: blocked '${command}' — ${label}`);
    }
  };

  // bash policy regression checks: the message must name the live replacement tool.
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: "ls" } }),
    "Use the ls tool instead of shelling out to ls",
    "bash policy stopped blocking ls",
  );
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: "cat foo.txt" } }),
    "Use the read tool instead of shelling out to cat",
    "bash policy stopped blocking cat",
  );
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: "grep -n TODO foo.txt" } }),
    "Use the search tool instead of shelling out to grep",
    "bash policy stopped blocking grep",
  );

  // `bash -c` / `sh -c` payloads get the same screening as top-level commands.
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: 'bash -c "cat /etc/hosts"' } }),
    "Use the read tool instead of shelling out to cat",
    "bash -c payload bypassed command-position detection",
  );
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: "sh -c 'ls'" } }),
    "Use the ls tool instead of shelling out to ls",
    "sh -c payload bypassed command-position detection",
  );
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: 'sudo bash -c "grep -n TODO foo.txt"' } }),
    "Use the search tool instead of shelling out to grep",
    "wrapped bash -c payload bypassed command-position detection",
  );
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: 'bash -lc "ls 2>/dev/null"' } }),
    "Do not redirect stderr",
    "bash -c payload bypassed stderr-redirect detection",
  );
  // ...but payloads that are legitimate pass through.
  await expectAllowed('bash -c "make test"', "benign -c payload");

  // stderr-redirect variants: 2>&1, 2>/dev/null, 2>>file, &>, &>>.
  for (const command of ["make 2>&1", "make 2>/dev/null", "make 2>>build.log", "make &>build.log", "make &>>build.log"]) {
    expectBlocked(
      await emitToolCall({ type: "tool_call", toolName: "bash", input: { command } }),
      "Do not redirect stderr",
      `stderr-redirect variant missed in '${command}'`,
    );
  }

  // awk/sed are legitimate when no dedicated tool replaces them ...
  await expectAllowed("awk '{print $1}' foo.txt", "awk has no dedicated replacement");
  await expectAllowed("sed 's/a/b/' foo.txt", "sed has no dedicated replacement");
  // ...but the specific `sed -n` line-range read rule still applies.
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: "sed -n '1,10p' foo.txt" } }),
    "Use read offsets/ranges",
    "sed -n rule stopped blocking line-range reads",
  );

  // Command-position matching: subcommand arguments must never trigger the
  // redirect (`aws s3 ls` regression).
  for (const command of ["aws s3 ls", "git ls-files", "npm ls", "git grep foo", "echo cat"]) {
    await expectAllowed(command, "argument matched instead of command position");
  }
  // ...but wrappers in front of a shell coreutil are still caught.
  for (const command of ["sudo cat /etc/hosts", "FOO=1 ls", "time ls", "xargs ls"]) {
    expectBlocked(
      await emitToolCall({ type: "tool_call", toolName: "bash", input: { command } }),
      "shelling out",
      `bash policy missed command-position coreutil in '${command}'`,
    );
  }
  expectBlocked(
    await emitToolCall({ type: "tool_call", toolName: "bash", input: { command: "ls | head" } }),
    "head/tail",
    "bash policy missed pipe-through-head in 'ls | head'",
  );

  // tool-policy must never point at a tool that is not registered: with no
  // replacement tools active, shell ls/cat/grep pass through and only the
  // harness-behavior rules (pipe-through-head/tail etc.) still block.
  {
    const policyHandlers = [];
    const policyTools = new Map();
    const policyPi = {
      registerTool(tool) { policyTools.set(tool.name, tool); },
      on(event, handler) { policyHandlers.push({ event, handler }); },
      getActiveTools() { return [...policyTools.keys()]; },
      exec: execCommand,
    };
    const policyMod = await jiti.import(path.join(root, "extensions/tool-policy.ts"));
    policyMod.default(policyPi);
    const policyCtx = { cwd: root, hasUI: false, ui: {} };
    const emitPolicyCall = async (event) => {
      for (const { handler } of policyHandlers.filter((handler) => handler.event === "tool_call")) {
        const result = await handler(event, policyCtx);
        if (result?.block) return result;
      }
      return undefined;
    };
    for (const command of ["ls", "cat foo.txt", "grep -n TODO foo.txt", "awk '{print $1}' foo.txt"]) {
      if (await emitPolicyCall({ type: "tool_call", toolName: "bash", input: { command } })) {
        throw new Error(`tool-policy blocked '${command}' with no replacement tool registered`);
      }
    }
    expectBlocked(
      await emitPolicyCall({ type: "tool_call", toolName: "bash", input: { command: "foo | head" } }),
      "head/tail",
      "pipe rule must still block without replacement tools",
    );
  }
}

// default-model: explicit model choices (set/cycle) become the new default in
// the agent settings.json; restores must not redefine it.
{
  const agentDir = mkdtempSync(path.join(tmpdir(), "smoke-agent-"));
  mkdirSync(agentDir, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const settingsPath = path.join(agentDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ packages: [], theme: "dark/dark", defaultProvider: "zai", defaultModel: "glm-5.2" }, null, 2) + "\n");

    const emitModelSelect = (event) => {
      for (const { handler } of handlers.filter((handler) => handler.event === "model_select")) {
        handler(event, ctx);
      }
    };
    const readSettings = () => JSON.parse(readFileSync(settingsPath, "utf8"));

    emitModelSelect({ type: "model_select", source: "set", model: { provider: "anthropic", id: "claude-opus-5" }, previousModel: undefined });
    let settings = readSettings();
    if (settings.defaultProvider !== "anthropic" || settings.defaultModel !== "claude-opus-5") {
      throw new Error("default-model smoke failed: explicit set not persisted");
    }
    if (settings.theme !== "dark/dark" || !Array.isArray(settings.packages)) {
      throw new Error("default-model smoke failed: unrelated settings clobbered");
    }

    emitModelSelect({ type: "model_select", source: "cycle", model: { provider: "openai", id: "gpt-5.5" }, previousModel: settings });
    settings = readSettings();
    if (settings.defaultProvider !== "openai" || settings.defaultModel !== "gpt-5.5") {
      throw new Error("default-model smoke failed: cycle not persisted");
    }

    emitModelSelect({ type: "model_select", source: "restore", model: { provider: "zai", id: "glm-5.2" }, previousModel: settings });
    settings = readSettings();
    if (settings.defaultProvider !== "openai" || settings.defaultModel !== "gpt-5.5") {
      throw new Error("default-model smoke failed: restore overwrote default");
    }

    // Missing settings file: extension must create it instead of crashing.
    rmSync(settingsPath);
    emitModelSelect({ type: "model_select", source: "set", model: { provider: "google", id: "gemini-3.1-pro-preview" }, previousModel: undefined });
    settings = readSettings();
    if (settings.defaultProvider !== "google" || settings.defaultModel !== "gemini-3.1-pro-preview") {
      throw new Error("default-model smoke failed: missing settings file not created");
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// context: custom-role messages (delivered subagent results) must count toward
// the Messages category — they reach the LLM as user messages.
{
  const command = commands.get("context");
  if (!command) throw new Error("context smoke failed: /context command not registered");
  const customContent = "SMOKE_CUSTOM_PAYLOAD ".repeat(20);
  const entries = [
    {
      type: "custom_message",
      id: "e2",
      parentId: "e1",
      timestamp: new Date().toISOString(),
      customType: "subagent_result",
      content: customContent,
      display: true,
      details: { notCounted: true },
    },
  ];
  const commandCtx = {
    cwd: root,
    mode: "print",
    hasUI: false,
    ui: { notify() {} },
    model: { name: "Smoke Model", id: "smoke-model", contextWindow: 100_000 },
    sessionManager: { getEntries: () => entries, getLeafId: () => "e2" },
    getSystemPrompt: () => "base",
    getSystemPromptOptions: () => ({}),
  };
  await command.handler("", commandCtx);
  const breakdown = sentMessages.at(-1)?.details;
  if (!breakdown) throw new Error("context smoke failed: no breakdown sent");
  const messages = breakdown.categories.find((category) => category.id === "messages");
  const expected = Math.ceil(customContent.length / 4);
  if (!messages || messages.tokens !== expected) {
    throw new Error(`context smoke failed: custom message tokens ${messages?.tokens} != ${expected}`);
  }
}

const search = tools.get("search");
const searchResult = await search.execute("smoke-search", { pattern: "AGENT_PROMPTS", paths: "extensions/subagents/agents.ts" }, undefined, undefined, ctx);
if (!searchResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("search smoke failed");

// search: nested .gitignore files between the search root and each file are
// honored (each relative to its own directory), and an invalid regex returns a
// friendly tool error instead of throwing a raw RegExp error.
{
  const dir = mkdtempSync(path.join(tmpdir(), "smoke-ignore-"));
  try {
    mkdirSync(path.join(dir, "pkg"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), "root-skip.txt\n");
    writeFileSync(path.join(dir, "pkg", ".gitignore"), "nested-skip.txt\n");
    writeFileSync(path.join(dir, "root-skip.txt"), "NEEDLE_ROOT_SKIP\n");
    writeFileSync(path.join(dir, "pkg", "nested-skip.txt"), "NEEDLE_NESTED_SKIP\n");
    writeFileSync(path.join(dir, "pkg", "kept.txt"), "NEEDLE_KEPT\n");
    const ignoreCtx = { cwd: dir, hasUI: false, ui: {} };
    const ignored = await search.execute("smoke-ignore", { pattern: "NEEDLE_", paths: dir }, undefined, undefined, ignoreCtx);
    const text = ignored.content[0].text;
    if (!text.includes("pkg/kept.txt")) throw new Error("search smoke failed: unignored file missed");
    if (text.includes("NEEDLE_ROOT_SKIP")) throw new Error("search smoke failed: root .gitignore not honored");
    if (text.includes("NEEDLE_NESTED_SKIP")) throw new Error("search smoke failed: nested .gitignore not honored");

    const bad = await search.execute("smoke-badregex", { pattern: "([unclosed" }, undefined, undefined, ctx);
    if (!bad.content[0].text.includes("Invalid regular expression")) {
      throw new Error("search smoke failed: invalid regex not caught");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ls = tools.get("ls");
const lsResult = await ls.execute("smoke-ls", { path: "extensions" }, undefined, undefined, ctx);
if (!lsResult.content[0].text.includes("tool-policy.ts")) throw new Error("ls smoke failed");

const find = tools.get("find");
const findResult = await find.execute("smoke-find", { pattern: "*.ts", path: "extensions" }, undefined, undefined, ctx);
if (!findResult.content[0].text.includes("tool-policy.ts")) throw new Error("find smoke failed");

const todo = tools.get("todo_write");
const todoResult = await todo.execute("smoke-todo", { ops: [{ op: "init", list: [{ phase: "Smoke", items: ["Run smoke"] }] }, { op: "done", task: "Run smoke" }] }, undefined, undefined, ctx);
if (!todoResult.content[0].text.includes("✓ Run smoke")) throw new Error("todo smoke failed");

// todo-write: session_start must reset phase state so todos cannot leak across
// session switches in a long-lived process.
{
  const sessionStart = handlers.filter((handler) => handler.event === "session_start");
  if (sessionStart.length === 0) throw new Error("todo smoke failed: no session_start handler registered");
  for (const { handler } of sessionStart) await handler({ type: "session_start", reason: "new" }, ctx);
  const after = await todo.execute("smoke-todo-reset", { ops: [] }, undefined, undefined, ctx);
  if (!after.content[0].text.includes("No todos.")) throw new Error("todo smoke failed: phases not reset on session start");
}

const ask = tools.get("ask");
const askResult = await ask.execute("smoke-ask", { questions: [{ id: "choice", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 1 }] }, undefined, undefined, ctx);
if (!askResult.content[0].text.includes("B")) throw new Error("ask smoke failed");

// ask: in TUI mode, cancelling (Esc) must record no answer instead of the
// recommended option, and labels that legitimately end with "(Recommended)"
// must survive intact.
{
  const cancelCtx = { cwd: root, hasUI: true, ui: { async select() { return undefined; } } };
  const cancelled = await ask.execute(
    "smoke-ask-cancel",
    { questions: [{ id: "pick", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 1 }] },
    undefined,
    undefined,
    cancelCtx,
  );
  if (!cancelled.content[0].text.includes("(cancelled — no answer)")) throw new Error("ask smoke failed: cancel not reported");
  if (cancelled.details.answers.pick !== undefined) throw new Error("ask smoke failed: cancel fabricated an answer");
  if (!Array.isArray(cancelled.details.cancelled) || !cancelled.details.cancelled.includes("pick")) {
    throw new Error("ask smoke failed: cancelled question not recorded");
  }

  const pickCtx = {
    cwd: root,
    hasUI: true,
    ui: { async select(_title, options) { return options.find((option) => option.includes("(Recommended)")); } },
  };
  const picked = await ask.execute(
    "smoke-ask-label",
    { questions: [{ id: "pick", question: "Pick", options: [{ label: "Keep (Recommended)" }] }] },
    undefined,
    undefined,
    pickCtx,
  );
  if (picked.details.answers.pick[0] !== "Keep (Recommended)") throw new Error("ask smoke failed: label corrupted by suffix stripping");
}

const ast = tools.get("ast_grep");
const astResult = await ast.execute("smoke-ast", { pat: "AGENT_PROMPTS", paths: ["extensions/subagents/agents.ts"], lang: "ts" }, undefined, undefined, ctx);
if (!astResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("ast_grep smoke failed");

// zai-compat: must import cleanly and register the Z.ai schema-safe provider
// override. extensions/zai-models.ts (a parallel workstream) may not exist yet;
// retry once after a short wait before giving up.
{
  const zaiPath = path.join(root, "extensions/zai-compat.ts");
  if (!existsSync(zaiPath)) throw new Error("zai-compat smoke failed: extensions/zai-compat.ts missing");
  const loadZaiCompat = async () => {
    try {
      return await jiti.import(zaiPath);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return await jiti.import(zaiPath);
    }
  };
  const zaiMod = await loadZaiCompat();
  const providers = [];
  zaiMod.default({ registerProvider(provider) { providers.push(provider); } });
  if (providers.length !== 1) {
    throw new Error(`zai-compat smoke failed: provider not registered (got ${providers.length})`);
  }
}

for (const required of ["search", "ast_grep", "ast_edit", "todo_write", "ask", "subagents", "ls", "find"]) {
  if (!tools.has(required)) throw new Error(`missing tool: ${required}`);
}

console.log(`registered tools: ${Array.from(tools.keys()).sort().join(", ")}`);
console.log(`registered handlers: ${handlers.map((handler) => handler.event).sort().join(", ")}`);
