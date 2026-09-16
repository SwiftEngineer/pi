#!/usr/bin/env node
// Stub child "pi" for scripts/subagents-harness.mjs (wired in via the
// SWIFT_PI_COMMAND override). Emulates the parts of `pi --mode json -p` that
// the subagents extension observes:
//   - create-or-open session semantics: writes <timestamp>_<sessionId>.jsonl
//     into the subagent session dir on first run (lazy file creation), and
//     prints the "creating a new session" stderr warning only when the file
//     was missing;
//   - `--mode json` events on stdout (assistant message_start/message_end
//     with usage, model, stopReason);
//   - assignment markers: "SLOW" stays alive 30 s (for interrupt tests),
//     "NOSESSION"/"FAIL" exit 3 without creating a session file;
//   - appends every invocation's argv to a log the harness asserts against.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const idIdx = argv.indexOf("--session-id");
const id = idIdx >= 0 ? argv[idIdx + 1] : "unknown";
const assignment = argv[argv.length - 1] ?? "";

const dir = path.join(os.tmpdir(), "swift-pi-subagent-sessions");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
const existed = fs.existsSync(file);
fs.appendFileSync(
  path.join(os.tmpdir(), "swift-pi-subagent-argv.log"),
  `${JSON.stringify({ id, pid: process.pid, argv })}\n`,
);

if (assignment.includes("NOSESSION") || assignment.includes("FAIL")) process.exit(3);

// Emulates the race where the durable session disappears between the send
// tool's existence check and the child's own lookup (D2/D8 belt-and-braces).
if (assignment.includes("FORCEWARNING")) {
  process.stderr.write(`Warning: No project session found with id '${id}'; creating a new session with that id.\n`);
}

if (!existed) {
  process.stderr.write(`Warning: No project session found with id '${id}'; creating a new session with that id.\n`);
  fs.writeFileSync(file, `${JSON.stringify({ stub: "session-header", id })}\n`);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const run = async () => {
  if (assignment.includes("SLOW")) {
    // A pending promise alone does not keep the event loop alive; park on a
    // long interval until the parent kills us.
    setInterval(() => {}, 3_600_000);
    await new Promise(() => {});
  }
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `STUB RESULT: ${assignment.slice(0, 60)}` }],
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
      model: "prov/m1",
      stopReason: "stop",
    },
  });
  process.exit(0);
};
void run();
