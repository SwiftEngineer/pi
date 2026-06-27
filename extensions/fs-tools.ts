import {
  createFindToolDefinition,
  createLsToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

// Directory listing (ls) and filename/glob lookup (find), reused verbatim from
// the pinned pi core tool factories so semantics, truncation notices, and TUI
// rendering match the built-in tools. The bash policy points shell `ls`/`find`
// at these tools, so they must always be registered alongside it.
//
// The factories close over the cwd they are created with, but only `execute`
// resolves paths against it. Re-creating the definition per call with ctx.cwd
// keeps relative paths correct across /cd, matching how the rest of this
// harness (search, ast tools) reads ctx.cwd at execution time. renderCall/
// renderResult are display-only and already use the live context cwd.

type Factory<TParams extends TSchema, TDetails> = (cwd: string) => ToolDefinition<TParams, TDetails>;

function rebindToSessionCwd<TParams extends TSchema, TDetails>(create: Factory<TParams, TDetails>): ToolDefinition<TParams, TDetails> {
  const template = create(process.cwd());
  return {
    ...template,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return create(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(rebindToSessionCwd(createLsToolDefinition));
  pi.registerTool(rebindToSessionCwd(createFindToolDefinition));
}
