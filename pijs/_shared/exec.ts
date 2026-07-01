/**
 * PiJS exec helper — the SINGLE seam over the unconfirmed `pi.exec()` hostcall.
 *
 * Subprocess execution in pijs/ targets the native Rust hostcall `pi.exec()`
 * (capability `exec`) instead of `node:child_process`. The result shape is now
 * CONFIRMED empirically against the fork binary v0.1.20-reactorfix.1 (see
 * docs/migration-to-pi-agent-rust.md §9 #5): `pi.exec(cmd, args, {cwd, timeout})`
 * resolves to `{ code: number, killed: boolean, stdout: string, stderr: string }`.
 * The seam stays defensive (other hosts/versions may differ) but the primary
 * path matches that shape. Note: the hostcall HANGS if called during module
 * load / activate() (the host does not pump I/O at load time) — it must only be
 * invoked from inside a tool's `execute()`.
 *
 * To contain that risk, this is the only file in pijs/ that touches the raw
 * `pi.exec` shape; every consumer (ast-tools today, task in Phase 4) works with
 * the normalized {@link ExecResult} contract below. Once the real shape is
 * confirmed under a binary, revise THIS FILE ONLY.
 *
 * The implementation is deliberately defensive/coercive:
 *   - Options: passes `cwd` and `timeout` (ms). `timeout` is the key used by the
 *     Node host's `ExecOptions`; if the Rust host expects a different key it is
 *     simply ignored and the host's own ExtensionRegion budget bounds runtime.
 *   - Result: accepts either a string (treated as stdout, code 0) or an object,
 *     reads the exit code from `code`/`exitCode`/`status`, and decodes
 *     stdout/stderr whether returned as strings, Uint8Array, or ArrayBuffer.
 *
 * IMPORTANT: never call any function here at top level / during activate() —
 * only from within `execute()`.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Best-effort wall-clock timeout in milliseconds (host may ignore the key). */
  timeoutMs?: number;
}

type PiExec = (command: string, args: string[], options?: unknown) => Promise<unknown>;

/** Decode a typed array / buffer, tolerant of cross-realm values (M2). */
function decodeView(view: ArrayBufferView): string {
  return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

function decodeStream(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // M2: a Uint8Array/DataView minted in another QuickJS realm fails
  // `instanceof Uint8Array`; `ArrayBuffer.isView()` is realm-agnostic.
  if (ArrayBuffer.isView(value)) return decodeView(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (typeof value === "object") {
    // Some hosts wrap output in { data } or expose a toString().
    const obj = value as Record<string, unknown>;
    if (typeof obj.data === "string") return obj.data;
    if (ArrayBuffer.isView(obj.data)) return decodeView(obj.data);
  }
  return String(value);
}

function readCode(obj: Record<string, unknown>): number {
  for (const key of ["code", "exitCode", "status"]) {
    const v = obj[key];
    if (typeof v === "number") return v;
  }
  // M1: no explicit numeric exit code. If the host signalled an abnormal end
  // (the confirmed shape carries `killed`; other hosts use signal/timedOut/error),
  // treat it as a failure rather than silently reporting success. Do NOT key off
  // stderr being non-empty — the resolver's `--version` probe accepts an ast-grep
  // that legitimately writes to stderr.
  if (
    obj.killed === true ||
    obj.timedOut === true ||
    obj.error != null ||
    (typeof obj.signal === "string" && obj.signal !== "")
  ) {
    return 1;
  }
  return 0;
}

/**
 * Run a subprocess via `pi.exec()` and normalize the result to
 * `{ code, stdout, stderr }`. Resolves (never rejects) for a non-zero exit; it
 * only throws if the hostcall itself rejects (e.g. command not found / not
 * executable), which callers use to drive PATH-fallback probing.
 */
export async function execCommand(
  command: string,
  args: string[],
  options: ExecOptions | undefined,
  pi: { exec: PiExec },
): Promise<ExecResult> {
  const opts: Record<string, unknown> = {};
  if (options?.cwd !== undefined) opts.cwd = options.cwd;
  if (options?.timeoutMs !== undefined) opts.timeout = options.timeoutMs;

  const raw = await pi.exec(command, args, opts);

  if (raw == null) {
    return { code: 0, stdout: "", stderr: "" };
  }
  if (typeof raw === "string") {
    return { code: 0, stdout: raw, stderr: "" };
  }
  if (typeof raw !== "object") {
    return { code: 0, stdout: String(raw), stderr: "" };
  }

  const obj = raw as Record<string, unknown>;
  return {
    code: readCode(obj),
    stdout: decodeStream(obj.stdout ?? obj.out),
    stderr: decodeStream(obj.stderr ?? obj.err),
  };
}
