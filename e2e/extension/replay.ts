// Hermetic replay extension for the Pi e2e harness (plan §3).
//
// Driven entirely by a "script" JSON produced by
// e2e/tools/session-to-fixture.mjs (path in PI_E2E_SCRIPT), it does two things:
//
//   1. Registers a faux LLM provider under the RECORDED provider name (e.g.
//      "zai"), pre-loaded with the recorded assistant messages. Registering the
//      recorded name replaces that provider's built-in models, so
//      `--model <provider>/<id>` binds to faux and the persisted session's
//      provider/model/api match the recording exactly. No real network request
//      is ever made.
//   2. Stubs tool execution: recorded results are injected instead of the real
//      tools running. Inputs are NEUTERED in place (not blocked) — a blocked
//      call never fires `tool_result`, and `tool_result` is exactly where we
//      inject the recorded output. Neutering keeps execution instant and
//      side-effect-free while still letting the result hook run.
//
// Load/parse errors throw on purpose: they surface as extension diagnostics so
// the run fails fast and visibly instead of silently falling back to a real
// provider.

import { readFileSync } from "node:fs";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

// Never-match pattern for neutered search/grep/find/ast_grep calls.
const NOOP_PATTERN = "e2e-noop-zz9qq";

interface ScriptMeta {
  provider: string;
  modelId: string;
  api: Api;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

interface RecordedToolResult {
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
}

interface Script {
  meta: ScriptMeta;
  responses: AssistantMessage[];
  toolResults: Record<string, RecordedToolResult>;
}

function loadScript(): Script {
  const scriptPath = process.env.PI_E2E_SCRIPT;
  if (!scriptPath) {
    throw new Error("replay.ts: PI_E2E_SCRIPT is not set; cannot load the e2e replay script.");
  }
  let raw: string;
  try {
    raw = readFileSync(scriptPath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`replay.ts: could not read PI_E2E_SCRIPT at ${scriptPath}: ${reason}`);
  }
  try {
    return JSON.parse(raw) as Script;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`replay.ts: could not parse PI_E2E_SCRIPT JSON at ${scriptPath}: ${reason}`);
  }
}

// A safe, instant no-op input for a tool with a recorded result. Returns
// undefined for tools we do not know how to neuter (input is left untouched).
function neuteredInput(toolName: string): Record<string, unknown> | undefined {
  switch (toolName) {
    case "bash":
      return { command: "true" };
    case "read":
      // Read the script itself: guaranteed to exist and be small.
      return { path: process.env.PI_E2E_SCRIPT };
    case "ls":
      return { path: "." };
    case "search":
    case "grep":
    case "find":
      return { pattern: NOOP_PATTERN };
    case "ast_grep":
      return { pat: NOOP_PATTERN, paths: ["."] };
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const script = loadScript();
  const meta = script.meta;

  // Faux core pre-loaded with the recorded assistant messages. It streams each
  // recorded AssistantMessage as proper delta events and preserves recorded
  // toolCall ids, so recorded results key back by id.
  const faux = createFauxCore({
    provider: meta.provider,
    api: meta.api,
    models: [
      {
        id: meta.modelId,
        reasoning: meta.reasoning,
        contextWindow: meta.contextWindow,
        maxTokens: meta.maxTokens,
      },
    ],
  });
  faux.setResponses(script.responses);

  // Register under the RECORDED provider name so `--model <provider>/<id>`
  // resolves to faux and the persisted provider/model/api match the recording.
  // The dummy baseUrl/apiKey satisfy pi's provider validation without ever
  // being used — streamSimple short-circuits any real request.
  //
  // pi >= 0.87.0 flushes load-time registrations config-first, then native:
  // registerNativeProvider deletes any same-id config registration. The
  // harness's zai-compat.ts (a package extension that loads after this CLI
  // extension) registers a native "zai" provider, so a load-time
  // registration here would be clobbered and the replay would die on the
  // real provider's auth ("No API key found for zai"). Registering from
  // session_start — which fires after every load-time registration has been
  // applied — takes the immediate path and lands last, so the faux provider
  // deterministically serves the recorded provider for the whole session.
  pi.on("session_start", () => {
    pi.registerProvider(meta.provider, {
      name: "E2E Replay",
      api: meta.api,
      baseUrl: "http://127.0.0.1:9/e2e-replay",
      apiKey: "e2e-dummy-key",
      streamSimple: faux.streamSimple,
      models: [
        {
          id: meta.modelId,
          name: `${meta.modelId} (replay)`,
          reasoning: meta.reasoning,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: meta.contextWindow,
          maxTokens: meta.maxTokens,
        },
      ],
    });
  });

  // Tool stubbing. Skipped entirely when PI_E2E_LIVE_TOOLS=1 (real tools run).
  if (process.env.PI_E2E_LIVE_TOOLS === "1") return;

  // Before a tool runs: if we have a recorded result for this call, neuter its
  // input in place so the real tool executes a harmless no-op. We never block —
  // a blocked call skips tool_result, and tool_result is where we inject the
  // recorded output. The TUI still renders the recorded args (from the
  // assistant message), not these neutered ones.
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (!script.toolResults[event.toolCallId]) return;
    const replacement = neuteredInput(event.toolName);
    if (!replacement) return;
    const input = event.input as Record<string, unknown>;
    for (const key of Object.keys(input)) delete input[key];
    Object.assign(input, replacement);
  });

  // After the neutered tool runs: replace its result with the recorded content,
  // details, and error flag. Keyed by toolCallId (faux preserves ids).
  pi.on("tool_result", (event: ToolResultEvent) => {
    const rec = script.toolResults[event.toolCallId];
    if (!rec) return;
    return { content: rec.content, details: rec.details, isError: rec.isError };
  });
}
