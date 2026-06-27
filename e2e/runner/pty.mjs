// pty.mjs — spawn the real `pi` binary under a pseudo-terminal and wire it to
// a headless screen + perf collector.
//
// spawnPi({scriptPath, artifactsDir, extensionPath, model, thinkingLevel, extraEnv, cwd})
//   Returns a handle:
//     { ptyProc, screen, perf, paths, fullRedrawCount(), waitForExit(ms),
//       shutdown(opts), withWatchdog(ms), kill(), exited, exitInfo }
//
// Design / verified facts baked in here:
//   - pi args are composable. A probe can spawn plain `pi --approve` by omitting
//     model / thinkingLevel / extensionPath.
//   - PI_DEBUG_REDRAW=1 makes pi-tui append full-redraw lines to
//     `$HOME/.pi/agent/pi-debug.log`. The path IGNORES PI_CODING_AGENT_* env
//     overrides and pi THROWS if the parent dir is missing, so we mkdir it and
//     checkpoint the file's size at spawn to count only new redraws.
//   - PI_CODING_AGENT_SESSION_DIR redirects session storage (verified
//     main.js:439) so we never touch the user's real sessions.
//   - PI_TUI_WRITE_LOG as a non-existent path is used verbatim as a file
//     (terminal.js:52). We point it at <artifactsDir>/tui-write.log.

import pty from "node-pty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScreen } from "./screen.mjs";
import { createPerf } from "./perf.mjs";
import { isReady, isEditorEmpty } from "./detect.mjs";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export function spawnPi({
  scriptPath,
  artifactsDir,
  extensionPath,
  model,
  thinkingLevel,
  extraEnv = {},
  cwd,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  command = "pi",
} = {}) {
  if (!artifactsDir) throw new Error("spawnPi: artifactsDir is required");

  fs.mkdirSync(artifactsDir, { recursive: true });

  // Fresh scratch workspace for pi's cwd (never this repo). If a cwd is given,
  // honor it; otherwise create/clean <artifactsDir>/workspace.
  const workspace = cwd ?? path.join(artifactsDir, "workspace");
  if (!cwd) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  fs.mkdirSync(workspace, { recursive: true });

  const sessionsDir = path.join(artifactsDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const rawPtyLog = path.join(artifactsDir, "raw-pty.log");
  const tuiWriteLog = path.join(artifactsDir, "tui-write.log");

  // pi-debug.log lives under $HOME/.pi/agent regardless of session-dir override
  // and pi throws if the dir is missing.
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const piDebugLog = path.join(agentDir, "pi-debug.log");
  // Checkpoint the debug log's current size so fullRedrawCount only sees new lines.
  let debugLogCheckpoint = 0;
  try {
    debugLogCheckpoint = fs.statSync(piDebugLog).size;
  } catch {
    debugLogCheckpoint = 0;
  }

  // Compose args: omit --model / --thinking / -e when not provided so a probe
  // can run a plain `pi --approve`.
  const args = [];
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  if (extensionPath) args.push("-e", extensionPath);
  args.push("--approve");

  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    PI_TUI_WRITE_LOG: tuiWriteLog,
    PI_DEBUG_REDRAW: "1",
    PI_OFFLINE: "1",
    ...(scriptPath ? { PI_E2E_SCRIPT: scriptPath } : {}),
    ...extraEnv,
  };

  const screen = createScreen({ cols, rows });
  const perf = createPerf();

  // Raw PTY byte log (append). Written on every chunk for post-mortem.
  const rawStream = fs.createWriteStream(rawPtyLog, { flags: "w" });

  perf.mark("spawn");

  const ptyProc = pty.spawn(command, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: workspace,
    env,
  });

  let exited = false;
  const exitInfo = { exitCode: null, signal: null };
  const exitWaiters = [];

  ptyProc.onData((data) => {
    perf.addBytes(Buffer.byteLength(data, "utf8"));
    screen.feed(data);
    try {
      rawStream.write(data);
    } catch {
      /* best effort */
    }
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    exited = true;
    exitInfo.exitCode = exitCode;
    exitInfo.signal = signal ?? null;
    try {
      rawStream.end();
    } catch {
      /* ignore */
    }
    const waiters = exitWaiters.splice(0, exitWaiters.length);
    for (const resolve of waiters) resolve(true);
  });

  // Count full redraws logged since spawn (each logRedraw line contains "fullRender:").
  function fullRedrawCount() {
    let content = "";
    try {
      const fd = fs.openSync(piDebugLog, "r");
      try {
        const size = fs.statSync(piDebugLog).size;
        const start = Math.min(debugLogCheckpoint, size);
        const len = size - start;
        if (len > 0) {
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          content = buf.toString("utf8");
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 0;
    }
    const matches = content.match(/fullRender:/g);
    return matches ? matches.length : 0;
  }

  // Resolve true if the process has exited within `ms`, false on timeout.
  function waitForExit(ms = 5000) {
    if (exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const done = (val) => {
        if (timer) clearTimeout(timer);
        resolve(val);
      };
      exitWaiters.push(() => done(true));
      timer = setTimeout(() => done(exited), ms);
    });
  }

  function kill(signal) {
    try {
      ptyProc.kill(signal);
    } catch {
      /* already gone */
    }
  }

  // Graceful shutdown. Records which escalation path was needed.
  //   empty editor  -> ctrl+d (app.exit)                            "ctrl-d"
  //   non-empty     -> ctrl+c (clears) then ctrl+d                  "ctrl-c+ctrl-d"
  //   escalation    -> double ctrl+c ("clear twice to exit")        "+ctrl-c-ctrl-c"
  //   last resort   -> kill()                                       "+kill"
  async function shutdown({ timeoutMs = 5000 } = {}) {
    if (exited) {
      return { path: "already-exited", exited: true, ...exitInfo };
    }
    await screen.flush();

    let pathUsed;
    const ready = isReady(screen);
    const empty = ready && isEditorEmpty(screen);

    if (empty) {
      pathUsed = "ctrl-d";
      ptyProc.write("\x04");
      if (await waitForExit(timeoutMs)) return finish(pathUsed);
    } else {
      pathUsed = "ctrl-c+ctrl-d";
      ptyProc.write("\x03"); // clear any editor contents / cancel
      await sleep(200);
      ptyProc.write("\x04"); // exit on now-empty editor
      if (await waitForExit(timeoutMs)) return finish(pathUsed);
    }

    // Escalate: two ctrl+c presses ("clear twice to exit").
    pathUsed += "+ctrl-c-ctrl-c";
    ptyProc.write("\x03");
    await sleep(120);
    ptyProc.write("\x03");
    if (await waitForExit(2000)) return finish(pathUsed);

    // Last resort: SIGKILL the pty.
    pathUsed += "+kill";
    kill();
    await waitForExit(2000);
    return finish(pathUsed);
  }

  function finish(pathUsed) {
    return { path: pathUsed, exited, exitCode: exitInfo.exitCode, signal: exitInfo.signal };
  }

  // withWatchdog(ms): returns { promise, cancel }. If the timer fires before
  // cancel(), the pty is force-killed and the promise rejects. Prevents CI hangs.
  function withWatchdog(ms) {
    let timer = null;
    let cancelled = false;
    const promise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        if (cancelled) return;
        kill();
        reject(new Error(`watchdog: forced kill after ${ms}ms`));
      }, ms);
      if (typeof timer.unref === "function") timer.unref();
    });
    // Swallow rejection if nobody is awaiting, so an un-awaited watchdog does
    // not crash the process; callers that care should await/race it.
    promise.catch(() => {});
    function cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    }
    return { promise, cancel };
  }

  return {
    ptyProc,
    screen,
    perf,
    paths: {
      workspace,
      sessionsDir,
      rawPtyLog,
      tuiWriteLog,
      piDebugLog,
    },
    fullRedrawCount,
    waitForExit,
    shutdown,
    withWatchdog,
    kill,
    get exited() {
      return exited;
    },
    get exitInfo() {
      return exitInfo;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
