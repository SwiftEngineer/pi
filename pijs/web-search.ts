/**
 * PiJS port (pi_agent_rust QuickJS runtime).
 *
 * Adapted from extensions/web-search.ts. Provider request construction and
 * response parsing (Brave/Tavily/Kagi) ports verbatim. The adaptation forced by
 * the node-removal direction: all networking goes through the native `pi.http()`
 * hostcall via `./_shared/http.ts` (NOT global `fetch`). The `pi.http()` shape
 * is unconfirmed and isolated entirely to _shared/http.ts; this file sees only
 * the normalized HttpRequest/HttpResponse contract.
 *
 * Assumption (§9 #1): the `process.env.BRAVE_API_KEY`/`TAVILY_API_KEY`/
 * `KAGI_API_KEY` reads are kept AS-IS. Under the PiJS shim these may be subject
 * to the `env` capability (denied by default) or secret filtering — whether the
 * keys resolve is verification-under-binary, not something to code around. If
 * env is denied, all providers see no key and the tool returns the configured
 * "no provider" message with terminate:true (graceful degradation).
 */

import { httpRequest, type HttpResponse } from "./_shared/http.ts";
import { URL } from "node:url";

type WebSearchArgs = { query: string; recency?: "day" | "week" | "month" | "year"; limit?: number };
type Result = { title: string; url: string; snippet: string; source: string };
type WebSearchDetails = { results: Result[]; errors: string[] };

interface ProviderHttp {
  http: (request: unknown) => Promise<unknown>;
}

function recencyToDays(recency: WebSearchArgs["recency"]): number | undefined {
  if (recency === "day") return 1;
  if (recency === "week") return 7;
  if (recency === "month") return 31;
  if (recency === "year") return 365;
  return undefined;
}

async function braveSearch(pi: ProviderHttp, args: WebSearchArgs, limit: number): Promise<Result[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", String(Math.min(limit, 20)));
  const freshness = recencyToDays(args.recency);
  if (freshness) url.searchParams.set("freshness", `pd${freshness}`);
  const response = await httpRequest(
    { url: url.toString(), headers: { "X-Subscription-Token": key, Accept: "application/json" } },
    pi,
  );
  if (!response.ok) throw new Error(`Brave search failed: ${response.status} ${response.body}`);
  const json = JSON.parse(response.body) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (json.web?.results ?? []).slice(0, limit).map((item) => ({
    title: item.title ?? "(untitled)",
    url: item.url ?? "",
    snippet: item.description ?? "",
    source: "brave",
  })).filter((item) => item.url);
}

async function tavilySearch(pi: ProviderHttp, args: WebSearchArgs, limit: number): Promise<Result[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const days = recencyToDays(args.recency);
  const response = await httpRequest(
    {
      method: "POST",
      url: "https://api.tavily.com/search",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: args.query, max_results: limit, days }),
    },
    pi,
  );
  if (!response.ok) throw new Error(`Tavily search failed: ${response.status} ${response.body}`);
  const json = JSON.parse(response.body) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (json.results ?? []).slice(0, limit).map((item) => ({
    title: item.title ?? "(untitled)",
    url: item.url ?? "",
    snippet: item.content ?? "",
    source: "tavily",
  })).filter((item) => item.url);
}

async function kagiSearch(pi: ProviderHttp, args: WebSearchArgs, limit: number): Promise<Result[]> {
  const key = process.env.KAGI_API_KEY;
  if (!key) return [];
  const url = new URL("https://kagi.com/api/v0/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("limit", String(limit));
  const response = await httpRequest(
    { url: url.toString(), headers: { Authorization: `Bot ${key}` } },
    pi,
  );
  if (!response.ok) throw new Error(`Kagi search failed: ${response.status} ${response.body}`);
  const json = JSON.parse(response.body) as { data?: Array<{ t?: number; title?: string; url?: string; snippet?: string }> };
  return (json.data ?? []).filter((item) => item.t === 0).slice(0, limit).map((item) => ({
    title: item.title ?? "(untitled)",
    url: item.url ?? "",
    snippet: item.snippet ?? "",
    source: "kagi",
  })).filter((item) => item.url);
}

function render(results: Result[]): string {
  return results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}\n[source: ${result.source}]`).join("\n\n");
}

const WebSearchParams = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query." },
    recency: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Restrict to recent results. (Documentation only; validated by the host as a free string.)",
    },
    limit: { type: "number", description: "Maximum results to return. Default 5." },
  },
  required: ["query"],
};

export default function (pi: ProviderHttp & { registerTool: (spec: unknown) => void }) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web through configured providers. Supports BRAVE_API_KEY, TAVILY_API_KEY, or KAGI_API_KEY.",
    parameters: WebSearchParams,
    async execute(_toolCallId: string, params: WebSearchArgs) {
      const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
      const providers = [braveSearch, tavilySearch, kagiSearch];
      const errors: string[] = [];
      for (const provider of providers) {
        try {
          const results = await provider(pi, params, limit);
          if (results.length > 0) {
            const details: WebSearchDetails = { results, errors: [] };
            return { content: [{ type: "text", text: render(results) }], details };
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const configured = ["BRAVE_API_KEY", "TAVILY_API_KEY", "KAGI_API_KEY"].filter((name) => process.env[name]);
      const message = configured.length === 0
        ? "No web search provider is configured. Set BRAVE_API_KEY, TAVILY_API_KEY, or KAGI_API_KEY."
        : `Configured providers returned no results. ${errors.join("; ")}`;
      const details: WebSearchDetails = { results: [], errors };
      return { content: [{ type: "text", text: message }], details, terminate: true };
    },
  });
}
