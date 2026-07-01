#!/usr/bin/env bash
# Updates the SwiftEngineer Pi harness. Now installs/uses the pi_agent_rust
# binary (canonical name: `pi`) instead of the Node @earendil-works/pi-coding-agent
# package. The rust installer migrates any pre-existing TS pi (aliasing it
# `legacy-pi`) and is idempotent, so this doubles as an upgrade path.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

cd "$ROOT"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git rev-parse --abbrev-ref --symbolic-full-name @{upstream} >/dev/null 2>&1; then
    git pull --ff-only
  else
    echo "No git upstream configured; skipping git pull."
  fi
fi

npm install

# Install/upgrade the pi_agent_rust binary (canonical name: `pi`) from the
# SwiftEngineer fork. The fork carries the extension-runtime reactor fix:
# upstream builds the extension worker's runtime without a reactor, so
# host-async hostcalls (pi.exec / pi.http / pi.tool) issued from a tool's
# execute() deadlock. The fix is verified present in the published binary; see
# docs/migration-to-pi-agent-rust.md.
#
# OWNER/REPO/VERSION are overridable. VERSION is pinned because the fork release
# is a prerelease and the installer's "latest" lookup skips prereleases; bump
# this default when cutting a new fork release. The installer (fetched from the
# same pinned release asset) honors these to locate the binary. YES/DEST/etc.
# still pass through.
export OWNER="${OWNER:-SwiftEngineer}"
export REPO="${REPO:-pi_agent_rust}"
export VERSION="${VERSION:-v0.1.20-reactorfix.1}"
export YES="${YES:-1}"
export NO_GUM="${NO_GUM:-1}"
curl -fsSL "https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}/install.sh" | bash
hash -r

# NOTE: The four patch-pi-*.mjs scripts (settings, startup-resources,
# tui-split, scrollback) are intentionally NOT run here. They patch the Node
# pi's compiled dist/tui.js, which the rust `pi` binary does not ship; running
# them throws when their anchor strings are not found. The .mjs files are kept
# on disk for the dual-target Node flow (docs/migration-to-pi-agent-rust.md).

# Register this harness package with pi. Updating this repo changes its package
# digest, so a plain re-install trips the rust pi's provenance check with a
# digest_mismatch error. Clear the stale registration and re-add at the new
# digest in that case. YES (exported above) keeps both steps non-interactive.
if ! pi install "$ROOT" 2>/dev/null; then
  pi remove "$ROOT" >/dev/null 2>&1 || true
  pi install "$ROOT"
fi

echo "SwiftEngineer Pi harness updated. Run it with: pi"
