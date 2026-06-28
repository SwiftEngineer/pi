#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent@0.80.2}"

cd "$ROOT"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git rev-parse --abbrev-ref --symbolic-full-name @{upstream} >/dev/null 2>&1; then
    git pull --ff-only
  else
    echo "No git upstream configured; skipping git pull."
  fi
fi

npm install
npm install -g --ignore-scripts "$PI_PACKAGE"
node scripts/patch-pi-settings.mjs
hash -r
pi install "$ROOT"

echo "SwiftEngineer Pi harness updated. Run it with: pi"
