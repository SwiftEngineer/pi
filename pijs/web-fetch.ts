/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/web-fetch.ts. All pure string logic (URL validation,
 * content-type detection, extractTitle, htmlToText, decodeEntities, the
 * HTML/JSON/plain branching, and maxChars truncation) ports verbatim. The
 * adaptation forced by the node-removal direction:
 *   - Networking goes through the native `pi.http()` hostcall via
 *     `./_shared/http.ts` (NOT global `fetch`). The pi.http() shape is
 *     unconfirmed and isolated entirely to _shared/http.ts.
 *   - The AbortController + setTimeout request timeout is DROPPED (timers are
 *     unconfirmed per §5.3, and we are eliminating fetch). The timeout is passed
 *     as `timeoutMs` into httpRequest (best-effort, if the hostcall honors it);
 *     redirect-following is likewise delegated to pi.http().
 */

import { httpRequest } from "./_shared/http.ts";

type WebFetchArgs = { url: string; maxChars?: number; timeoutMs?: number };
type WebFetchDetails = {
  url: string;
  finalUrl?: string;
  status?: number;
  contentType?: string;
  title?: string;
  length?: number;
  truncated?: boolean;
  error?: string;
};

interface ProviderHttp {
  http: (request: unknown) => Promise<unknown>;
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 pi-web-fetch";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©",
  reg: "®", trade: "™", deg: "°", times: "×", middot: "·", bull: "•", euro: "€", pound: "£",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1] ?? "").replace(/\s+/g, " ").trim() : "";
}

// Dependency-free HTML → readable text. Crude but good enough for claim extraction.
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|template|svg|head|iframe|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<h[1-6]\b[^>]*>/gi, "\n\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

const WebFetchParams = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) URL of the page or document to fetch." },
    maxChars: { type: "number", description: "Max characters of extracted text to return. Default 20000." },
    timeoutMs: { type: "number", description: "Request timeout in milliseconds. Default 20000." },
  },
  required: ["url"],
};

export default function (pi: ProviderHttp & { registerTool: (spec: unknown) => void }) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page or document by URL and return its readable text content (HTML stripped to text).",
    parameters: WebFetchParams,
    async execute(_toolCallId: string, params: WebFetchArgs) {
      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: ${params.url}` }], details: { url: params.url, error: "invalid-url" } };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { content: [{ type: "text", text: `Only http/https URLs are supported (got ${parsed.protocol}).` }], details: { url: params.url, error: "unsupported-protocol" } };
      }

      const maxChars = clamp(params.maxChars ?? 20000, 500, 100000);
      const timeoutMs = clamp(params.timeoutMs ?? 20000, 1000, 60000);

      try {
        const response = await httpRequest(
          {
            url: params.url,
            timeoutMs,
            headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8" },
          },
          pi,
        );
        const status = response.status;
        const contentType = response.headers["content-type"] ?? "";
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Fetch failed: HTTP ${status} ${response.statusText} for ${params.url}` }],
            details: { url: params.url, finalUrl: response.url, status, contentType, error: `http-${status}` },
          };
        }
        if (/(application\/pdf|image\/|audio\/|video\/|application\/octet-stream|application\/zip|font\/)/i.test(contentType)) {
          return {
            content: [{ type: "text", text: `Cannot extract text from non-text content (${contentType || "unknown"}) at ${params.url}.` }],
            details: { url: params.url, finalUrl: response.url, status, contentType, error: "binary-content" },
          };
        }

        const raw = response.body;
        let title = "";
        let text: string;
        if (/text\/html|application\/xhtml/i.test(contentType) || /^\s*<(?:!doctype|html|head|body)/i.test(raw)) {
          title = extractTitle(raw);
          text = htmlToText(raw);
        } else if (/application\/json/i.test(contentType)) {
          try {
            text = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            text = raw;
          }
        } else {
          text = raw.trim();
        }

        const truncated = text.length > maxChars;
        const body = truncated ? `${text.slice(0, maxChars)}\n\n…[truncated ${text.length - maxChars} more chars]` : text;
        const header = `# ${title || parsed.hostname}\nURL: ${response.url}\n\n`;
        return {
          content: [{ type: "text", text: header + (body || "(no extractable text content)") }],
          details: { url: params.url, finalUrl: response.url, status, contentType, title, length: text.length, truncated },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Fetch error for ${params.url}: ${message}` }], details: { url: params.url, error: message } };
      }
    },
  });
}
