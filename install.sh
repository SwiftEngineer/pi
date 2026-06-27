#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PI_PACKAGE="${PI_PACKAGE:-@earendil-works/pi-coding-agent@0.80.2}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need node
need npm
need git

node -e 'const v=process.versions.node.split(".").map(Number); if (v[0] < 22 || (v[0] === 22 && v[1] < 19)) { console.error(`Node >=22.19.0 required; found ${process.versions.node}`); process.exit(1); }'

cd "$ROOT"
npm install
npm install -g --ignore-scripts "$PI_PACKAGE"
hash -r

if ! command -v pi >/dev/null 2>&1; then
  echo "The pi binary was not found after installing $PI_PACKAGE" >&2
  exit 1
fi

pi install "$ROOT"

echo "SwiftEngineer Pi harness installed. Run it with: pi"
