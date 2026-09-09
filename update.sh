#!/usr/bin/env bash
# Update the SwiftEngineer Pi Distribution.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
fi

# Re-run the installer to refresh pinned pi + this local harness, then let pi
# pull the latest for every remote-installed package (plugins).
export PI_HARNESS_SOURCE="${PI_HARNESS_SOURCE:-$ROOT}"
node "$ROOT/scripts/bootstrap.mjs"
pi update --extensions || true

echo "SwiftEngineer Pi Distribution updated. Run it with: pi"
