#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent@0.80.2}"

cd "$ROOT"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
fi

npm install
npm install -g --ignore-scripts "$PI_PACKAGE"
hash -r
pi install "$ROOT"
pi update --all

echo "SwiftEngineer Pi harness updated. Run it with: pi"
