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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

// Run a command, streaming its output. On Windows, `npm`/`pi` are .cmd shims,
// so run through the shell there; on POSIX resolve the binary directly.
function run(cmd, args) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  if (DRY_RUN) return;
  try {
    execFileSync(cmd, args, { stdio: "inherit", shell: isWin });
  } catch {
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

  // 2. Register every package in the distribution manifest.
  for (const pkg of manifest.packages) {
    const source =
      pkg.role === "harness" && HARNESS_OVERRIDE ? HARNESS_OVERRIDE : pkg.source;
    console.log(`\n→ Installing ${pkg.name} — ${pkg.description}`);
    run("pi", ["install", source]);
  }

  // 3. pi-web-access ships with an interactive curator that opens a browser on
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
  console.log("  • Update everything later:    pi update --all\n");
}

main();
