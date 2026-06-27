import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const tools = new Map();
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
  sendMessage() {},
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
  "extensions/subagents/index.ts",
]) {
  const mod = await jiti.import(path.join(root, file));
  mod.default(pi);
}

const ctx = { cwd: root, hasUI: false, ui: {} };

// system-prompt: custom prompts must re-attach the tool promptGuidelines that
// pi's buildSystemPrompt() drops on the customPrompt path (D11).
{
  let systemPrompt = "base";
  for (const { handler } of handlers.filter((handler) => handler.event === "before_agent_start")) {
    const result = await handler(
      {
        type: "before_agent_start",
        prompt: "smoke",
        systemPrompt,
        systemPromptOptions: {
          cwd: root,
          promptGuidelines: [
            "Use edit for precise changes (edits[].oldText must match exactly)",
            "",
            "  Keep edits[].oldText as small as possible while still being unique.  ",
            "Use edit for precise changes (edits[].oldText must match exactly)",
          ],
        },
      },
      ctx,
    );
    if (result?.systemPrompt) systemPrompt = result.systemPrompt;
  }
  if (!systemPrompt.includes("staff-level coding agent")) throw new Error("system-prompt smoke failed: compact prompt missing");
  if (!systemPrompt.includes("ls for directory listings")) throw new Error("system-prompt smoke failed: ls/find routing missing");
  if (!systemPrompt.includes("oldText must match exactly")) throw new Error("system-prompt smoke failed: tool guidelines not restored");
  if (systemPrompt.split("Keep edits[].oldText").length !== 2) throw new Error("system-prompt smoke failed: guidelines not deduplicated");
}

// tool-policy: edit pre-flight guard.
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
      throw new Error(`edit guard smoke failed: ${label}`);
    }
  };

  const dir = mkdtempSync(path.join(tmpdir(), "smoke-edit-"));
  try {
    const file = path.join(dir, "RoomTest.elm");
    writeFileSync(
      file,
      [
        "suite =",
        '    describe "rooms"',
        '        [ test "it works"',
        "        ]",
        '    describe "rooms"',
        '        [ test "it works"',
        "        ]",
        "describe “the room” do",
        "  assert true  ",
        "end — done",
        "",
      ].join("\n"),
    );
    const rel = path.relative(root, file);

    // Exact + unique: allowed through (undefined).
    if (
      await emitToolCall({
        type: "tool_call",
        toolName: "edit",
        input: { path: rel, edits: [{ oldText: "end — done", newText: "end - ok" }] },
      })
    ) {
      throw new Error("edit guard smoke failed: exact unique edit blocked");
    }

    // Non-unique exact match: blocked with occurrence lines.
    expectBlocked(
      await emitToolCall({
        type: "tool_call",
        toolName: "edit",
        input: { path: rel, edits: [{ oldText: '    describe "rooms"', newText: "ok" }] },
      }),
      "matches 2 locations",
      "duplicate occurrences not reported",
    );

    // Fuzzy-only match (model dropped trailing spaces): blocked with exact bytes.
    const fuzzy = await emitToolCall({
      type: "tool_call",
      toolName: "edit",
      input: { path: rel, edits: [{ oldText: "assert true\nend", newText: "assert false\nend" }] },
    });
    expectBlocked(fuzzy, "normalization", "fuzzy-only match not blocked");
    if (!fuzzy.reason.includes("··")) throw new Error("edit guard smoke failed: trailing spaces not visualized");

    // No match at all (wrong indentation): blocked with candidates + hint.
    const missing = await emitToolCall({
      type: "tool_call",
      toolName: "edit",
      input: { path: rel, edits: [{ oldText: 'suite =\n  describe "rooms"', newText: "ok" }] },
    });
    expectBlocked(missing, "not fuzzy-matched", "indentation hint missing");
    if (!missing.reason.includes('L2:     describe "rooms"')) throw new Error("edit guard smoke failed: candidate lines not shown");

    // Unreadable file: never blocked (the tool reports it instead).
    if (
      await emitToolCall({
        type: "tool_call",
        toolName: "edit",
        input: { path: path.join(dir, "missing.elm"), edits: [{ oldText: "x", newText: "y" }] },
      })
    ) {
      throw new Error("edit guard smoke failed: missing file blocked");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

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

  // Command-position matching: subcommand arguments must never trigger the
  // redirect (`aws s3 ls` regression).
  for (const command of ["aws s3 ls", "git ls-files", "npm ls", "git grep foo", "echo cat"]) {
    if (
      await emitToolCall({ type: "tool_call", toolName: "bash", input: { command } })
    ) {
      throw new Error(`bash policy blocked '${command}' — argument matched instead of command position`);
    }
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
    "bash policy missed command-position coreutil in 'ls | head'",
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
    for (const command of ["ls", "cat foo.txt", "grep -n TODO foo.txt"]) {
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

const search = tools.get("search");
const searchResult = await search.execute("smoke-search", { pattern: "AGENT_PROMPTS", paths: "extensions/subagents/agents.ts" }, undefined, undefined, ctx);
if (!searchResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("search smoke failed");

const ls = tools.get("ls");
const lsResult = await ls.execute("smoke-ls", { path: "extensions" }, undefined, undefined, ctx);
if (!lsResult.content[0].text.includes("tool-policy.ts")) throw new Error("ls smoke failed");

const find = tools.get("find");
const findResult = await find.execute("smoke-find", { pattern: "*.ts", path: "extensions" }, undefined, undefined, ctx);
if (!findResult.content[0].text.includes("tool-policy.ts")) throw new Error("find smoke failed");

const todo = tools.get("todo_write");
const todoResult = await todo.execute("smoke-todo", { ops: [{ op: "init", list: [{ phase: "Smoke", items: ["Run smoke"] }] }, { op: "done", task: "Run smoke" }] }, undefined, undefined, ctx);
if (!todoResult.content[0].text.includes("✓ Run smoke")) throw new Error("todo smoke failed");

const ask = tools.get("ask");
const askResult = await ask.execute("smoke-ask", { questions: [{ id: "choice", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 1 }] }, undefined, undefined, ctx);
if (!askResult.content[0].text.includes("B")) throw new Error("ask smoke failed");

const ast = tools.get("ast_grep");
const astResult = await ast.execute("smoke-ast", { pat: "AGENT_PROMPTS", paths: ["extensions/subagents/agents.ts"], lang: "ts" }, undefined, undefined, ctx);
if (!astResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("ast_grep smoke failed");

for (const required of ["search", "ast_grep", "ast_edit", "todo_write", "ask", "subagents", "ls", "find"]) {
  if (!tools.has(required)) throw new Error(`missing tool: ${required}`);
}

console.log(`registered tools: ${Array.from(tools.keys()).sort().join(", ")}`);
console.log(`registered handlers: ${handlers.map((handler) => handler.event).sort().join(", ")}`);
