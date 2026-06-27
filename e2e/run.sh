#!/usr/bin/env bash
# Host entry for the Pi harness e2e suite (plan §6).
#
# Builds the e2e image, then runs the single node:test e2e test inside a
# hermetic container (--network none). Artifacts land on the host under
# e2e/artifacts via a bind mount, and e2e/fixtures is bind-mounted read-only so
# fixture edits need no rebuild. The container's exit code propagates.
#
# Usage:
#   bash e2e/run.sh
#   PI_E2E_SCRIPT=/repo/e2e/fixtures/<name>/script.json bash e2e/run.sh
#
# PI_E2E_SCRIPT, when set on the host, is passed through to the container and
# must be a path INSIDE the container (typically under /repo/e2e/fixtures/...,
# which is the read-only bind mount).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Pi package spec comes from the distribution manifest (single source of truth).
PI_PKG="$(node -p 'require("./distribution.json").pi')"

IMAGE="pi-harness-e2e"

echo "==> Building $IMAGE (PI_PKG=$PI_PKG)"
docker build -t "$IMAGE" --build-arg PI_PKG="$PI_PKG" -f e2e/Dockerfile .

# Fresh host artifacts dir (bind-mounted into the container at /artifacts). The
# dir must exist before the mount so docker does not create it as root. A
# previous container run leaves root-owned files behind, which a plain rm as
# the host user cannot delete — fall back to wiping the contents through the
# just-built image (runs as root, still --network none).
if ! rm -rf e2e/artifacts 2>/dev/null; then
  docker run --rm --network none -v "$PWD/e2e/artifacts:/a" \
    --entrypoint sh "$IMAGE" -c 'find /a -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
fi
mkdir -p e2e/artifacts

echo "==> Running e2e container (--network none)${PI_E2E_SCRIPT:+, PI_E2E_SCRIPT=$PI_E2E_SCRIPT}"
rc=0
docker run --rm --network none \
  -v "$PWD/e2e/artifacts:/artifacts" \
  -v "$PWD/e2e/fixtures:/repo/e2e/fixtures:ro" \
  -e PI_E2E_ARTIFACTS=/artifacts \
  ${PI_E2E_SCRIPT:+-e PI_E2E_SCRIPT} \
  "$IMAGE" || rc=$?

# The container runs as root, so artifacts land root-owned on the host, which
# would break a subsequent host-mode `node --test` run (EACCES on the wipe).
# Hand them back to the invoking user before propagating the test exit code.
docker run --rm --network none -v "$PWD/e2e/artifacts:/a" \
  --entrypoint sh "$IMAGE" -c "chown -R $(id -u):$(id -g) /a"
exit "$rc"
