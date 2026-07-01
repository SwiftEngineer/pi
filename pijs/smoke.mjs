#!/usr/bin/env node
/**
 * PiJS parity + smoke harness (Phase 6).
 *
 * Companion to `scripts/smoke.mjs` (the Node dual-target harness). Where that one
 * loads the Node `extensions/*.ts` through a fake `pi`, this one targets the
 * ported `pijs/*.ts` set — the 11 entries registered in `package.json`
 * `pi.extensions` — through an EXPANDED fake `pi`/`ctx` that stubs the hostcalls
 * the ports use (`http`, `session`, `ui`, `exec`, `process`, …) with the CONFIRMED
 * shapes from docs/migration-to-pi-agent-rust.md §9.
 *
 * It runs in Node (not the QuickJS sandbox) and loads the `.ts` files via `jiti`,
 * so the pijs runtime gotchas (private-field loader bug, module-specifier limits)
 * do not apply to the harness — only the extensions' own logic is exercised.
 *
 * Three tiers of check (see the printed report):
 *   1. LOAD + REGISTER — every pijs entry loads and registers tools / commands /
 *      renderers / shortcuts / event handlers with no throw and no load error.
 *   2. PARITY (pijs vs Node) — for the deterministic, host-independent extensions
 *      (tool-policy, system-prompt, todo-write, search, ast-tools, web-fetch) load
 *      BOTH the `extensions/*.ts` and `pijs/*.ts` versions with equivalent fakes
 *      and assert identical output over identical inputs.
 *   3. PIJS EXECUTE SMOKE — for host-dependent extensions (ask, web-search, task,
 *      subagent-view, tui-powerline) drive `execute()`/event handlers through the
 *      fake surface and assert the expected result shape. Real child spawning and
 *      real TUI painting are NOT reproduced here (they need a binary) — those are
 *      "load-only + faked-execute".
 *
 * Exits non-zero on any failure with a per-check report; exits 0 with a summary
 * when all pass. Run via `npm run smoke:pijs`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");

// Match the Rust sandbox's EMPTY `process.env` for every field the ported
// extensions actually read, so the harness can't diverge from production via a
// host var the sandbox wouldn't expose: web-search provider keys (→ "no
// provider configured"), HOME (tui-powerline's `~`-collapse), locale vars
// (subagent-view ascii detection), and PI_* (task's PI_TASK_* budgets). PATH
// and everything else are deliberately RETAINED — the harness itself spawns the
// real package-local ast-grep for the ast-tools parity checks.
for (const key of Object.keys(process.env)) {
  if (/_API_KEY$/.test(key) || key === "HOME" || key === "LANG" || key.startsWith("LC_") || key.startsWith("PI_")) {
    delete process.env[key];
  }
}

// The non-blocking `task` reads PI_TASK_* budgets at module-load time (its first
// import is Tier 1's load check), so set the fast-settle tunables HERE, before
// any load, or they'd freeze at the production defaults and the task smoke would
// poll for its full multi-minute budget.
process.env.PI_TASK_POLL_INTERVAL_MS = "15";
process.env.PI_TASK_ORCH_BUDGET_MS = "3000";
process.env.PI_TASK_CHILD_TIMEOUT_MS = "2000";

const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });

// ---------------------------------------------------------------------------
// Tiny assertion / reporting framework
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<{name:string, ok:boolean, err?:string}>>} */
const sections = new Map();
let currentSection = "general";
const notes = [];

function section(name) {
  currentSection = name;
  if (!sections.has(name)) sections.set(name, []);
}
function note(text) {
  notes.push(text);
}
async function check(name, fn) {
  try {
    await fn();
    sections.get(currentSection).push({ name, ok: true });
  } catch (error) {
    sections.get(currentSection).push({ name, ok: false, err: error && error.message ? error.message : String(error) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eqStr(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}
function eqJson(actual, expected, msg) {
  eqStr(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ---------------------------------------------------------------------------
// Real subprocess exec — CONFIRMED pi.exec shape {code, killed, stdout, stderr}
// (used for the ast-grep parity checks, which run the real package-local binary)
// ---------------------------------------------------------------------------

function realExec(command, args, options = {}) {
  // resolveSg (pijs/ast-tools.ts) may hand back a repo-relative binary path
  // (`node_modules/@ast-grep/cli/ast-grep`). A child spawned with cwd=<tmp>
  // would resolve that against <tmp> → ENOENT. The binary lives under the repo
  // root, so resolve a relative binary command against root before spawning;
  // the child still RUNS in options.cwd (the ast-grep target dir).
  const bin = command.includes("/") && !path.isAbsolute(command) ? path.resolve(root, command) : command;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: options.cwd ?? root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code, signal) => resolve({ code: code ?? 0, killed: signal !== null, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, killed: false, stdout, stderr: `${stderr}${error.message}\n` }));
  });
}

// ---------------------------------------------------------------------------
// Expanded fake `pi` — the surface the pijs ports touch (CONFIRMED shapes §9)
// ---------------------------------------------------------------------------

const CANNED_STATE = {
  model: { provider: "smoke", id: "smoke-model" },
  thinkingLevel: "high",
  sessionName: "Smoke Session",
  messageCount: 3,
  isStreaming: false,
  // The context window IS available at runtime — the Phase-5 live PTY test
  // observed the footer render it (e.g. `?/1M`); tui-powerline reads
  // `state?.contextWindow ?? state?.model?.contextWindow` (exact provenance —
  // get_state vs the model registry — is unconfirmed, but the value resolves).
  // The tui-powerline check below asserts the context segment actually renders
  // this, so the field is not an untested fiction.
  contextWindow: 1_000_000,
};

function makeFakePi(overrides = {}) {
  const tools = new Map();
  const commands = new Map();
  const renderers = new Map();
  const shortcuts = new Map();
  const handlers = [];
  const sent = [];
  const uiCalls = [];

  const pi = {
    registerTool(spec) { tools.set(spec.name, spec); },
    registerCommand(name, spec) { commands.set(name, spec); },
    registerMessageRenderer(type, renderer) { renderers.set(type, renderer); },
    registerShortcut(key, spec) { shortcuts.set(key, spec); },
    on(event, handler) { handlers.push({ event, handler }); },
    sendMessage(message, options) { sent.push({ ...message, options }); },
    exec: overrides.exec ?? realExec,
    // pi.http(req) → CONFIRMED { body:string, headers:object, status:number }
    http: overrides.http ?? (async () => ({ body: "", headers: {}, status: 200 })),
    // pi.session(op) — canned read ops
    async session(op) {
      if (op === "get_state") return overrides.state ?? CANNED_STATE;
      if (op === "get_messages" || op === "get_branch") return [];
      return undefined;
    },
    // pi.ui(op, args) hostcall form — capture calls
    ui(op, args) { uiCalls.push({ op, args }); return undefined; },
    getActiveTools() { return Array.from(tools.keys()); },
    getAllTools() {
      return Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo: { source: "pijs-smoke" },
      }));
    },
    env: { get: () => undefined },
    // §9: pi.process.cwd() form (ctx.cwd is the primary path everywhere).
    process: { cwd: () => root },
  };
  if (overrides.piExtra) Object.assign(pi, overrides.piExtra);
  return { pi, tools, commands, renderers, shortcuts, handlers, sent, uiCalls };
}

function makeCtx(overrides = {}) {
  return {
    cwd: root,
    hasUI: false,
    ui: {},
    sessionManager: { getEntries: () => [], getBranch: () => [], getLeafEntry: () => undefined },
    modelRegistry: { getApiKeyForProvider: () => undefined },
    ...overrides,
  };
}

async function loadDefault(file, pi) {
  const mod = await jiti.import(path.join(root, file));
  if (typeof mod.default !== "function") throw new Error(`${file} has no default export function`);
  mod.default(pi);
}

/** Load an extension into a fresh fake pi and return the capture bundle. */
async function loadFresh(file, overrides = {}) {
  const bundle = makeFakePi(overrides);
  await loadDefault(file, bundle.pi);
  return bundle;
}

function handlerFor(bundle, event) {
  const found = bundle.handlers.find((h) => h.event === event);
  if (!found) throw new Error(`no handler registered for event '${event}'`);
  return found.handler;
}

// The shared subagent registry singleton (task ⇄ subagent-view rendezvous).
const { subagentRegistry } = await jiti.import(path.join(root, "pijs/subagent-view/registry.ts"));

// ===========================================================================
// TIER 1 — LOAD + REGISTER (the 11 registered pijs entries)
// ===========================================================================

section("LOAD + REGISTER (11 pijs extensions)");

const REGISTERED = [
  "pijs/system-prompt.ts",
  "pijs/tool-policy.ts",
  "pijs/search.ts",
  "pijs/ast-tools.ts",
  "pijs/todo-write.ts",
  "pijs/ask.ts",
  "pijs/web-search.ts",
  "pijs/web-fetch.ts",
  "pijs/task/index.ts",
  "pijs/subagent-view/index.ts",
  "pijs/tui-powerline.ts",
];

// Expected registrations per extension — Tier 1 asserts the ACTUAL tool/command
// names + events match these, not merely that "something" registered (a partial
// port that dropped e.g. ast_edit must fail here, not slip through).
const EXPECTED = {
  "pijs/system-prompt.ts": { events: ["before_agent_start"] },
  "pijs/tool-policy.ts": { events: ["tool_call"] },
  "pijs/search.ts": { tools: ["search"] },
  "pijs/ast-tools.ts": { tools: ["ast_edit", "ast_grep"] },
  "pijs/todo-write.ts": { tools: ["todo_write"] },
  "pijs/ask.ts": { tools: ["ask"] },
  "pijs/web-search.ts": { tools: ["web_search"] },
  "pijs/web-fetch.ts": { tools: ["web_fetch"] },
  "pijs/task/index.ts": { tools: ["task"] },
  "pijs/subagent-view/index.ts": { shortcuts: 5, events: ["session_start", "agent_start", "agent_end", "session_shutdown"] },
  "pijs/tui-powerline.ts": { events: ["session_start", "model_select", "context", "message_end", "agent_end", "input", "session_tree", "session_compact", "session_shutdown"] },
};

const loadSummary = [];
for (const file of REGISTERED) {
  await check(`load+register ${file}`, async () => {
    const bundle = await loadFresh(file);
    const parts = [];
    if (bundle.tools.size) parts.push(`tools=[${[...bundle.tools.keys()].join(",")}]`);
    if (bundle.commands.size) parts.push(`commands=[${[...bundle.commands.keys()].join(",")}]`);
    if (bundle.renderers.size) parts.push(`renderers=[${[...bundle.renderers.keys()].join(",")}]`);
    if (bundle.shortcuts.size) parts.push(`shortcuts=${bundle.shortcuts.size}`);
    if (bundle.handlers.length) parts.push(`events=[${bundle.handlers.map((h) => h.event).join(",")}]`);
    assert(parts.length > 0, "extension registered nothing");
    // Assert the EXACT expected registrations, not just non-emptiness.
    const exp = EXPECTED[file];
    if (exp) {
      if (exp.tools) {
        eqStr([...bundle.tools.keys()].sort().join(","), [...exp.tools].sort().join(","), `${file}: registered tool names mismatch`);
      }
      if (exp.commands) {
        eqStr([...bundle.commands.keys()].sort().join(","), [...exp.commands].sort().join(","), `${file}: registered command names mismatch`);
      }
      if (exp.events) {
        const got = new Set(bundle.handlers.map((h) => h.event));
        for (const ev of exp.events) assert(got.has(ev), `${file}: missing expected event '${ev}'`);
      }
      if (typeof exp.shortcuts === "number") {
        assert(bundle.shortcuts.size === exp.shortcuts, `${file}: expected ${exp.shortcuts} shortcuts, got ${bundle.shortcuts.size}`);
      }
    }
    loadSummary.push(`${file.replace("pijs/", "")}  ->  ${parts.join("  ")}`);
  });
}

// Cross-extension globalThis singleton sharing (§9 #7): the registry that
// task/index.ts and subagent-view/index.ts both import is the one stash on
// globalThis, so a single QuickJS global lets the two entries share state.
await check("shared subagentRegistry singleton is stashed on globalThis (§9 #7)", async () => {
  assert(globalThis.__piSubagentRegistry__ === subagentRegistry, "globalThis singleton mismatch");
  subagentRegistry.reset();
  subagentRegistry.add("share:1", "probe", "task");
  assert(subagentRegistry.size() === 1, "registry mutation not observed");
  subagentRegistry.reset();
});

// ===========================================================================
// TIER 2 — PARITY (pijs vs Node extensions/) over identical inputs
// ===========================================================================

section("PARITY: pijs vs Node (identical output over identical inputs)");

// --- tool-policy: block decision ---
await check("tool-policy: block decisions identical to Node", async () => {
  const pj = await loadFresh("pijs/tool-policy.ts");
  const nd = await loadFresh("extensions/tool-policy.ts");
  const hp = handlerFor(pj, "tool_call");
  const hn = handlerFor(nd, "tool_call");
  const commands = [
    "grep foo src", "cat file.txt", "sed -n '1,5p' f", "echo hi | head -5", "ls -la",
    "git status", "find . -name '*.ts'", "rg needle", "echo x 2>/dev/null", "less f",
    "awk '{print $1}'", "sed 's/a/b/' f", "npm run build", "node script.js", "cmd 2>&1",
    "tail -f log", "/usr/bin/grep x", "true",
  ];
  for (const command of commands) {
    const event = { toolName: "bash", toolCallId: "t", input: { command } };
    eqJson(hp(event) ?? null, hn(event) ?? null, `tool-policy mismatch for command: ${command}`);
  }
  // non-bash tools are never blocked
  eqJson(hp({ toolName: "read", input: {} }) ?? null, hn({ toolName: "read", input: {} }) ?? null, "non-bash mismatch");
});

// --- system-prompt: injected systemPrompt string ---
await check("system-prompt: identical systemPrompt string", async () => {
  const pj = await loadFresh("pijs/system-prompt.ts");
  const nd = await loadFresh("extensions/system-prompt.ts");
  const rp = handlerFor(pj, "before_agent_start")({}, makeCtx());
  const rn = handlerFor(nd, "before_agent_start")({}, makeCtx());
  eqStr(rp.systemPrompt, rn.systemPrompt, "system prompt differs");
  assert(rp.systemPrompt.includes("staff-level coding agent"), "prompt content sanity check failed");
});

// --- todo-write: state-machine render ---
await check("todo-write: init/done/note/drop/append render identical to Node", async () => {
  const pj = await loadFresh("pijs/todo-write.ts");
  const nd = await loadFresh("extensions/todo-write.ts");
  const tp = pj.tools.get("todo_write");
  const tn = nd.tools.get("todo_write");
  const sequences = [
    { ops: [{ op: "init", list: [{ phase: "Alpha", items: ["a1", "a2"] }, { phase: "Beta", items: ["b1"] }] }] },
    { ops: [{ op: "done", task: "a1" }, { op: "note", task: "a2", text: "looking into it" }] },
    { ops: [{ op: "drop", task: "b1" }, { op: "append", phase: "Gamma", items: ["g1", "g2"] }] },
    { ops: [{ op: "done", phase: "Gamma" }] },
  ];
  for (const seq of sequences) {
    const rp = await tp.execute("t", seq, undefined, undefined, makeCtx());
    const rn = await tn.execute("t", seq, undefined, undefined, makeCtx());
    eqStr(rp.content[0].text, rn.content[0].text, `todo render differs after ${JSON.stringify(seq)}`);
  }
});

// --- search: single-file exact output + no-match + directory-walk match set ---
await check("search: single-file output identical to Node", async () => {
  const pj = await loadFresh("pijs/search.ts");
  const nd = await loadFresh("extensions/search.ts");
  const sp = pj.tools.get("search");
  const sn = nd.tools.get("search");
  const args = { pattern: "staff-level", paths: "pijs/system-prompt.ts" };
  const rp = await sp.execute("t", args, undefined, undefined, makeCtx());
  const rn = await sn.execute("t", args, undefined, undefined, makeCtx());
  eqStr(rp.content[0].text, rn.content[0].text, "search single-file text differs");
  assert(rp.content[0].text.includes("staff-level"), "expected match content missing");
});

await check("search: no-match output identical to Node", async () => {
  const pj = await loadFresh("pijs/search.ts");
  const nd = await loadFresh("extensions/search.ts");
  const args = { pattern: "ZZZ_TOKEN_THAT_DOES_NOT_EXIST_ZZZ", paths: "pijs/system-prompt.ts" };
  const rp = await pj.tools.get("search").execute("t", args, undefined, undefined, makeCtx());
  const rn = await nd.tools.get("search").execute("t", args, undefined, undefined, makeCtx());
  eqStr(rp.content[0].text, rn.content[0].text, "search no-match text differs");
});

await check("search: directory-walk match set identical to Node (order-independent)", async () => {
  const pj = await loadFresh("pijs/search.ts");
  const nd = await loadFresh("extensions/search.ts");
  const args = { pattern: "SubagentViewState", paths: "pijs/subagent-view", context: 0 };
  const rp = await pj.tools.get("search").execute("t", args, undefined, undefined, makeCtx());
  const rn = await nd.tools.get("search").execute("t", args, undefined, undefined, makeCtx());
  const matchLines = (text) => text.split("\n").filter((l) => l.startsWith("*")).sort();
  eqJson(matchLines(rp.content[0].text), matchLines(rn.content[0].text), "directory-walk match set differs");
  // Header (match/file counts) must also agree.
  eqStr(rp.content[0].text.split("\n")[0], rn.content[0].text.split("\n")[0], "search directory header differs");
});

// --- ast-tools: arg assembly + real ast-grep compactOutput parity ---
await check("ast_grep: arg assembly + compactOutput identical to Node (real ast-grep)", async () => {
  const pjArgs = [];
  const ndArgs = [];
  const pj = await loadFresh("pijs/ast-tools.ts", { exec: (c, a, o) => { pjArgs.push(a); return realExec(c, a, o); } });
  const nd = await loadFresh("extensions/ast-tools.ts", { exec: (c, a, o) => { ndArgs.push(a); return realExec(c, a, o); } });
  const args = { pat: "return $A", paths: ["pijs/tool-policy.ts"], lang: "ts" };
  const rp = await pj.tools.get("ast_grep").execute("t", args, undefined, undefined, makeCtx());
  const rn = await nd.tools.get("ast_grep").execute("t", args, undefined, undefined, makeCtx());
  eqJson(pjArgs, ndArgs, "ast_grep exec arg assembly differs");
  eqStr(rp.content[0].text, rn.content[0].text, "ast_grep result text differs");
  assert(rp.content[0].text !== "No matches.", "expected ast_grep matches (parity would be vacuous)");
});

// --- ast-tools: rewrite (ast_edit) parity via disposable temp files ---
await check("ast_edit: rewrite output + on-disk result identical to Node (real ast-grep)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pijs-smoke-astedit-"));
  try {
    const sourceText = "const x = 1;\nconsole.log(x);\nconsole.log('done');\n";
    await writeFile(path.join(tmp, "pj.ts"), sourceText, "utf8");
    await writeFile(path.join(tmp, "nd.ts"), sourceText, "utf8");
    const editArgs = (file) => ({ ops: [{ pat: "console.log($$$A)", out: "logger.info($$$A)" }], paths: [file], lang: "ts" });
    const pj = await loadFresh("pijs/ast-tools.ts");
    const nd = await loadFresh("extensions/ast-tools.ts");
    const rp = await pj.tools.get("ast_edit").execute("t", editArgs("pj.ts"), undefined, undefined, makeCtx({ cwd: tmp }));
    const rn = await nd.tools.get("ast_edit").execute("t", editArgs("nd.ts"), undefined, undefined, makeCtx({ cwd: tmp }));
    eqStr(rp.content[0].text, rn.content[0].text, "ast_edit result text differs");
    const pjFile = await readFile(path.join(tmp, "pj.ts"), "utf8");
    const ndFile = await readFile(path.join(tmp, "nd.ts"), "utf8");
    eqStr(pjFile, ndFile, "ast_edit rewrote files differently");
    assert(pjFile.includes("logger.info(x)"), "ast_edit did not apply the rewrite");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- web-fetch: html/json/binary/invalid pipelines identical to Node ---
await check("web-fetch: HTML/JSON/binary/invalid pipelines identical to Node", async () => {
  const HTML = [
    "<!doctype html><html><head><title>Hello &amp; World</title><style>.x{color:red}</style></head>",
    "<body><h1>Main &mdash; Title</h1>",
    "<p>Para with &lt;tag&gt; &#169; and &nbsp; spaced text.</p>",
    "<ul><li>item one</li><li>item two</li></ul>",
    "<script>var x = 1;</script><footer>footer noise</footer></body></html>",
  ].join("\n");
  const cases = [
    { label: "html", url: "https://example.com/page", contentType: "text/html; charset=utf-8", status: 200, body: HTML },
    { label: "json", url: "https://example.com/data.json", contentType: "application/json", status: 200, body: '{"b":2,"a":1}' },
    { label: "binary", url: "https://example.com/img.png", contentType: "image/png", status: 200, body: "\x89PNG..." },
    { label: "http-500", url: "https://example.com/err", contentType: "text/html", status: 500, body: "oops" },
    { label: "invalid-url", url: "not a url", contentType: "text/html", status: 200, body: "" },
  ];
  for (const c of cases) {
    const httpFake = async () => ({ status: c.status, headers: { "content-type": c.contentType }, body: c.body });
    const pj = await loadFresh("pijs/web-fetch.ts", { http: httpFake });
    const fetchFake = async (url) => ({
      ok: c.status >= 200 && c.status < 300,
      status: c.status,
      // The CONFIRMED rust pi.http response shape has NO statusText, so the
      // pijs port can never emit one; give the Node fetch fake an empty
      // statusText too so this parity check compares PORT LOGIC, not a
      // host-provided field that legitimately differs between the two runtimes.
      statusText: "",
      url: String(url),
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? c.contentType : null) },
      text: async () => c.body,
    });
    const nd = await loadFresh("extensions/web-fetch.ts");
    const prevFetch = globalThis.fetch;
    globalThis.fetch = fetchFake;
    let rn;
    try {
      rn = await nd.tools.get("web_fetch").execute("t", { url: c.url }, undefined, undefined, makeCtx());
    } finally {
      globalThis.fetch = prevFetch;
    }
    const rp = await pj.tools.get("web_fetch").execute("t", { url: c.url }, undefined, undefined, makeCtx());
    eqStr(rp.content[0].text, rn.content[0].text, `web-fetch ${c.label} text differs`);
  }
});

// ===========================================================================
// TIER 3 — PIJS EXECUTE SMOKE (host-dependent; faked inputs; not Node parity)
// ===========================================================================

section("PIJS EXECUTE SMOKE (faked host surface)");

// --- ask: no-UI fallback + ctx.ui.select path ---
await check("ask: no-UI fallback picks recommended; ctx.ui.select path works", async () => {
  const bundle = await loadFresh("pijs/ask.ts");
  const ask = bundle.tools.get("ask");
  const r1 = await ask.execute("t", { questions: [{ id: "q1", question: "Pick", options: [{ label: "A" }, { label: "B" }], recommended: 1 }] }, undefined, undefined, makeCtx({ hasUI: false }));
  assert(r1.content[0].text.includes("q1: B"), `expected fallback to recommended 'B', got: ${r1.content[0].text}`);
  const selCtx = makeCtx({ hasUI: true, ui: { select: async (_prompt, choices) => choices[0] } });
  const r2 = await ask.execute("t", { questions: [{ id: "q2", question: "Choose", options: [{ label: "X" }, { label: "Y" }] }] }, undefined, undefined, selCtx);
  assert(r2.content[0].text.includes("q2: X"), `expected select 'X', got: ${r2.content[0].text}`);
});

// --- web-search: no provider configured (empty env) ---
await check("web-search: reports 'no provider configured' with terminate:true", async () => {
  const bundle = await loadFresh("pijs/web-search.ts");
  const r = await bundle.tools.get("web_search").execute("t", { query: "anything" }, undefined, undefined, makeCtx());
  assert(r.content[0].text.includes("No web search provider is configured"), `unexpected text: ${r.content[0].text}`);
  assert(r.terminate === true, "expected terminate:true");
});

// --- task: NON-BLOCKING background pipeline -------------------------------
// The rewritten `task` is non-blocking: execute() launches detached child `pi`
// processes (writing --mode json to files) and returns "Started …" immediately;
// a background orchestration (advanced by the host pump) polls the files and
// delivers the combined result via pi.sendMessage(followUp). Node's own event
// loop stands in for the host pump here. We make PI_TASK_* tunables tiny so the
// orchestration settles in ms, and drive the real shell protocol with a
// PROTOCOL-AWARE fake `exec` that answers mkdir/launch/read/cat/cleanup.
// (PI_TASK_* fast-settle tunables are set at the top of this file, before any load.)

function awaitUntil(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("awaitUntil: condition not met in time"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * Fake `exec` that understands the shell scripts the task orchestration issues:
 * `mkdir -p`, the detached `setsid` child launch (`echo $? > done-i`), the batched
 * read (framed by the runtime-random boundary — extracted from the script), the
 * per-child settle-time `cat out-i` (readOut) + `cat err-i` (readErr), and the
 * `rm -f`/`rmdir` cleanup. `perIndex[i]` supplies each child's `stdout` (what the
 * BATCHED poll sees), an optional `full` (what the settle-time `cat out-i` sees —
 * defaults to `stdout`; a LATER superset here exercises the finalize re-read), and
 * settled exit `code`.
 */
function makeTaskExec(perIndex) {
  return async (_cmd, args) => {
    const script = String((args && args[1]) || "");
    if (/mkdir -p/.test(script) || /\brmdir\b/.test(script) || /\brm -f\b/.test(script) || /kill -TERM/.test(script)) return { code: 0, killed: false, stdout: "", stderr: "" };
    if (/--mode json/.test(script) && /echo \$\? >/.test(script)) return { code: 0, killed: false, stdout: "", stderr: "" };
    const bm = script.match(/printf '\\n%s#%s\\n' '([^']+)' '(\d+)'/);
    if (bm) {
      const boundary = bm[1];
      const idxs = [...script.matchAll(/printf '\\n%s#%s\\n' '[^']+' '(\d+)'/g)].map((m) => Number(m[1]));
      let out = "";
      for (const i of idxs) out += `\n${boundary}#${i}\n${(perIndex[i] && perIndex[i].stdout) || ""}\n`;
      out += `\n${boundary}#SENT\n`;
      for (const i of idxs) out += `${i}=${(perIndex[i] && perIndex[i].code) ?? 0}\n`;
      return { code: 0, killed: false, stdout: out, stderr: "" };
    }
    // Settle-time single-file re-read: `cat '<dir>/out-<i>.json'` (no boundary).
    const outCat = script.match(/cat '[^']*out-(\d+)\.json'/);
    if (outCat) {
      const i = Number(outCat[1]);
      const p = perIndex[i] || {};
      return { code: 0, killed: false, stdout: p.full ?? p.stdout ?? "", stderr: "" };
    }
    return { code: 0, killed: false, stdout: "", stderr: "" }; // err cat / misc
  };
}

const CHILD_OK_STDOUT = [
  JSON.stringify({ type: "turn_start" }),
  JSON.stringify({ type: "message_start" }),
  JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial " } }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "CHILD_RESULT_OK" }] } }),
  JSON.stringify({ type: "agent_end" }),
].join("\n");

await check("task: non-blocking — 'Started' immediately, then delivers subagent-results follow-up", async () => {
  subagentRegistry.reset();
  const bundle = await loadFresh("pijs/task/index.ts", { exec: makeTaskExec({ 0: { stdout: CHILD_OK_STDOUT, code: 0 } }) });
  const res = await bundle.tools.get("task").execute("smoke", { agent: "explore", tasks: [{ id: "One", description: "first", assignment: "do the thing" }] }, undefined, undefined, makeCtx({ cwd: root }));
  // Immediate, non-blocking return — NO child results inline.
  assert(res.details.background === true, "task must be non-blocking (background:true)");
  assert(/Started 1 background sub-agent/.test(res.content[0].text), `expected Started message: ${res.content[0].text}`);
  assert(!res.content[0].text.includes("CHILD_RESULT_OK"), "execute() must not contain child results (they arrive as a follow-up)");
  assert(Array.isArray(res.details.taskIds) && res.details.taskIds[0] === "One", "expected taskIds in details");
  // Registry seeded up front.
  assert(subagentRegistry.list().some((a) => a.id === "smoke:One"), "registry not seeded");
  // Background orchestration delivers the combined result as a follow-up turn.
  await awaitUntil(() => bundle.sent.some((m) => m.customType === "subagent-results"), 4000);
  const delivered = bundle.sent.find((m) => m.customType === "subagent-results");
  assert(delivered, "no subagent-results follow-up delivered");
  assert(delivered.options && delivered.options.triggerTurn === true && delivered.options.deliverAs === "followUp", "follow-up must set triggerTurn + deliverAs:followUp");
  assert(delivered.content.includes("CHILD_RESULT_OK"), `delivered content missing child result: ${delivered.content}`);
  assert(delivered.content.includes("completed"), "delivered content missing completed status");
  const snap = subagentRegistry.list().find((a) => a.id === "smoke:One");
  assert(snap && snap.state === "done", "registry entry not settled to done");
  subagentRegistry.reset();
});

await check("task: failing child delivers failed(N) follow-up", async () => {
  subagentRegistry.reset();
  const bundle = await loadFresh("pijs/task/index.ts", { exec: makeTaskExec({ 0: { stdout: "", code: 1 } }) });
  await bundle.tools.get("task").execute("smoke2", { agent: "task", tasks: [{ id: "Bad", description: "x", assignment: "y" }] }, undefined, undefined, makeCtx({ cwd: root }));
  await awaitUntil(() => bundle.sent.some((m) => m.customType === "subagent-results"), 4000);
  const delivered = bundle.sent.find((m) => m.customType === "subagent-results");
  assert(delivered && delivered.content.includes("failed (1)"), `expected failed(1) delivery: ${delivered && delivered.content}`);
  assert(delivered.details.failed === true, "expected details.failed true");
  subagentRegistry.reset();
});

await check("task: invalid params rejected without spawning", async () => {
  const bundle = await loadFresh("pijs/task/index.ts", { exec: async () => { throw new Error("must not spawn"); } });
  const res = await bundle.tools.get("task").execute("smoke3", { agent: "task", tasks: [{ id: "", description: "x", assignment: "y" }] }, undefined, undefined, makeCtx());
  assert(res.details.background === false && Array.isArray(res.details.results), "expected structured rejection");
  assert(/task\.id/.test(res.content[0].text), `expected validation message, got: ${res.content[0].text}`);
  subagentRegistry.reset();
});

// The batched poll sees the done sentinel while out-i.json is still PARTIAL (no
// message_end); the child's final message_end lands only in the settle-time
// re-read (`cat out-i`). Proves the finalize re-read + exactly-once offset
// slicing recover a tail flushed between the poll's cat and its done check.
await check("task: settle-time re-read recovers a late message_end (finalize drain)", async () => {
  subagentRegistry.reset();
  const PARTIAL = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_start" }),
    JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "thinking… " } }),
  ].join("\n") + "\n"; // ends on a newline: the poll drains these, none carry the token
  const FULL = PARTIAL + [
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "LATE_TOKEN_Z" }] } }),
    JSON.stringify({ type: "agent_end" }),
  ].join("\n") + "\n";
  // Batched poll returns PARTIAL + sentinel(done); the finalize `cat out-0` returns FULL.
  const bundle = await loadFresh("pijs/task/index.ts", { exec: makeTaskExec({ 0: { stdout: PARTIAL, full: FULL, code: 0 } }) });
  await bundle.tools.get("task").execute("late", { agent: "explore", tasks: [{ id: "L", description: "late", assignment: "do it" }] }, undefined, undefined, makeCtx({ cwd: root }));
  await awaitUntil(() => bundle.sent.some((m) => m.customType === "subagent-results"), 4000);
  const delivered = bundle.sent.find((m) => m.customType === "subagent-results");
  assert(delivered, "no subagent-results follow-up delivered");
  assert(delivered.content.includes("LATE_TOKEN_Z"), `finalize re-read did NOT recover the late message_end: ${delivered.content}`);
  assert(delivered.content.includes("completed"), "delivered content missing completed status");
  // Exactly-once: the token must appear exactly once (no double-drain of the tail).
  const occurrences = delivered.content.split("LATE_TOKEN_Z").length - 1;
  assert(occurrences === 1, `expected LATE_TOKEN_Z exactly once, got ${occurrences}`);
  const snap = subagentRegistry.list().find((a) => a.id === "late:L");
  assert(snap && snap.state === "done", "registry entry not settled to done");
  subagentRegistry.reset();
});

// Exactly-once delivery even when pi.sendMessage throws (cheap guard): the catch
// branch must NOT emit a second message.
await check("task: pi.sendMessage throwing does not double-deliver", async () => {
  subagentRegistry.reset();
  let sends = 0;
  const bundle = await loadFresh("pijs/task/index.ts", { exec: makeTaskExec({ 0: { stdout: CHILD_OK_STDOUT, code: 0 } }) });
  bundle.pi.sendMessage = () => { sends++; throw new Error("sendMessage boom"); };
  await bundle.tools.get("task").execute("throw", { agent: "explore", tasks: [{ id: "T", description: "t", assignment: "do it" }] }, undefined, undefined, makeCtx({ cwd: root }));
  // Give the background orchestration time to settle + attempt delivery.
  await awaitUntil(() => sends >= 1, 4000);
  await new Promise((r) => setTimeout(r, 200));
  assert(sends === 1, `expected exactly one sendMessage attempt, got ${sends}`);
  subagentRegistry.reset();
});

// --- subagent-view: setWidget strip push on registry change; clear on empty ---
await check("subagent-view: pushes strip lines via ctx.ui.setWidget on registry change", async () => {
  subagentRegistry.reset();
  const bundle = await loadFresh("pijs/subagent-view/index.ts");
  const widgetPushes = [];
  const ctx = makeCtx({ hasUI: true, ui: { setWidget: (key, lines) => widgetPushes.push({ key, lines }) } });
  handlerFor(bundle, "session_start")({ type: "session_start" }, ctx);
  subagentRegistry.add("sv:1", "Explore auth", "explore");
  subagentRegistry.start("sv:1");
  const last = widgetPushes.at(-1);
  assert(last && last.key === "subagent-strip", "expected a subagent-strip widget push");
  assert(Array.isArray(last.lines) && last.lines.length > 0 && last.lines.every((l) => typeof l === "string"), "expected non-empty string lines");
  // Emptying the registry clears the widget.
  subagentRegistry.reset();
  const afterReset = widgetPushes.at(-1);
  assert(afterReset && afterReset.lines.length === 0, "expected cleared widget on empty registry");
  handlerFor(bundle, "session_shutdown")({ type: "session_shutdown" });
  subagentRegistry.reset();
});

// --- tui-powerline: builds + pushes footer string from get_state + git branch ---
await check("tui-powerline: pushes footer string via ctx.ui.setFooter from get_state", async () => {
  const bundle = await loadFresh("pijs/tui-powerline.ts");
  let footer;
  let title;
  const ctx = makeCtx({ hasUI: true, ui: { setFooter: (s) => { footer = s; }, setTitle: (t) => { title = t; } } });
  await handlerFor(bundle, "session_start")({ type: "session_start" }, ctx);
  assert(typeof footer === "string" && footer.length > 0, "expected a non-empty footer string");
  assert(footer.includes("smoke-model"), "footer missing model id from get_state");
  assert(footer.includes("high"), "footer missing thinking level from get_state");
  // Context segment: the 1M window from CANNED_STATE.contextWindow must render
  // (used-tokens stay `?` — the host exposes no token usage). This is the sole
  // consumer of the contextWindow field, so assert it isn't silently dropped.
  assert(footer.includes("1M"), "footer missing context window (1M) from get_state");
  eqStr(title, "Smoke Session", "expected setTitle from session name");
});

// ===========================================================================
// Report
// ===========================================================================

let total = 0;
let failed = 0;
const lines = [];
lines.push("");
lines.push("=== PiJS parity + smoke harness ===");
for (const [name, entries] of sections) {
  lines.push("");
  lines.push(`── ${name} ──`);
  for (const entry of entries) {
    total++;
    if (!entry.ok) failed++;
    lines.push(`  ${entry.ok ? "[PASS]" : "[FAIL]"} ${entry.name}`);
    if (!entry.ok) lines.push(`         ${entry.err.replace(/\n/g, "\n         ")}`);
  }
}

lines.push("");
lines.push("── registration summary (per extension) ──");
for (const entry of loadSummary) lines.push(`  ${entry}`);

if (notes.length) {
  lines.push("");
  lines.push("── notes ──");
  for (const n of notes) lines.push(`  - ${n}`);
}

lines.push("");
lines.push(`Result: ${total - failed}/${total} checks passed${failed ? ` — ${failed} FAILED` : " — all green"}.`);
lines.push("");
console.log(lines.join("\n"));

process.exit(failed ? 1 : 0);
