// wait.mjs — poll a predicate until it holds or a deadline elapses.
//
// waitFor(fn, {timeoutMs, intervalMs, label, onTimeout})
//   - fn: () => boolean | Promise<boolean>. Polled every `intervalMs`.
//   - Resolves with the elapsed ms once fn() is truthy.
//   - Rejects (with `label` + an optional caller-supplied screen dump) on
//     timeout so failures point at what we were waiting for and what the
//     terminal looked like when we gave up.

export async function waitFor(
  fn,
  { timeoutMs = 15000, intervalMs = 25, label = "condition", onTimeout } = {},
) {
  const start = Date.now();
  const deadline = start + timeoutMs;

  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch (err) {
      const e = new Error(`waitFor(${label}) predicate threw: ${err?.message ?? err}`);
      e.cause = err;
      throw e;
    }
    if (ok) return Date.now() - start;

    if (Date.now() >= deadline) {
      let dump = "";
      try {
        dump = typeof onTimeout === "function" ? await onTimeout() : "";
      } catch {
        dump = "(onTimeout dump failed)";
      }
      const elapsed = Date.now() - start;
      const msg =
        `waitFor(${label}) timed out after ${elapsed}ms (budget ${timeoutMs}ms)` +
        (dump ? `\n----- screen -----\n${dump}\n------------------` : "");
      throw new Error(msg);
    }

    await sleep(intervalMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
