import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WebSearchParams = Type.Object({
  query: Type.String(),
  recency: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")])),
  limit: Type.Optional(Type.Number({ description: "Maximum results to return. Default 5." })),
});

type WebSearchArgs = { query: string; recency?: "day" | "week" | "month" | "year"; limit?: number };
type Result = { title: string; url: string; snippet: string; source: string };
type WebSearchDetails = { results: Result[]; errors: string[] };

function recencyToDays(recency: WebSearchArgs["recency"]): number | undefined {
  if (recency === "day") return 1;
  if (recency === "week") return 7;
  if (recency === "month") return 31;
  if (recency === "year") return 365;
  return undefined;
}

async function braveSearch(args: WebSearchArgs, limit: number): Promise<Result[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("count", String(Math.min(limit, 20)));
  const freshness = recencyToDays(args.recency);
  if (freshness) url.searchParams.set("freshness", `pd${freshness}`);
  const response = await fetch(url, { headers: { "X-Subscription-Token": key, Accept: "application/json" } });
  if (!response.ok) throw new Error(`Brave search failed: ${response.status} ${await response.text()}`);
  const json = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (json.web?.results ?? []).slice(0, limit).map((item) => ({
    title: item.title ?? "(untitled)",
    url: item.url ?? "",
    snippet: item.description ?? "",
    source: "brave",
  })).filter((item) => item.url);
}

async function tavilySearch(args: WebSearchArgs, limit: number): Promise<Result[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const days = recencyToDays(args.recency);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query: args.query, max_results: limit, days }),
  });
  if (!response.ok) throw new Error(`Tavily search failed: ${response.status} ${await response.text()}`);
  const json = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (json.results ?? []).slice(0, limit).map((item) => ({
    title: item.title ?? "(untitled)",
    url: item.url ?? "",
    snippet: item.content ?? "",
    source: "tavily",
  })).filter((item) => item.url);
}

async function kagiSearch(args: WebSearchArgs, limit: number): Promise<Result[]> {
  const key = process.env.KAGI_API_KEY;
  if (!key) return [];
  const url = new URL("https://kagi.com/api/v0/search");
  url.searchParams.set("q", args.query);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { headers: { Authorization: `Bot ${key}` } });
  if (!response.ok) throw new Error(`Kagi search failed: ${response.status} ${await response.text()}`);
  const json = await response.json() as { data?: Array<{ t?: number; title?: string; url?: string; snippet?: string }> };
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web through configured providers. Supports BRAVE_API_KEY, TAVILY_API_KEY, or KAGI_API_KEY.",
    promptSnippet: "web_search — provider-backed web search.",
    promptGuidelines: ["Use web_search for up-to-date facts beyond local context; cite result URLs in final answers."],
    parameters: WebSearchParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: WebSearchArgs): Promise<AgentToolResult<WebSearchDetails>> {
      const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
      const providers = [braveSearch, tavilySearch, kagiSearch];
      const errors: string[] = [];
      for (const provider of providers) {
        try {
          const results = await provider(params, limit);
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
