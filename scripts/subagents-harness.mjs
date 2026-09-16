// Headless harness for the subagents extension (addressable-subagents task 5.2).
//
// Drives extensions/subagents/index.ts in "TUI" mode against a stub child pi
// (scripts/test-stub-subagent-pi.mjs, wired via SWIFT_PI_COMMAND) and asserts
// the v2a behavior end to end: durable-session spawn flags, pid in the
// dispatch entry, id in delivered headers, per-engagement delivery +
// persistence, rejection paths, kill-and-redirect with suppressed aborted
// delivery, missing-session failure, orphan-pid refusal, resume-without-model,
// and latest-entry-wins restore folding.
//
// Usage: node scripts/subagents-harness.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const SESSION_DIR = path.join(os.tmpdir(), "swift-pi-subagent-sessions");
const ARGV_LOG = path.join(os.tmpdir(), "swift-pi-subagent-argv.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reset environment and state.
delete process.env.SWIFT_PI_SUBAGENT;
process.env.SWIFT_PI_COMMAND = path.resolve(import.meta.dirname, "test-stub-subagent-pi.mjs");
fs.rmSync(SESSION_DIR, { recursive: true, force: true });
fs.rmSync(ARGV_LOG, { force: true });

// Load the extension the same way smoke.mjs does.
const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import(path.resolve(import.meta.dirname, "../extensions/subagents/index.ts"));

// Fake ExtensionAPI: capture tools, handlers, deliveries, session entries.
const tools = new Map();
const handlers = [];
const entries = [];
const deliveries = [];
let widgets = [];
const pi = {
  registerTool: (t) => tools.set(t.name, t),
  on: (event, handler) => handlers.push({ event, handler }),
  registerMessageRenderer: () => {},
  registerShortcut: () => {},
  sendMessage: (message, options) => deliveries.push({ message, options }),
  appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
};

const ctx = {
  cwd: process.cwd(),
  mode: "tui",
  sessionManager: { getEntries: () => entries },
  ui: {
    setWidget: (key, lines, options) => widgets.push({ key, lines, options }),
    notify: () => {},
    theme: {},
  },
  modelRegistry: {
    find: () => ({ provider: "prov", id: "m1" }),
    getAvailable: () => [{ provider: "prov", id: "m1" }],
  },
};

mod.default(pi);
const dispatch = tools.get("subagents");
const send = tools.get("subagents_send");
if (!dispatch || !send) throw new Error("harness setup failed: tools not registered");

const sessionStart = () => {
  for (const h of handlers) if (h.event === "session_start") h.handler({}, ctx);
};
const registry = mod.__registry;
let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ok: ${label}`);
};
async function waitFor(predicate, label, timeout = 8000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(25);
  }
}
const argvFor = (id) =>
  fs
    .readFileSync(ARGV_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.id === id);
const completionsFor = (id) => entries.filter((e) => e.customType === "subagent_completion" && e.data.id === id);

console.log("1. dispatch spawns with durable-session flags and delivers with id-bearing header");
sessionStart();
const ack1 = await dispatch.execute(
  "t1",
  { agent: "task", tasks: [{ id: "t1", description: "Work A", assignment: "Do A" }], model: "prov/m1" },
  undefined,
  undefined,
  ctx,
);
const first = [...registry.values()][0];
await waitFor(() => deliveries.length >= 1, "first delivery");
if (first.status !== "done") throw new Error(`expected done, got ${first.status}`);
if (!deliveries[0].message.content.startsWith(`[subagent task ${first.id} — done]`)) {
  throw new Error(`header missing id: ${deliveries[0].message.content.slice(0, 60)}`);
}
const spawn1 = argvFor(first.id)[0];
if (!spawn1.argv.includes("--session-dir") || !spawn1.argv.includes("--session-id")) {
  throw new Error(`spawn1 missing durable-session flags: ${spawn1.argv.join(" ")}`);
}
if (spawn1.argv.includes("--no-session")) throw new Error("spawn1 still passes --no-session");
if (!spawn1.argv.includes("--model")) throw new Error("spawn1 missing dispatch-time --model");
const dispatchEntry = entries.find((e) => e.customType === "subagent_dispatch");
if (dispatchEntry.data.pid !== first.pid || typeof first.pid !== "number") {
  throw new Error(`dispatch entry pid not recorded (entry=${dispatchEntry.data.pid}, record=${first.pid})`);
}
ok("durable flags, model, pid, header");
const transcriptBefore = first.messages.length;
console.log("2. send re-engages the done agent: same session id, no --model, second completion + delivery");
const ack2 = await send.execute("t2", { id: first.id, message: "Fix the tests." }, undefined, undefined, ctx);
if (!ack2.content[0].text.includes("re-engaged")) throw new Error(`unexpected ack: ${ack2.content[0].text}`);
await waitFor(() => deliveries.length >= 2, "second delivery");
const spawn2 = argvFor(first.id)[1];
if (!spawn2) throw new Error("no second spawn recorded");
if (spawn2.argv.includes("--model")) throw new Error("resume spawn passed --model (D10 violated)");
if (spawn2.argv.includes("--session-id") === false || spawn2.argv.includes(first.id) === false) {
  throw new Error(`resume spawn lost the session id: ${spawn2.argv.join(" ")}`);
}
if (completionsFor(first.id).length !== 2) throw new Error(`expected 2 completions, got ${completionsFor(first.id).length}`);
if (first.messages.length <= transcriptBefore) {
  throw new Error(`transcript did not grow: ${transcriptBefore} -> ${first.messages.length}`);
}
if (deliveries[1].message.content.includes("Fix the tests") === false) {
  // The resume child saw the message; its result echoes the assignment prefix.
  if (!deliveries[1].message.content.includes("Fix")) throw new Error(`resume result missing prompt echo: ${deliveries[1].message.content.slice(0, 80)}`);
}
console.log("2b. a resume child reporting 'creating a new session' fails loudly (D2/D8 belt-and-braces)");
const before2b = deliveries.length;
await send.execute("t2b", { id: first.id, message: "Continue FORCEWARNING." }, undefined, undefined, ctx);
await waitFor(() => deliveries.length >= before2b + 1, "fatal-warning delivery");
const fatal = deliveries[before2b];
if (!fatal.message.content.includes(`[subagent task ${first.id} — failed]`)) {
  throw new Error(`fatal-warning engagement not failed: ${fatal.message.content.slice(0, 80)}`);
}
if (!fatal.message.content.includes("Durable session missing")) {
  throw new Error(`fatal warning not surfaced: ${fatal.message.content.slice(0, 120)}`);
}
ok("resume-warning fatal classification");

ok("re-engagement, model omission, per-engagement persistence");

console.log("3. send to a running agent without interrupt is rejected; with interrupt it kills + redirects");
const ack3 = await dispatch.execute(
  "t3",
  { agent: "task", tasks: [{ id: "t3", description: "Slow B", assignment: "Work SLOW" }] },
  undefined,
  undefined,
  ctx,
);
const slow = [...registry.values()].find((r) => r.id !== first.id);
await waitFor(() => fs.existsSync(path.join(SESSION_DIR, `2026-01-01T00-00-00-000Z_${slow.id}.jsonl`)), "slow child session file");
await waitFor(() => slow.child !== undefined, "slow child spawn");
let rejected = null;
try {
  await send.execute("t4", { id: slow.id, message: "nope" }, undefined, undefined, ctx);
} catch (error) {
  rejected = error;
}
if (!rejected || !String(rejected.message).includes("still running")) {
  throw new Error(`expected still-running rejection, got: ${rejected?.message}`);
}
if (completionsFor(slow.id).length !== 0) throw new Error("rejected send must not mutate the record");
const before = deliveries.length;
await send.execute("t5", { id: slow.id, message: "Pivot now.", interrupt: true }, undefined, undefined, ctx);
await waitFor(() => deliveries.length >= before + 1, "redirect delivery");
const redirect = deliveries[before];
if (!redirect.message.content.startsWith(`[subagent task ${slow.id} — done]`)) {
  throw new Error(`redirect delivery header unexpected: ${redirect.message.content.slice(0, 60)}`);
}
const slowCompletions = completionsFor(slow.id);
if (slowCompletions.length !== 2) throw new Error(`expected killed+redirect completions, got ${slowCompletions.length}`);
if (slowCompletions[0].data.status !== "aborted") throw new Error(`killed engagement should persist aborted, got ${slowCompletions[0].data.status}`);
if (deliveries.some((d) => d.message.content.includes("— aborted]"))) {
  throw new Error("D11 violated: an aborted diagnostic was delivered for a send-initiated kill");
}
ok("rejection, kill-and-redirect, suppressed aborted delivery");

console.log("4. missing durable session fails the send explicitly");
const ack4 = await dispatch.execute(
  "t6",
  { agent: "task", tasks: [{ id: "t6", description: "No session C", assignment: "Work NOSESSION" }] },
  undefined,
  undefined,
  ctx,
);
const nosess = [...registry.values()].find((r) => r.assignment.includes("NOSESSION"));
await waitFor(() => nosess.finalized, "NOSESSION engagement terminal");
let missing = null;
try {
  await send.execute("t7", { id: nosess.id, message: "try again" }, undefined, undefined, ctx);
} catch (error) {
  missing = error;
}
if (!missing || !String(missing.message).includes("durable session missing")) {
  throw new Error(`expected durable-session-missing failure, got: ${missing?.message}`);
}
ok("missing-session failure is explicit");

console.log("5. unknown id fails with known ids");
let unknown = null;
try {
  await send.execute("t8", { id: "sa-nope", message: "hi" }, undefined, undefined, ctx);
} catch (error) {
  unknown = error;
}
if (!unknown || !String(unknown.message).includes("Unknown subagent id")) {
  throw new Error(`expected unknown-id failure, got: ${unknown?.message}`);
}
ok("unknown id rejected");

console.log("6. restore folds latest-entry-wins and probes the recorded pid");
const lostId = "sa-restore-1";
entries.push(
  { type: "custom", customType: "subagent_dispatch", data: { id: lostId, type: "task", task: "Restored D", assignment: "assignment", spawnedAt: 1, pid: 999999 } },
  {
    type: "custom",
    customType: "subagent_completion",
    data: { id: lostId, status: "done", messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 }, pid: process.pid, model: undefined, stopReason: "stop", errorMessage: undefined, stderr: "", lost: false },
  },
  {
    type: "custom",
    customType: "subagent_completion",
    data: { id: lostId, status: "done", messages: [], usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, cost: 9, contextTokens: 9, turns: 2 }, pid: process.pid, model: undefined, stopReason: "stop", errorMessage: undefined, stderr: "", lost: false },
  },
);
widgets = [];
sessionStart();
const restored = registry.get(lostId);
if (!restored) throw new Error("restored record missing");
if (restored.usage.turns !== 2 || restored.usage.input !== 9) throw new Error("restore did not fold latest-entry-wins");
if (restored.pid !== process.pid) throw new Error(`restore kept stale pid: ${restored.pid}`);
let orphan = null;
try {
  await send.execute("t9", { id: lostId, message: "resume?" }, undefined, undefined, ctx);
} catch (error) {
  orphan = error;
}
if (!orphan || !String(orphan.message).includes("orphaned") && !String(orphan.message).includes("still be running")) {
  throw new Error(`expected orphan-pid refusal, got: ${orphan?.message}`);
}
ok("latest-entry-wins fold + live-pid refusal");

console.log("6b. a second send racing the pre-spawn window is rejected (no dropped message)");
await dispatch.execute(
  "t12",
  { agent: "task", tasks: [{ id: "t12", description: "Racer F", assignment: "Do F" }] },
  undefined,
  undefined,
  ctx,
);
const racer = [...registry.values()].find((r) => r.task === "Racer F");
await waitFor(() => racer.status === "done", "racer done");
const p1 = send.execute("t13", { id: racer.id, message: "Follow-up 1." }, undefined, undefined, ctx);
let raceRejected = null;
try {
  // Same tick as p1: record.run is already set synchronously, record.child is not —
  // the pre-spawn window that used to swallow the second message (review finding 1).
  await send.execute("t14", { id: racer.id, message: "Follow-up 2." }, undefined, undefined, ctx);
} catch (error) {
  raceRejected = error;
}
if (!raceRejected || !String(raceRejected.message).includes("still running")) {
  throw new Error(`expected pre-spawn-window rejection, got: ${raceRejected?.message}`);
}
await p1;
await waitFor(() => completionsFor(racer.id).length === 2, "racer second completion");
const raceSpawn = argvFor(racer.id).at(-1);
if (raceSpawn.argv.at(-1) !== "Follow-up 1.") {
  throw new Error(`first engagement's prompt was clobbered: ${raceSpawn.argv.at(-1)}`);
}
ok("pre-spawn-window double send rejected, prompt unclobbered");

console.log("6c. interrupt racing the pre-spawn window aborts the pending engagement and redirects");
await dispatch.execute(
  "t15",
  { agent: "task", tasks: [{ id: "t15", description: "Racer G", assignment: "Do G" }] },
  undefined,
  undefined,
  ctx,
);
const racerG = [...registry.values()].find((r) => r.task === "Racer G");
await waitFor(() => racerG.status === "done", "racer G done");
const p2 = send.execute("t16", { id: racerG.id, message: "Stale prompt." }, undefined, undefined, ctx);
await send.execute("t17", { id: racerG.id, message: "Pivot 2.", interrupt: true }, undefined, undefined, ctx);
await p2;
await waitFor(() => completionsFor(racerG.id).length === 3, "pending+redirect completions");
if (completionsFor(racerG.id)[1].data.status !== "aborted") {
  throw new Error(`pending engagement should be aborted, got ${completionsFor(racerG.id)[1].data.status}`);
}
if (completionsFor(racerG.id)[2].data.status !== "done") {
  throw new Error(`redirect engagement should be done, got ${completionsFor(racerG.id)[2].data.status}`);
}
if (deliveries.some((d) => d.message.content.includes("— aborted]"))) {
  throw new Error("D11 violated: aborted diagnostic delivered for pre-spawn interrupt");
}
if (argvFor(racerG.id).at(-1).argv.at(-1) !== "Pivot 2.") {
  throw new Error(`redirect prompt lost: ${argvFor(racerG.id).at(-1).argv.at(-1)}`);
}
ok("pre-spawn interrupt kills pending engagement and redirects");

console.log("6d. restored-lost record: engagement-entry pid + message restored, send succeeds");
const { spawn: nodeSpawn } = await import("node:child_process");
const deadPid = await new Promise((resolve) => {
  const c = nodeSpawn(process.execPath, ["-e", "process.exit(0)"]);
  c.on("close", () => resolve(c.pid));
});
const lostId2 = "sa-restore-2";
entries.push(
  { type: "custom", customType: "subagent_dispatch", data: { id: lostId2, type: "task", task: "Lost E", assignment: "original assignment", spawnedAt: 2, pid: deadPid } },
  { type: "custom", customType: "subagent_engagement", data: { id: lostId2, message: "corrective prompt", pid: deadPid, at: 3 } },
);
fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.writeFileSync(path.join(SESSION_DIR, `2026-01-01T00-00-00-000Z_${lostId2}.jsonl`), "{}");
sessionStart();
const lost2 = registry.get(lostId2);
if (!lost2) throw new Error("restored-lost record missing");
if (!lost2.lost || lost2.status !== "aborted") throw new Error(`expected lost+aborted, got lost=${lost2.lost} status=${lost2.status}`);
if (lost2.pid !== deadPid) throw new Error(`engagement-entry pid not restored: ${lost2.pid} vs ${deadPid}`);
if (lost2.assignment !== "corrective prompt") throw new Error(`engagement message not restored: ${lost2.assignment}`);
const lost2Before = deliveries.length;
await send.execute("t18", { id: lostId2, message: "continue lost" }, undefined, undefined, ctx);
await waitFor(() => deliveries.length >= lost2Before + 1, "lost-record resume delivery");
if (!deliveries.at(-1).message.content.includes(`[subagent task ${lostId2} — done]`)) {
  throw new Error(`lost-record resume not delivered: ${deliveries.at(-1).message.content.slice(0, 60)}`);
}
ok("restored-lost record re-engages (dead-pid D9c success path)");

console.log("6e. a restored record whose resume once recreated a blank session refuses further sends");
const poisonedId = "sa-restore-3";
entries.push(
  { type: "custom", customType: "subagent_dispatch", data: { id: poisonedId, type: "task", task: "Poisoned H", assignment: "assignment", spawnedAt: 4, pid: deadPid } },
  {
    type: "custom",
    customType: "subagent_completion",
    data: { id: poisonedId, status: "failed", messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, pid: deadPid, model: undefined, stopReason: undefined, errorMessage: "Durable session missing", stderr: "", lost: false, resumeSessionMissing: true },
  },
);
fs.writeFileSync(path.join(SESSION_DIR, `2026-01-01T00-00-00-000Z_${poisonedId}.jsonl`), "{}");
sessionStart();
const poisoned = registry.get(poisonedId);
if (!poisoned?.resumeSessionMissing) throw new Error("resumeSessionMissing flag not restored");
let poisonedErr = null;
try {
  await send.execute("t19", { id: poisonedId, message: "try again" }, undefined, undefined, ctx);
} catch (error) {
  poisonedErr = error;
}
if (!poisonedErr || !String(poisonedErr.message).includes("recreated a blank")) {
  throw new Error(`expected blank-session refusal despite existing file, got: ${poisonedErr?.message}`);
}
ok("resumeSessionMissing survives restore and refuses sends");

console.log("7. non-TUI mode: dispatch and send run inline and return results as the tool result");
const blockingCtx = { ...ctx, mode: "print" };
const before7 = deliveries.length;
const blockAck = await dispatch.execute(
  "t10",
  { agent: "task", tasks: [{ id: "t10", description: "Inline E", assignment: "Do E" }] },
  undefined,
  undefined,
  blockingCtx,
);
if (!blockAck.content[0].text.includes("### Inline E — completed")) {
  throw new Error(`blocking dispatch did not return aggregated result: ${blockAck.content[0].text.slice(0, 80)}`);
}
if (deliveries.length !== before7) throw new Error("blocking mode must not deliver follow-ups");
const inline = [...registry.values()].find((r) => r.assignment === "Do E");
const sendResult = await send.execute("t11", { id: inline.id, message: "Once more E." }, undefined, undefined, blockingCtx);
if (!sendResult.content[0].text.includes("STUB RESULT: Once more E")) {
  throw new Error(`blocking send did not return inline result: ${sendResult.content[0].text.slice(0, 80)}`);
}
if (deliveries.length !== before7) throw new Error("blocking send must not deliver follow-ups");
ok("inline dispatch + inline send outside the TUI");

console.log(`\nharness passed: ${passed} groups, registry=${registry.size} records`);
