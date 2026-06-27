import { promises as fs } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import ignore from "ignore";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SearchParams = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression to search for." }),
  paths: Type.Optional(
    Type.Union([
      Type.String({ description: "File, directory, or glob to search." }),
      Type.Array(Type.String(), { description: "Files, directories, or globs to search." }),
    ]),
  ),
  i: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
  context: Type.Optional(Type.Number({ description: "Number of context lines around each match." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum matching lines to return. Default 200." })),
  gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore in the current working directory. Default true." })),
});

type SearchParamsType = {
  pattern: string;
  paths?: string | string[];
  i?: boolean;
  context?: number;
  maxResults?: number;
  gitignore?: boolean;
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function expandInput(cwd: string, input: string): Promise<string[]> {
  const absolute = path.resolve(cwd, input);
  try {
    const st = await fs.stat(absolute);
    if (st.isFile()) return [absolute];
    if (st.isDirectory()) return glob("**/*", { cwd: absolute, nodir: true, dot: true, absolute: true });
  } catch {
    // Treat non-existing path as a glob below.
  }
  return glob(input, { cwd, nodir: true, dot: true, absolute: true });
}

async function loadIgnore(cwd: string, enabled: boolean) {
  const ig = ignore();
  if (!enabled) return ig;
  const file = path.join(cwd, ".gitignore");
  if (await exists(file)) ig.add(await fs.readFile(file, "utf8"));
  ig.add([".git/", "node_modules/", ".pi/", ".omp/"]);
  return ig;
}

function lineRanges(line: number, total: number, context: number): number[] {
  const start = Math.max(1, line - context);
  const end = Math.min(total, line + context);
  const out: number[] = [];
  for (let n = start; n <= end; n++) out.push(n);
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: "Search file contents with a regular expression. Use this instead of grep, rg, awk, or sed for content lookup.",
    promptSnippet: "search — regex content search across files/directories/globs.",
    promptGuidelines: ["Use search for plain-text content lookup instead of shell grep/rg/ag/awk/sed."],
    parameters: SearchParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: SearchParamsType, _signal, _onUpdate, ctx) {
      const inputs = Array.isArray(params.paths) ? params.paths : [params.paths ?? "."];
      const regex = new RegExp(params.pattern, params.i ? "i" : "");
      const maxResults = Math.max(1, Math.min(params.maxResults ?? 200, 1000));
      const context = Math.max(0, Math.min(params.context ?? 1, 10));
      const ig = await loadIgnore(ctx.cwd, params.gitignore !== false);
      const files = new Set<string>();
      for (const input of inputs) {
        for (const file of await expandInput(ctx.cwd, input)) {
          const rel = path.relative(ctx.cwd, file);
          if (!rel.startsWith("..") && !path.isAbsolute(rel) && ig.ignores(rel)) continue;
          files.add(file);
        }
      }

      const linesOut: string[] = [];
      let matchCount = 0;
      let fileCount = 0;
      for (const file of files) {
        let text: string;
        try {
          text = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split(/\r?\n/);
        const emitted = new Set<number>();
        let fileHadMatch = false;
        for (let index = 0; index < lines.length; index++) {
          if (!regex.test(lines[index] ?? "")) continue;
          regex.lastIndex = 0;
          fileHadMatch = true;
          matchCount++;
          if (matchCount > maxResults) break;
          const lineNo = index + 1;
          for (const n of lineRanges(lineNo, lines.length, context)) {
            if (emitted.has(n)) continue;
            emitted.add(n);
            const mark = n === lineNo ? "*" : " ";
            linesOut.push(`${mark}${path.relative(ctx.cwd, file)}:${n}:${lines[n - 1] ?? ""}`);
          }
        }
        if (fileHadMatch) fileCount++;
        if (matchCount > maxResults) break;
      }

      if (matchCount === 0) {
        return { content: [{ type: "text", text: "No matches." }], details: { matches: 0, files: 0 } };
      }
      const truncated = matchCount > maxResults;
      const header = `${Math.min(matchCount, maxResults)} match${Math.min(matchCount, maxResults) === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}.`;
      return {
        content: [{ type: "text", text: `${header}\n${linesOut.join("\n")}` }],
        details: { matches: Math.min(matchCount, maxResults), files: fileCount, truncated },
      };
    },
  });
}
