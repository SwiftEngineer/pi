// Load a replayed Pi session and diff it against the fixture "script" (plan §4).
//
// Plain ESM, consumed by the runner/test. The replay is hermetic and linear
// (no branching, compaction, or model changes), so message entries in file
// order equal chronological order — no parentId walk is needed here.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";

// Find the single *.jsonl session file under sessionsDir. Replay writes exactly
// one session, either directly in sessionsDir or one level down (a cwd-encoded
// subdir). Returns { sessionFile, entries }; throws unless exactly one exists.
export function loadReplaySession(sessionsDir) {
  const found = [];
  const scan = (dir) => {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) found.push(path.join(dir, ent.name));
    }
  };

  scan(sessionsDir);
  let subdirs;
  try {
    subdirs = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    throw new Error(`session-diff: sessions directory not found: ${sessionsDir}`);
  }
  for (const d of subdirs) {
    if (d.isDirectory()) scan(path.join(sessionsDir, d.name));
  }

  if (found.length === 0) {
    throw new Error(`session-diff: no *.jsonl session found under ${sessionsDir}`);
  }
  if (found.length > 1) {
    throw new Error(
      `session-diff: expected exactly one session under ${sessionsDir}, found ${found.length}:\n` +
        found.map((f) => `  - ${f}`).join("\n"),
    );
  }

  const entries = parseSessionEntries(readFileSync(found[0], "utf8"));
  migrateSessionEntries(entries);
  return { sessionFile: found[0], entries };
}

// Concatenate the text of a message content (string or block array).
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

// Order-independent structural equality (used for toolCall arguments and bash
// details).
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

// Truncate long values so mismatch messages stay readable.
function clip(value, max = 300) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

// Compare one assistant message's content blocks against the recorded content.
// Ignores thinkingSignature/textSignature (compares .text/.thinking only).
function diffContent(index, got, want, mismatches) {
  if (got.length !== want.length) {
    mismatches.push(
      `assistant[${index}] content block count: session ${got.length} vs script ${want.length} ` +
        `(session types [${got.map((b) => b.type).join(", ")}], script types [${want.map((b) => b.type).join(", ")}])`,
    );
  }
  const n = Math.min(got.length, want.length);
  for (let j = 0; j < n; j++) {
    const g = got[j];
    const w = want[j];
    if (g.type !== w.type) {
      mismatches.push(`assistant[${index}].content[${j}] type: session ${g.type} vs script ${w.type}`);
      continue;
    }
    if (g.type === "text") {
      if ((g.text ?? "") !== (w.text ?? "")) {
        mismatches.push(
          `assistant[${index}].content[${j}] text mismatch:\n  session: ${JSON.stringify(clip(g.text))}\n  script:  ${JSON.stringify(clip(w.text))}`,
        );
      }
    } else if (g.type === "thinking") {
      if ((g.thinking ?? "") !== (w.thinking ?? "")) {
        mismatches.push(
          `assistant[${index}].content[${j}] thinking mismatch:\n  session: ${JSON.stringify(clip(g.thinking))}\n  script:  ${JSON.stringify(clip(w.thinking))}`,
        );
      }
    } else if (g.type === "toolCall") {
      if (g.id !== w.id) {
        mismatches.push(`assistant[${index}].content[${j}] toolCall id: session ${g.id} vs script ${w.id}`);
      }
      if (g.name !== w.name) {
        mismatches.push(`assistant[${index}].content[${j}] toolCall name: session ${g.name} vs script ${w.name}`);
      }
      if (!deepEqual(g.arguments, w.arguments)) {
        mismatches.push(
          `assistant[${index}].content[${j}] toolCall arguments mismatch:\n  session: ${JSON.stringify(g.arguments)}\n  script:  ${JSON.stringify(w.arguments)}`,
        );
      }
    }
  }
}

// Diff a replayed session (parsed entries) against the fixture script.
// Returns { mismatches, warnings }: an empty mismatches array means pass.
// details differences are non-fatal (warnings), per plan §4.
export function diffAgainstScript(entries, script) {
  const mismatches = [];
  const warnings = [];

  const messages = entries.filter((e) => e && e.type === "message").map((e) => e.message);
  const assistants = messages.filter((m) => m.role === "assistant");
  const users = messages.filter((m) => m.role === "user");
  const toolResults = messages.filter((m) => m.role === "toolResult");

  // ---- user messages: count + text equality ----
  const scriptInputs = script.userInputs ?? [];
  if (users.length !== scriptInputs.length) {
    mismatches.push(`user message count: session ${users.length} vs script ${scriptInputs.length}`);
  }
  for (let i = 0; i < Math.min(users.length, scriptInputs.length); i++) {
    const got = messageText(users[i].content);
    const want = scriptInputs[i].text ?? "";
    if (got !== want) {
      mismatches.push(
        `user[${i}] text mismatch:\n  session: ${JSON.stringify(clip(got))}\n  script:  ${JSON.stringify(clip(want))}`,
      );
    }
  }

  // ---- assistant messages: count, stopReason, provider/model/api, content ----
  const responses = script.responses ?? [];
  if (assistants.length !== responses.length) {
    mismatches.push(`assistant message count: session ${assistants.length} vs script ${responses.length}`);
  }
  for (let i = 0; i < Math.min(assistants.length, responses.length); i++) {
    const got = assistants[i];
    const want = responses[i];
    if (got.stopReason !== want.stopReason) {
      mismatches.push(
        `assistant[${i}] stopReason: session ${JSON.stringify(got.stopReason)} vs script ${JSON.stringify(want.stopReason)}`,
      );
    }
    if (got.provider !== script.meta.provider) {
      mismatches.push(`assistant[${i}] provider: session ${JSON.stringify(got.provider)} vs meta ${JSON.stringify(script.meta.provider)}`);
    }
    if (got.model !== script.meta.modelId) {
      mismatches.push(`assistant[${i}] model: session ${JSON.stringify(got.model)} vs meta ${JSON.stringify(script.meta.modelId)}`);
    }
    if (got.api !== script.meta.api) {
      mismatches.push(`assistant[${i}] api: session ${JSON.stringify(got.api)} vs meta ${JSON.stringify(script.meta.api)}`);
    }
    diffContent(i, got.content ?? [], want.content ?? [], mismatches);
  }

  // ---- tool results: by id — presence, toolName, isError, text content ----
  const recorded = script.toolResults ?? {};
  const sessionById = new Map();
  for (const m of toolResults) sessionById.set(m.toolCallId, m);
  for (const [id, rec] of Object.entries(recorded)) {
    const got = sessionById.get(id);
    if (!got) {
      mismatches.push(`toolResult ${id} (${rec.toolName}): missing from session`);
      continue;
    }
    if (got.toolName !== rec.toolName) {
      mismatches.push(`toolResult ${id} toolName: session ${JSON.stringify(got.toolName)} vs script ${JSON.stringify(rec.toolName)}`);
    }
    if (Boolean(got.isError) !== Boolean(rec.isError)) {
      mismatches.push(`toolResult ${id} isError: session ${got.isError} vs script ${rec.isError}`);
    }
    const gotText = messageText(got.content);
    const wantText = messageText(rec.content);
    if (gotText !== wantText) {
      mismatches.push(
        `toolResult ${id} content mismatch:\n  session: ${JSON.stringify(clip(gotText))}\n  script:  ${JSON.stringify(clip(wantText))}`,
      );
    }
    // details are compared only for bash and only when both sides carry it;
    // reported as a non-fatal warning (executors may rewrite details).
    if (rec.toolName === "bash" && got.details != null && rec.details != null) {
      if (!deepEqual(got.details, rec.details)) {
        warnings.push(
          `WARNING toolResult ${id} bash details differ:\n  session: ${JSON.stringify(clip(JSON.stringify(got.details)))}\n  script:  ${JSON.stringify(clip(JSON.stringify(rec.details)))}`,
        );
      }
    }
  }

  return { mismatches, warnings };
}
