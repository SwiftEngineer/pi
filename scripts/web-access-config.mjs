#!/usr/bin/env node
// Configure pi-web-access for headless operation.
//
// pi-web-access defaults to an interactive "summary-review" workflow that opens
// a browser curator on every web_search call and waits for manual approval.
// This distribution wants raw results with no browser takeover, so the
// installer forces `workflow: "none"` and `autoOpenBrowser: false`.
//
// Writes the same file the plugin reads: `~/.pi/web-search.json`, or
// `web-search.json` under `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME/pi` when set.
// All existing keys are preserved; only the two headless settings are forced.
//
// Flags:
//   --dry-run   print what would change without writing anything

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HEADLESS_SETTINGS = Object.freeze({
  workflow: "none",
  autoOpenBrowser: false,
});

export function webSearchConfigPath() {
  if (process.env.PI_CODING_AGENT_DIR) {
    return path.join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "pi", "web-search.json");
  }
  return path.join(os.homedir(), ".pi", "web-search.json");
}

export function configureWebAccess({ dryRun = false, log = console.log } = {}) {
  const file = webSearchConfigPath();
  const fileExisted = existsSync(file);
  let config = {};

  if (fileExisted) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("top-level value is not an object");
      }
      config = parsed;
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${file}.invalid-${stamp}`;
      log(`  ! ${file} is not valid JSON — moving it to ${backup} before writing a fresh config`);
      if (!dryRun) copyFileSync(file, backup);
      config = {};
    }
  }

  const isHeadless =
    config.workflow === HEADLESS_SETTINGS.workflow &&
    config.autoOpenBrowser === HEADLESS_SETTINGS.autoOpenBrowser;

  if (isHeadless) {
    log(`  = ${file} already configures pi-web-access headless; nothing to do`);
    return { file, changed: false };
  }

  const merged = { ...config, ...HEADLESS_SETTINGS };
  log(`→ Configuring pi-web-access headless at ${file} (workflow: "${merged.workflow}", autoOpenBrowser: ${merged.autoOpenBrowser})`);
  if (!dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }
  return { file, changed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureWebAccess({ dryRun: process.argv.includes("--dry-run") });
}
