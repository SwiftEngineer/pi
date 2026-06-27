// perf.mjs — lightweight perf collector for a single e2e run.
//
// createPerf() gives you:
//   mark(name)                 record a timestamp under `name`
//   measure(name, fromMark)    duration from a prior mark to now, stored as metric `name`
//   sample(name, ms)           push a sample into a named series (e.g. keystroke echo)
//   addBytes(n)                accumulate stdout byte count
//   report({budgets, extra})   compute the canonical metrics object
//   write(path, obj)           persist JSON, always succeeds (mkdir -p parent)
//
// The report shape mirrors the fixture perfBudgets keys so the test can compare
// measured-vs-budget one-to-one.

import fs from "node:fs";
import path from "node:path";

export function createPerf() {
  const marks = new Map();
  const measures = new Map();
  const series = new Map();
  let bytes = 0;

  function mark(name) {
    const t = Date.now();
    marks.set(name, t);
    return t;
  }

  function measure(name, fromMark) {
    const from = marks.get(fromMark);
    if (from === undefined) {
      throw new Error(`perf.measure("${name}"): unknown fromMark "${fromMark}"`);
    }
    const ms = Date.now() - from;
    measures.set(name, ms);
    return ms;
  }

  function setMeasure(name, ms) {
    measures.set(name, ms);
    return ms;
  }

  function sample(name, ms) {
    if (!series.has(name)) series.set(name, []);
    series.get(name).push(ms);
  }

  function addBytes(n) {
    bytes += n;
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    // Nearest-rank method.
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[idx];
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  // Compute the canonical metrics object. Callers pass in whatever they have
  // measured; anything absent falls back to a stored measure or 0.
  function report({ budgets = {}, fullRedrawCount = 0, extra = {} } = {}) {
    const echoSamples = series.get("keystrokeEcho") ?? [];
    const turnSamples = series.get("turn") ?? [];

    const metrics = {
      startupToReadyMs: measures.get("startupToReadyMs") ?? 0,
      keystrokeEchoP95Ms: Math.round(percentile(echoSamples, 95)),
      submitToFirstRenderMs: measures.get("submitToFirstRenderMs") ?? 0,
      totalRunMs: measures.get("totalRunMs") ?? 0,
      meanTurnMs: Math.round(mean(turnSamples)),
      fullRedrawCount,
      stdoutBytes: bytes,
      ...extra,
    };

    // Attach a per-budget pass/fail breakdown for convenience (test may recompute).
    const budgetChecks = {};
    for (const [key, limit] of Object.entries(budgets)) {
      const metricKey = budgetKeyToMetric(key);
      const value = metrics[metricKey];
      if (value === undefined) continue;
      budgetChecks[key] = { value, limit, ok: value <= limit };
    }

    return {
      metrics,
      budgets,
      budgetChecks,
      samples: {
        keystrokeEcho: echoSamples,
        turn: turnSamples,
      },
    };
  }

  function write(filePath, obj) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      /* best effort */
    }
    try {
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      // Never let perf persistence crash the run; surface on stderr only.
      process.stderr.write(`perf.write failed: ${err?.message ?? err}\n`);
    }
  }

  return {
    mark,
    measure,
    setMeasure,
    sample,
    addBytes,
    report,
    write,
    // exposed for tests/inspection
    _marks: marks,
    _measures: measures,
    _series: series,
    get bytes() {
      return bytes;
    },
  };
}

// Map a perfBudgets key to the metrics key it constrains.
function budgetKeyToMetric(budgetKey) {
  switch (budgetKey) {
    case "fullRedrawMax":
      return "fullRedrawCount";
    case "stdoutBytesMax":
      return "stdoutBytes";
    default:
      return budgetKey; // startupToReadyMs, keystrokeEchoP95Ms, ... map 1:1
  }
}

export { budgetKeyToMetric };
