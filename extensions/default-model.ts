import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Pi reads defaultProvider/defaultModel from the agent settings.json only at
// startup, and interactive model switching never updates them (setModel only
// persists when explicitly asked with { persist: true }, and the interactive
// mode never passes it). Result: every new session silently reverts to
// whatever the file last had (e.g. glm-5.2) no matter what the user picked
// last. This extension makes the last explicitly chosen model the default by
// writing those two fields back on model_select.
//
// The write is safe against clobbering pi's own settings writes: the
// SettingsManager re-reads the file on every save and merges only the fields
// it itself marked modified, so our update survives later pi saves (and vice
// versa), as long as pi never marks defaultProvider/defaultModel modified —
// which it doesn't, since it never persists them on its own.
//
// Session restores ("source: restore", resuming an old session) are
// deliberately not persisted: opening an old session must not silently
// redefine the default. Set or cycle a model explicitly to make it stick.

function persistDefaultModel(provider: string, modelId: string, ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): void {
  const settingsPath = path.join(getAgentDir(), "settings.json");
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Malformed JSON or unreadable file: report instead of overwriting it.
      ctx.ui.notify(`Could not persist default model: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return;
    }
    // Missing file: pi's SettingsManager recreates it on its next save, so a
    // fresh object with just the default-model fields is consistent.
  }
  data.defaultProvider = provider;
  data.defaultModel = modelId;
  try {
    writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (error) {
    ctx.ui.notify(`Could not persist default model: ${error instanceof Error ? error.message : String(error)}`, "warning");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("model_select", (event, ctx) => {
    if (event.source === "restore") return;
    persistDefaultModel(event.model.provider, event.model.id, ctx);
  });
}
