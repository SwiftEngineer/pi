import { spawn } from "node:child_process";
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

const pi = {
  registerTool(tool) { tools.set(tool.name, tool); },
  on(event, handler) { handlers.push({ event, handler }); },
  exec: execCommand,
};

for (const file of [
  "extensions/system-prompt.ts",
  "extensions/tool-policy.ts",
  "extensions/search.ts",
  "extensions/ast-tools.ts",
  "extensions/todo-write.ts",
  "extensions/ask.ts",
  "extensions/web-search.ts",
  "extensions/task/index.ts",
]) {
  const mod = await jiti.import(path.join(root, file));
  mod.default(pi);
}

const ctx = { cwd: root, hasUI: false, ui: {} };

const search = tools.get("search");
const searchResult = await search.execute("smoke-search", { pattern: "AGENT_PROMPTS", paths: "extensions/task/index.ts" }, undefined, undefined, ctx);
if (!searchResult.content[0].text.includes("AGENT_PROMPTS")) throw new Error("search smoke failed");

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

for (const required of ["search", "ast_grep", "ast_edit", "todo_write", "ask", "web_search", "task"]) {
  if (!tools.has(required)) throw new Error(`missing tool: ${required}`);
}

console.log(`registered tools: ${Array.from(tools.keys()).sort().join(", ")}`);
console.log(`registered handlers: ${handlers.map((handler) => handler.event).sort().join(", ")}`);
