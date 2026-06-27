#!/usr/bin/env bash
# Install the SwiftEngineer Pi Distribution from a local checkout.
# For a one-line remote install, see the README (npx one-liner).
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Missing required command: node (install Node.js >= 22.19.0)" >&2
  exit 1
fi

# Running from a checkout means "install this copy" as the harness.
export PI_HARNESS_SOURCE="${PI_HARNESS_SOURCE:-$ROOT}"
exec node "$ROOT/scripts/bootstrap.mjs" "$@"
