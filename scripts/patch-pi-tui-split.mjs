import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Patches Pi's compiled TUI render loop (pi-tui/dist/tui.js) to add a single
 * frame hook. When `globalThis.__piSplitFrame` is set (by the subagent-view
 * extension), the hook lets it replace the rendered frame with a true reserved
 * split-pane. The patch is idempotent and fully reversible (`--revert`).
 */

const PATCH_MARKER = "PI_SUBAGENT_SPLIT_PATCH";
const HOOK_START = "/* PI_SUBAGENT_SPLIT_PATCH:hook:start */";
const HOOK_END = "/* PI_SUBAGENT_SPLIT_PATCH:hook:end */";
const FLAG_LINE = "globalThis.__PI_SPLIT_PATCH__ = true; /* PI_SUBAGENT_SPLIT_PATCH:flag */";

const RENDER_ANCHOR = "        let newLines = this.render(width);\n";
const SOURCEMAP_ANCHOR = "//# sourceMappingURL=tui.js.map";

const HOOK_BLOCK = `        ${HOOK_START}
        if (globalThis.__piSplitFrame) {
            try {
                const __piSplitFrame = globalThis.__piSplitFrame(this, newLines, width, height);
                if (Array.isArray(__piSplitFrame))
                    newLines = __piSplitFrame;
            }
            catch { }
        }
        ${HOOK_END}
`;

export function patchTuiSource(source) {
  if (source.includes(PATCH_MARKER)) return source;
  if (!source.includes(RENDER_ANCHOR)) {
    throw new Error("Pi TUI render loop did not match the expected upstream shape (render anchor not found).");
  }

  let patched = source.replace(RENDER_ANCHOR, RENDER_ANCHOR + HOOK_BLOCK);

  const flag = `${FLAG_LINE}\n`;
  if (patched.includes(SOURCEMAP_ANCHOR)) {
    patched = patched.replace(SOURCEMAP_ANCHOR, flag + SOURCEMAP_ANCHOR);
  } else {
    patched = `${patched.replace(/\n?$/, "\n")}${flag}`;
  }
  return patched;
}

export function unpatchTuiSource(source) {
  let restored = source.replace(
    /[ \t]*\/\* PI_SUBAGENT_SPLIT_PATCH:hook:start \*\/\n[\s\S]*?[ \t]*\/\* PI_SUBAGENT_SPLIT_PATCH:hook:end \*\/\n/,
    "",
  );
  restored = restored.replace(
    /globalThis\.__PI_SPLIT_PATCH__ = true; \/\* PI_SUBAGENT_SPLIT_PATCH:flag \*\/\n/,
    "",
  );
  return restored;
}

function globalNodeModules() {
  const configured = process.env.PI_GLOBAL_NODE_MODULES;
  if (configured) return configured;
  return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
}

function packageDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) return configured;
  return path.join(globalNodeModules(), "@earendil-works", "pi-coding-agent");
}

export function resolveTuiPath() {
  const override = process.env.PI_TUI_DIST;
  const candidates = override
    ? [override]
    : [
        path.join(packageDir(), "node_modules", "@earendil-works", "pi-tui", "dist", "tui.js"),
        path.join(globalNodeModules(), "@earendil-works", "pi-tui", "dist", "tui.js"),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate Pi's tui.js. Looked in:\n  ${candidates.join("\n  ")}`);
}

export function patchInstalledTuiSplit({ revert = false } = {}) {
  const tuiPath = resolveTuiPath();
  const source = readFileSync(tuiPath, "utf8");

  if (revert) {
    const restored = unpatchTuiSource(source);
    if (restored !== source) {
      writeFileSync(tuiPath, restored, "utf8");
      console.log(`Reverted Pi sub-agent split patch: ${tuiPath}`);
    } else {
      console.log(`Pi sub-agent split patch was not present: ${tuiPath}`);
    }
    return;
  }

  const patched = patchTuiSource(source);
  if (patched !== source) {
    writeFileSync(tuiPath, patched, "utf8");
    console.log(`Patched Pi TUI for sub-agent split view: ${tuiPath}`);
  } else {
    console.log(`Pi TUI sub-agent split view already patched: ${tuiPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  patchInstalledTuiSplit({ revert: process.argv.includes("--revert") });
}
