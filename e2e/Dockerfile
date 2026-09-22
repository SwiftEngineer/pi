# E2E image for the Pi harness (plan §6). Build context = repo root.
#
# Installs pi globally, restores the harness + e2e deps from lockfiles, registers
# the harness with `pi install /repo`, and runs the single node:test e2e test
# which drives the real interactive TUI under a PTY via node-pty.
FROM node:24-bookworm-slim

# bash        - run.sh / node:test niceties
# git         - pi/harness tooling expects it on PATH
# ripgrep     - the harness search tool shells out to `rg`
# python3/make/g++ - node-pty compiles a native addon via node-gyp
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates git ripgrep python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# pi package spec is supplied by run.sh from distribution.json (single source of
# truth). The global install follows the official recipe: --ignore-scripts.
ARG PI_PKG=@earendil-works/pi-coding-agent@0.87.0
RUN npm install -g --ignore-scripts ${PI_PKG}

WORKDIR /repo

# Harness deps first (cache-friendly). npm ci runs WITH scripts on purpose so
# node_modules/.bin/sg (@ast-grep/cli) materializes — the harness's ast tools
# resolve it from /repo/node_modules. The repo's own postinstall hook runs
# `node scripts/postinstall.mjs`, so that file must exist before npm ci.
COPY package.json package-lock.json ./
COPY scripts/postinstall.mjs ./scripts/
RUN npm ci

# e2e-only deps (node-pty + @xterm/headless). node-pty builds its native addon
# here (needs python3/make/g++ above).
COPY e2e/package.json e2e/package-lock.json ./e2e/
RUN cd e2e && npm ci

# Full source last.
COPY . .

# PI_DEBUG_REDRAW writes to /root/.pi/agent and `pi install` needs the dir too.
RUN mkdir -p /root/.pi/agent && pi install /repo

ENV PI_OFFLINE=1 TERM=xterm-256color

# Directory form (`e2e/tests/`) is broken on Node 24.15 — it tries to load the
# dir as a module. The glob is expanded by Node's test runner itself (no shell).
CMD ["node", "--test", "e2e/tests/*.test.mjs"]
