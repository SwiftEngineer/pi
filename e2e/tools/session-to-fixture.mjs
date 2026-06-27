#!/usr/bin/env node
// Session → fixture converter for the Pi e2e harness.
//
// Turns any recorded Pi session (JSONL) into a `script.json` fixture that
// drives the hermetic faux-provider replay test. It walks the session tree to
// the leaf, repairs a truncated tail, and emits the contract that the runner
// and test read (see e2e/README.md / plan §1 schema).
//
// Usage:
//   node e2e/tools/session-to-fixture.mjs <session-id-or-path> \
//     [--name default] [--session-dir DIR] [--out e2e/fixtures] \
//     [--final-text "E2E replay complete."] [--force]
//
// Resolution: an existing file path wins; otherwise the argument is matched as
// a substring against session basenames under <session-dir>/*/*.jsonl.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import {
  parseSessionEntries,
  migrateSessionEntries,
} from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const ALLOWED_TOOLS = new Set(["bash", "read", "grep", "find", "ls", "search", "ast_grep"]);
const DEFAULT_FINAL_TEXT = "E2E replay complete.";
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 16384;

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`  ⚠ ${message}`);
}

// Minimal flag parser: one positional, the rest are `--key value` / `--flag`.
function parseArgs(argv) {
  const opts = { _: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") opts.force = true;
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--session-dir") opts.sessionDir = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--final-text") opts.finalText = argv[++i];
    else if (a.startsWith("--")) fail(`Unknown flag: ${a}`);
    else opts._.push(a);
  }
  return opts;
}

// Resolve <id-or-path> to a single session file. Existing file path wins;
// otherwise substring-match basenames under sessionsRoot/*/*.jsonl (plus any
// *.jsonl directly in sessionsRoot, so a cwd-encoded dir also works).
function resolveSessionFile(idOrPath, sessionsRoot) {
  if (existsSync(idOrPath) && statSync(idOrPath).isFile()) {
    return path.resolve(idOrPath);
  }

  const searchedDirs = [];
  const matches = [];
  const scanDir = (dir) => {
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }
    searchedDirs.push(dir);
    for (const f of files) {
      if (f.endsWith(".jsonl") && f.includes(idOrPath)) matches.push(path.join(dir, f));
    }
  };

  scanDir(sessionsRoot);
  let subdirs = [];
  try {
    subdirs = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    fail(`Session directory not found: ${sessionsRoot}`);
  }
  for (const d of subdirs) {
    if (d.isDirectory()) scanDir(path.join(sessionsRoot, d.name));
  }

  if (matches.length === 0) {
    fail(
      `No session matching "${idOrPath}" found.\n  Searched ${searchedDirs.length} dir(s) for */*.jsonl:\n` +
        searchedDirs.map((d) => `    - ${d}`).join("\n"),
    );
  }
  if (matches.length > 1) {
    fail(
      `Session id "${idOrPath}" is ambiguous — ${matches.length} matches:\n` +
        matches.map((m) => `    - ${m}`).join("\n"),
    );
  }
  return matches[0];
}

// Load the pi model catalog to look up contextWindow/maxTokens. The package's
// export map blocks the subpath, so import the dist file by absolute path.
async function loadModelCatalog() {
  try {
    const aiIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
    const modelsPath = path.join(path.dirname(aiIndex), "models.generated.js");
    if (!existsSync(modelsPath)) return null;
    const mod = await import(pathToFileURL(modelsPath).href);
    return mod.MODELS ?? null;
  } catch {
    return null;
  }
}

// Collapse to a single control-char-free line, then clamp to 40 chars.
function sanitizeHint(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

// Tools whose call ARGUMENTS pi's TUI actually renders on screen: the
// built-ins, which have a renderCall. Tools outside this set — e.g. the
// harness's own `search` and `ast_grep` (extensions/search.ts,
// extensions/ast-tools.ts), and any future non-builtin — define no
// renderCall, so pi's TUI draws only the bold tool name for their calls
// (verified in pi-coding-agent's tool-execution.js: createCallFallback
// renders just the toolName). An argument-derived hint for those tools is
// therefore structurally unrenderable and would never appear on screen.
const ARG_RENDERED_TOOLS = new Set(["bash", "read", "grep", "find", "ls"]);

// Concatenate the text of a recorded content block array (mirrors the
// equivalent helper in e2e/tests/replay.test.mjs).
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

// Screen hint derived from the recorded tool CALL ARGUMENTS. Only valid for
// ARG_RENDERED_TOOLS — see the comment above.
function screenHintFromArgs(name, args) {
  const a = args || {};
  switch (name) {
    case "bash":
      return sanitizeHint(a.command);
    case "read":
      return sanitizeHint(path.basename(String(a.path ?? a.file ?? "")));
    case "grep":
      return sanitizeHint(a.pattern ?? a.query ?? "");
    case "find":
    case "ls":
      return sanitizeHint(a.path ?? a.dir ?? ".");
    default:
      return sanitizeHint(a.pattern ?? a.query ?? a.path ?? JSON.stringify(a));
  }
}

// Screen hint derived from the recorded tool RESULT: the first non-empty
// text line, sanitized to a single line and clamped. Used for tools whose
// arguments pi's TUI never draws (see ARG_RENDERED_TOOLS above), since their
// result text is what actually lands on screen. Falls back to the tool name
// if the call has no recorded result text.
function screenHintFromResult(name, result) {
  const text = contentText(result?.content);
  const firstLine = text.split("\n").find((l) => sanitizeHint(l).length > 0) ?? "";
  return sanitizeHint(firstLine) || name;
}

// Per-tool screen hint: asserted later as a substring of the TUI screen text,
// so it must be distinctive, stable, and — critically — actually rendered.
function screenHint(name, args, result) {
  if (ARG_RENDERED_TOOLS.has(name)) return screenHintFromArgs(name, args);
  return screenHintFromResult(name, result);
}

// Walk the session tree from a leaf to the root, returning entries in
// chronological (root→leaf) order. Picks the longest chain when several leaves
// exist.
function buildChain(entries) {
  const byId = new Map();
  const childCount = new Map();
  for (const e of entries) {
    if (e.type === "session") continue;
    byId.set(e.id, e);
    childCount.set(e.id, 0);
  }
  for (const e of entries) {
    if (e.type === "session") continue;
    if (e.parentId != null && childCount.has(e.parentId)) {
      childCount.set(e.parentId, childCount.get(e.parentId) + 1);
    }
  }

  const leaves = [...byId.values()].filter((e) => childCount.get(e.id) === 0);
  if (leaves.length === 0) fail("Session has no entries to convert.");

  const chainFrom = (leaf) => {
    const chain = [];
    const seen = new Set();
    let cur = leaf;
    while (cur) {
      if (seen.has(cur.id)) fail(`Cycle detected in session tree at entry ${cur.id}.`);
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId != null ? byId.get(cur.parentId) : null;
    }
    chain.reverse();
    return chain;
  };

  let chain = chainFrom(leaves[0]);
  if (leaves.length > 1) {
    for (const leaf of leaves.slice(1)) {
      const c = chainFrom(leaf);
      if (c.length > chain.length) chain = c;
    }
    warn(`Session has ${leaves.length} leaves; using the longest chain (${chain.length} entries).`);
  }
  return chain;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts._.length !== 1) {
    fail(
      "Usage: node e2e/tools/session-to-fixture.mjs <session-id-or-path> " +
        '[--name default] [--session-dir DIR] [--out e2e/fixtures] [--final-text "..."] [--force]',
    );
  }

  const name = opts.name || "default";
  const finalText = opts.finalText || DEFAULT_FINAL_TEXT;
  const sessionsRoot = opts.sessionDir || path.join(os.homedir(), ".pi", "agent", "sessions");
  const outDir = path.resolve(opts.out || path.join("e2e", "fixtures"));

  const sessionFile = resolveSessionFile(opts._[0], sessionsRoot);
  console.log(`\n◆ Converting session → fixture "${name}"`);
  console.log(`  source: ${sessionFile}`);

  const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
  migrateSessionEntries(entries);

  const header = entries.find((e) => e.type === "session");
  if (!header) fail("Session file is missing its header line.");

  const chain = buildChain(entries);

  // Walk the chain, validating v1 constraints and collecting messages.
  let modelChanges = 0;
  let provider = null;
  let modelId = null;
  let api = null;
  let thinkingLevel = "off";
  let reasoning = false;
  const userTexts = [];
  const responses = [];
  const toolResults = {};
  const resultIds = new Set();

  for (const e of chain) {
    switch (e.type) {
      case "model_change":
        modelChanges++;
        if (modelChanges > 1) {
          fail("Multi-model sessions are not supported (v1): found >1 model_change in the chain.");
        }
        provider = e.provider;
        modelId = e.modelId;
        break;
      case "thinking_level_change":
        thinkingLevel = e.thinkingLevel;
        break;
      case "compaction":
        fail("Compaction is not supported (v1): found a compaction entry in the chain.");
        break;
      case "branch_summary":
        fail("Branch summaries are not supported (v1): found a branch_summary entry in the chain.");
        break;
      case "custom":
      case "custom_message":
      case "session_info":
      case "label":
        warn(`Skipping ${e.type} entry ${e.id}.`);
        break;
      case "message": {
        const m = e.message;
        if (m.role === "user") {
          const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
          for (const b of content) {
            if (b.type === "image") {
              fail("Image content in user messages is not supported (v1).");
            }
            if (b.type === "text") userTexts.push(b.text);
          }
        } else if (m.role === "assistant") {
          api = api || m.api;
          for (const b of m.content) {
            if (b.type === "thinking") reasoning = true;
            if (b.type === "toolCall" && !ALLOWED_TOOLS.has(b.name)) {
              fail(
                `Tool "${b.name}" is outside the v1 allowlist {${[...ALLOWED_TOOLS].join(", ")}} ` +
                  `(toolCall ${b.id}).`,
              );
            }
          }
          responses.push(m);
        } else if (m.role === "toolResult") {
          toolResults[m.toolCallId] = {
            toolName: m.toolName,
            content: m.content,
            details: m.details,
            isError: m.isError,
          };
          resultIds.add(m.toolCallId);
        }
        break;
      }
      default:
        warn(`Skipping unrecognized entry type "${e.type}" (${e.id}).`);
    }
  }

  if (responses.length === 0) fail("Session chain has no assistant responses.");

  // A stopReason of error/aborted before the final response cannot be replayed.
  for (let i = 0; i < responses.length - 1; i++) {
    const sr = responses[i].stopReason;
    if (sr === "error" || sr === "aborted") {
      fail(`Assistant response #${i + 1} has stopReason "${sr}" mid-chain, which cannot be replayed.`);
    }
  }

  // Fall back to the recorded assistant provider/model if there was no
  // model_change entry.
  if (!provider || !modelId) {
    provider = provider || responses[0].provider;
    modelId = modelId || responses[0].model;
  }
  api = api || responses[0].api;

  // Truncation repair: drop trailing responses whose toolCalls lack results.
  let droppedTrailingSteps = 0;
  let droppedToolCalls = 0;
  while (responses.length > 1) {
    const last = responses[responses.length - 1];
    const callIds = last.content.filter((b) => b.type === "toolCall").map((b) => b.id);
    const hasUnresolved = callIds.some((id) => !resultIds.has(id));
    if (!hasUnresolved) break;
    responses.pop();
    droppedTrailingSteps++;
    for (const id of callIds) {
      droppedToolCalls++;
      resultIds.delete(id);
      delete toolResults[id];
    }
  }

  // Synthesize a final text step if the last kept response did not stop cleanly.
  let synthesizedFinal = false;
  if (responses[responses.length - 1].stopReason !== "stop") {
    responses.push({
      role: "assistant",
      content: [{ type: "text", text: finalText }],
      provider,
      model: modelId,
      api,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    });
    synthesizedFinal = true;
  }

  // Model catalog lookup for context window / max tokens.
  const catalog = await loadModelCatalog();
  let contextWindow = FALLBACK_CONTEXT_WINDOW;
  let maxTokens = FALLBACK_MAX_TOKENS;
  const entry = catalog?.[provider]?.[modelId];
  if (entry && typeof entry.contextWindow === "number") {
    contextWindow = entry.contextWindow;
    maxTokens = typeof entry.maxTokens === "number" ? entry.maxTokens : maxTokens;
  } else {
    warn(
      `Model "${provider}/${modelId}" not found in the pi catalog; ` +
        `falling back to contextWindow=${contextWindow}, maxTokens=${maxTokens}.`,
    );
  }

  // Expected assertions derived from the kept responses.
  const toolCalls = [];
  for (const r of responses) {
    for (const b of r.content) {
      if (b.type === "toolCall") {
        toolCalls.push({
          name: b.name,
          id: b.id,
          screenHint: screenHint(b.name, b.arguments, toolResults[b.id]),
        });
      }
    }
  }
  const finalAssistantText = responses[responses.length - 1].content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const turns = responses.length;

  let piVersion = "unknown";
  try {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "distribution.json"), "utf8"));
    piVersion = manifest.pi || piVersion;
  } catch {
    warn("Could not read distribution.json for piVersion.");
  }

  const fixture = {
    version: 1,
    meta: {
      name,
      sessionId: header.id,
      sessionFile: path.basename(sessionFile),
      recordedAt: header.timestamp,
      convertedAt: new Date().toISOString(),
      piVersion,
      cwd: header.cwd,
      provider,
      modelId,
      api,
      thinkingLevel,
      reasoning,
      contextWindow,
      maxTokens,
      synthesizedFinal,
      droppedTrailingSteps,
      droppedToolCalls,
    },
    userInputs: userTexts.length ? [{ text: userTexts.join("\n") }] : [],
    responses,
    toolResults,
    expected: {
      turns,
      toolCalls,
      finalAssistantText,
      screenContains: [],
    },
    perfBudgets: {
      startupToReadyMs: 15000,
      keystrokeEchoP95Ms: 200,
      submitToFirstRenderMs: 3000,
      totalRunMs: Math.max(30000, 10000 * turns),
      meanTurnMs: 8000,
      fullRedrawMax: 25,
      stdoutBytesMax: 3000000,
    },
  };

  const fixtureDir = path.join(outDir, name);
  const outFile = path.join(fixtureDir, "script.json");
  if (existsSync(outFile) && !opts.force) {
    fail(`Refusing to overwrite existing fixture ${outFile} without --force.`);
  }
  mkdirSync(fixtureDir, { recursive: true });
  const json = JSON.stringify(fixture, null, 2);
  writeFileSync(outFile, json + "\n");

  // Operator summary.
  const byName = {};
  for (const tc of toolCalls) byName[tc.name] = (byName[tc.name] || 0) + 1;
  console.log(`\n✔ Wrote ${outFile}`);
  console.log(`  turns (responses):   ${turns}`);
  console.log(`  user inputs:         ${fixture.userInputs.length}`);
  console.log(
    `  tool calls:          ${toolCalls.length} (${
      Object.entries(byName)
        .map(([n, c]) => `${n}×${c}`)
        .join(", ") || "none"
    })`,
  );
  console.log(`  tool results:        ${Object.keys(toolResults).length}`);
  console.log(`  dropped steps:       ${droppedTrailingSteps} (${droppedToolCalls} toolCalls)`);
  console.log(`  synthesized final:   ${synthesizedFinal}`);
  console.log(`  model:               ${provider}/${modelId} (${api}), thinking=${thinkingLevel}`);
  console.log(`  context/maxTokens:   ${contextWindow}/${maxTokens}`);
  console.log(`  output size:         ${Buffer.byteLength(json, "utf8")} bytes\n`);
}

main().catch((err) => fail(err?.stack || String(err)));
