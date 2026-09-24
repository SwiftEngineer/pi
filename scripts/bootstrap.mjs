#!/usr/bin/env node
// SwiftEngineer Pi Distribution — cross-platform installer.
//
// Installs a known-good, pinned Pi coding agent, then registers every package
// declared in distribution.json. Runs identically on macOS, Linux, and Windows:
// it uses only Node built-ins and shells out to `npm` and `pi`.
//
// Env overrides:
//   PI_PACKAGE          npm spec for the pi coding agent (default: distribution.json "pi")
//   PI_HARNESS_SOURCE   override the source for the harness package (e.g. a local checkout)
//
// Flags:
//   --dry-run           print the plan without changing anything

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { configureWebAccess } from "./web-access-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "distribution.json"), "utf8"));

const DRY_RUN = process.argv.includes("--dry-run");
const isWin = process.platform === "win32";
const PI_PACKAGE = process.env.PI_PACKAGE || manifest.pi;
const HARNESS_OVERRIDE = process.env.PI_HARNESS_SOURCE || null;

const MIN_NODE = [22, 19, 0];

// Packages the distribution once shipped in distribution.json but no longer
// does. Machines installed through an older distribution keep them in
// ~/.pi/agent/settings.json, and pi >= 0.87 refuses to launch when two
// extensions register the same tool name — pi-better-edit's `read` collides
// with pi-hashline-edit-pro's, which superseded it in "subagents v2". The
// installer prunes these so updates self-heal instead of dead-locking launch.
const SUPERSEDED_PACKAGES = new Set(["pi-better-edit", "pi-automode"]);

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

// Run a command, streaming its output. On Windows, `npm`/`pi` are .cmd shims,
// so run through the shell there; on POSIX resolve the binary directly.
function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  if (DRY_RUN) return;
  try {
    execFileSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts });
  } catch {
    if (opts.tolerant) {
      console.error(`  (ignored: ${cmd} ${args.join(" ")} failed)`);
      return;
    }
    fail(`command failed: ${cmd} ${args.join(" ")}`);
  }
}

function have(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", shell: isWin });
    return true;
  } catch {
    return false;
  }
}

// npm spec ("npm:name", "npm:@scope/name@ver") or git/https source -> package
// name, so superseded entries match regardless of how they were installed.
function packageNameFromSource(source) {
  const trimmed = String(source).trim();
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4);
    const at = spec.lastIndexOf("@");
    return at > 0 ? spec.slice(0, at) : spec;
  }
  const lastSegment = trimmed
    .replace(/^(https?|ssh|git):\/\//, "")
    .replace(/^git@/, "")
    .split("/")
    .pop();
  return (lastSegment ?? "").replace(/\.git$/, "").replace(/@[^@]*$/, "");
}

// Remove settings.json entries for distribution packages the manifest no longer
// lists. Best-effort: a missing/corrupt settings file or a failed `pi remove`
// never blocks the install.
function pruneSupersededPackages() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  let packages;
  try {
    packages = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")).packages ?? [];
  } catch {
    return; // fresh machine or unreadable settings: nothing to reconcile
  }
  const manifestNames = new Set(manifest.packages.map((pkg) => pkg.name));
  const stale = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") continue;
    const name = packageNameFromSource(source);
    if (name && SUPERSEDED_PACKAGES.has(name) && !manifestNames.has(name)) stale.push(source);
  }
  for (const source of stale) {
    console.log(`\n→ Removing ${source} — superseded by the manifest; pi fails to launch while two extensions register the same tool name`);
    run("pi", ["remove", source], { tolerant: true });
  }
}

// Harness extension files retired from the distribution. The harness `ask` tool
// is superseded by the pi-ask-user plugin's `ask_user` tool; machines that
// still hold an old harness git clone (or a PI_HARNESS_SOURCE override pointing
// at a stale checkout) keep loading the old file, and pi has no per-extension
// uninstall — so the installer removes the file and its package.json
// registration wherever the harness is materialized. Idempotent: fresh
// installs never contain these paths.
const RETIRED_HARNESS_EXTENSIONS = ["./extensions/ask.ts"];

// Install path (<agentDir>/git/<host>/<owner>/<repo>) for a git/ssh/https
// package source, matching pi's git clone layout.
function gitCloneDirFromSource(source) {
  const segments = String(source)
    .trim()
    .replace(/^(https?|ssh|git):\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return segments.length >= 3 ? path.join("git", ...segments.slice(0, 3)) : null;
}

// Delete retired extension files and their package.json registrations from
// each harness location. Tolerant of missing dirs and unreadable manifests;
// respects --dry-run.
function purgeRetiredHarnessExtensions(harnessDirs) {
  for (const dir of harnessDirs) {
    if (!dir || !existsSync(dir)) continue;
    for (const extension of RETIRED_HARNESS_EXTENSIONS) {
      const file = path.join(dir, extension);
      if (!existsSync(file)) continue;
      console.log(`\n→ Purging retired harness extension ${extension} from ${dir}`);
      if (!DRY_RUN) rmSync(file, { force: true });
    }
    const packageJsonPath = path.join(dir, "package.json");
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch {
      continue; // no manifest to fix up
    }
    const extensions = packageJson?.pi?.extensions;
    if (!Array.isArray(extensions)) continue;
    const kept = extensions.filter((extension) => !RETIRED_HARNESS_EXTENSIONS.includes(extension));
    if (kept.length === extensions.length) continue;
    console.log(`→ Dropping retired extensions from ${packageJsonPath}`);
    if (DRY_RUN) continue;
    packageJson.pi.extensions = kept;
    try {
      writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    } catch {
      console.error("  (ignored: could not rewrite package.json)");
    }
  }
}
function preflight() {
  const node = process.versions.node.split(".").map(Number);
  const tooOld =
    node[0] < MIN_NODE[0] ||
    (node[0] === MIN_NODE[0] && node[1] < MIN_NODE[1]);
  if (tooOld) {
    fail(`Node >= ${MIN_NODE.join(".")} is required; found ${process.versions.node}.`);
  }
  if (!have("npm")) fail("`npm` was not found on PATH. Install Node.js (which bundles npm) and retry.");
  if (!have("git")) fail("`git` was not found on PATH. Install git and retry.");
}

function main() {
  console.log(`\n◆ Installing: ${manifest.name}`);
  if (DRY_RUN) console.log("  (dry run — no changes will be made)\n");

  preflight();

  // 1. Install a known-good, pinned pi. This overwrites any stale/faulty pi on
  //    PATH so the distribution never depends on whatever happens to be present.
  console.log(`\n→ Installing the Pi coding agent (${PI_PACKAGE})`);
  run("npm", ["install", "-g", "--ignore-scripts", PI_PACKAGE]);

  if (!DRY_RUN && !have("pi")) {
    fail(
      "The `pi` command was not found after install. Ensure your npm global bin " +
        "directory is on PATH (see `npm config get prefix`), then re-run.",
    );
  }

  // 2. Reconcile the machine with the manifest: drop packages an older
  //    distribution installed but the manifest has since replaced.
  pruneSupersededPackages();

  // 3. A local-checkout harness (install.sh / install.ps1 set PI_HARNESS_SOURCE)
  //    is registered in place: unlike git/npm sources, pi does not run npm for
  //    it, so the checkout's own dependencies must exist when pi launches and
  //    loads extensions/search.ts (glob, ignore) and ast-tools (node_modules/.bin/sg).
  //    Skip when they're already present so repeat installs on a dev checkout
  //    stay fast and never disturb an existing node_modules. Install scripts
  //    stay enabled on purpose: @ast-grep/cli materializes node_modules/.bin/sg.
  const harnessSource =
    HARNESS_OVERRIDE && manifest.packages.some((pkg) => pkg.role === "harness")
      ? HARNESS_OVERRIDE
      : null;
  if (harnessSource) {
    const sg = isWin ? "sg.cmd" : "sg";
    const haveDeps =
      existsSync(path.join(harnessSource, "node_modules", "glob")) &&
      existsSync(path.join(harnessSource, "node_modules", "ignore")) &&
      existsSync(path.join(harnessSource, "node_modules", ".bin", sg));
    if (!haveDeps) {
      console.log(`\n→ Installing harness dependencies in ${harnessSource}`);
      run("npm", ["install", "--omit=dev"], { cwd: harnessSource });
    }
  }

  // 4. Register every package in the distribution manifest.
  for (const pkg of manifest.packages) {
    const source =
      pkg.role === "harness" && harnessSource ? harnessSource : pkg.source;
    console.log(`\n→ Installing ${pkg.name} — ${pkg.description}`);
    run("pi", ["install", source]);
  }

  // 4b. Purge harness extension files retired from the distribution: both a
  //     previously installed git clone of the harness and a stale local
  //     checkout (PI_HARNESS_SOURCE). No-op on fresh installs.
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const harnessPackage = manifest.packages.find((pkg) => pkg.role === "harness");
  const harnessCloneDir = harnessPackage ? gitCloneDirFromSource(harnessPackage.source) : null;
  purgeRetiredHarnessExtensions([
    ...(harnessSource ? [harnessSource] : []),
    ...(harnessCloneDir ? [path.join(agentDir, harnessCloneDir)] : []),
  ]);

  // 5. pi-web-access ships with an interactive curator that opens a browser on
  //    every search. Force it headless so installs never take over the browser.
  if (manifest.packages.some((pkg) => pkg.name === "pi-web-access")) {
    console.log("");
    configureWebAccess({ dryRun: DRY_RUN });
  }

  console.log(`\n✔ ${manifest.name} installed.`);
  console.log("\nNext steps:");
  console.log("  • Set a provider API key (e.g. export ANTHROPIC_API_KEY=... or GEMINI_API_KEY=...).");
  console.log("  • Start the agent:            pi");
  console.log("  • Configure MCP servers:      pi   →  /mcp setup");
  console.log("  • Update extensions later:    pi update --extensions\n");
}

// Only auto-run when invoked directly (install.sh / install.ps1 / update.sh /
// `npm run setup`); scripts/smoke.mjs imports the purge helpers directly.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}

export { main, purgeRetiredHarnessExtensions, gitCloneDirFromSource };
