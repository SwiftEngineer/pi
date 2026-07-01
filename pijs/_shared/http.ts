/**
 * PiJS HTTP helper — the SINGLE seam over the unconfirmed `pi.http()` hostcall.
 *
 * Networking in pijs/ targets the native Rust hostcall `pi.http()` (capability
 * `http`) instead of the global `fetch`, because: (a) we are removing the Node
 * runtime, and (b) global-fetch availability in the QuickJS sandbox is
 * unconfirmed, while `pi.http()` is the documented native surface.
 *
 * The response shape is now CONFIRMED empirically against the fork binary
 * v0.1.20-reactorfix.1 (docs/migration-to-pi-agent-rust.md §5.2 / §9 #2):
 * `pi.http({ method, url, headers })` resolves to
 * `{ body: string, headers: object, status: number }` — there is NO `ok` field
 * and NO `text()` method; the body is a ready string. The normalization below
 * synthesizes `ok` from `status` and reads `body` directly. The seam stays
 * defensive (older/other hosts may return fetch-like objects with `text()` /
 * Uint8Array bodies), but the confirmed path is the plain-string one. This is
 * the only file in pijs/ that touches the raw hostcall shape; every consumer
 * works with the normalized {@link HttpRequest}/{@link HttpResponse} contract.
 *
 * The implementation is deliberately defensive/coercive: it submits a
 * fetch-like request object and normalizes a fetch-like response (or a plain
 * object with those fields) into HttpResponse. These tools read full bodies, so
 * a single await is correct — streaming/onChunk is intentionally unused.
 */

export interface HttpRequest {
  method?: "GET" | "POST"; // default GET
  url: string;
  headers?: Record<string, string>;
  /** String body (JSON.stringify at the call site). */
  body?: string;
  /** Best-effort timeout; passed into the request if the hostcall honors it. */
  timeoutMs?: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Lowercased header keys. */
  headers: Record<string, string>;
  /** Response body text. */
  body: string;
  /** Final URL after redirects, falling back to the requested URL. */
  url: string;
}

type PiHttp = (request: unknown) => Promise<unknown>;

/** Coerce a header-like value (Map / [k,v][] / plain object) to a lowercase-keyed record. */
function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (raw instanceof Map) {
    for (const [k, v] of raw) {
      if (typeof k === "string") out[k.toLowerCase()] = String(v ?? "");
    }
    return out;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === "string") {
        out[String(entry[0]).toLowerCase()] = String(entry[1] ?? "");
      }
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k.toLowerCase()] = String(v ?? "");
    }
  }
  return out;
}

/** Extract a string body from a fetch-like response that may expose text()/json()/body. */
function extractBody(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.text === "function") {
      const t = (obj.text as () => unknown)();
      if (t && typeof (t as Promise<unknown>).then === "function") {
        // Async text() — can't await here without knowing; handled by the caller's await path.
      } else if (typeof t === "string") {
        return t;
      }
    }
    if (typeof obj.body === "string") return obj.body;
    if (obj.body instanceof Uint8Array) return new TextDecoder().decode(obj.body);
    if (obj.body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(obj.body));
  }
  return "";
}

/**
 * Perform an HTTP request via `pi.http()` and normalize the result.
 *
 * Because the raw response shape is unconfirmed, this awaits `pi.http()` and
 * coerces the result defensively. If `pi.http()` returns a fetch-like object
 * with an async `text()`, that is awaited; otherwise synchronous fields/`body`
 * are read directly.
 */
export async function httpRequest(req: HttpRequest, pi: { http: PiHttp }): Promise<HttpResponse> {
  const request: Record<string, unknown> = {
    method: req.method ?? "GET",
    url: req.url,
    headers: req.headers ?? {},
  };
  if (req.body !== undefined) request.body = req.body;
  if (req.timeoutMs !== undefined) request.timeout = req.timeoutMs;

  const raw = await pi.http(request);

  if (raw == null || (typeof raw !== "object" && typeof raw !== "string")) {
    throw new Error(`pi.http() returned an unexpected type (${typeof raw}) for ${req.url}`);
  }

  if (typeof raw === "string") {
    // Hostcall may hand back the body directly.
    return { ok: true, status: 200, statusText: "OK", headers: {}, body: raw, url: req.url };
  }

  const obj = raw as Record<string, unknown>;
  const status = typeof obj.status === "number" ? obj.status : typeof obj.statusCode === "number" ? (obj.statusCode as number) : 200;
  const statusText = typeof obj.statusText === "string" ? obj.statusText : typeof obj.statusMessage === "string" ? (obj.statusMessage as string) : "";

  // Async text() body (fetch-like).
  let body = "";
  if (typeof obj.text === "function") {
    const maybe = (obj.text as () => unknown)();
    if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
      const resolved = await (maybe as Promise<unknown>);
      body = typeof resolved === "string" ? resolved : resolved == null ? "" : JSON.stringify(resolved);
    } else if (typeof maybe === "string") {
      body = maybe;
    }
  }
  if (body === "") body = extractBody(obj);

  const headers = normalizeHeaders(obj.headers);
  const url = typeof obj.url === "string" ? obj.url : typeof obj.finalUrl === "string" ? obj.finalUrl : req.url;

  return {
    ok: typeof obj.ok === "boolean" ? (obj.ok as boolean) : status >= 200 && status < 300,
    status,
    statusText,
    headers,
    body,
    url,
  };
}
