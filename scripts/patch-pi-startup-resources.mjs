import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Suppress noisy startup resource listing sections that are not useful for this
 * harness. Pi still loads skills, extensions, and themes; only the initial TUI
 * sections named [Skills], [Extensions], and [Themes] are hidden.
 */

const PATCH_MARKER = "SWIFTENGINEER_STARTUP_RESOURCE_DISPLAY_PATCH";

const ADD_LOADED_SECTION_ANCHOR =
  '        const addLoadedSection = (name, collapsedBody, expandedBody = collapsedBody, color = "mdHeading") => {\n';

const SUPPRESS_RESOURCE_SECTIONS = `            // ${PATCH_MARKER}:suppress-noisy-resource-sections
            if (name === "Skills" || name === "Extensions" || name === "Themes") {
                return;
            }
`;

export function patchStartupResourceDisplaySource(source) {
  if (source.includes(PATCH_MARKER)) return source;
  if (!source.includes(ADD_LOADED_SECTION_ANCHOR)) {
    throw new Error("Pi startup resource display did not match the expected upstream shape (addLoadedSection anchor not found).");
  }
  return source.replace(ADD_LOADED_SECTION_ANCHOR, ADD_LOADED_SECTION_ANCHOR + SUPPRESS_RESOURCE_SECTIONS);
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

export function resolveInteractiveModePath() {
  const target = path.join(packageDir(), "dist", "modes", "interactive", "interactive-mode.js");
  if (!existsSync(target)) {
    throw new Error(`Could not locate Pi's interactive-mode.js at ${target}`);
  }
  return target;
}

export function patchInstalledStartupResourceDisplay() {
  const target = resolveInteractiveModePath();
  const source = readFileSync(target, "utf8");
  const patched = patchStartupResourceDisplaySource(source);
  if (patched !== source) {
    writeFileSync(target, patched, "utf8");
    console.log(`Patched Pi startup resource display: ${target}`);
  } else {
    console.log(`Pi startup resource display already patched: ${target}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  patchInstalledStartupResourceDisplay();
}
