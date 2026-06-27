import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const sgPath = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "sg.cmd" : "sg");

const AstGrepParams = Type.Object({
  pat: Type.String({ description: "AST pattern. Metavariables are uppercase, e.g. $A and $$$ARGS." }),
  paths: Type.Array(Type.String(), { description: "Files, directories, or globs to search." }),
  lang: Type.Optional(Type.String({ description: "ast-grep language name such as ts, tsx, js, py, rust, go." })),
  skip: Type.Optional(Type.Number({ description: "Number of matches to skip before returning output." })),
});

const AstEditOp = Type.Object({
  pat: Type.String({ description: "AST pattern to replace." }),
  out: Type.String({ description: "Replacement template." }),
});

const AstEditParams = Type.Object({
  ops: Type.Array(AstEditOp, { description: "Rewrite operations to apply sequentially." }),
  paths: Type.Array(Type.String(), { description: "Files, directories, or globs to rewrite." }),
  lang: Type.Optional(Type.String({ description: "ast-grep language name such as ts, tsx, js, py, rust, go." })),
});

type AstGrepArgs = { pat: string; paths: string[]; lang?: string; skip?: number };
type AstEditArgs = { ops: { pat: string; out: string }[]; paths: string[]; lang?: string };
function execOptions(cwd: string, signal: AbortSignal | undefined): ExecOptions {
  const options: ExecOptions = { cwd, timeout: 120_000 };
  if (signal) options.signal = signal;
  return options;
}


function commonArgs(lang: string | undefined, paths: string[], json: boolean): string[] {
  const args = json ? ["run", "--json=compact", "--color", "never"] : ["run", "--color", "never"];
  if (lang) args.push("--lang", lang);
  args.push(...paths);
  return args;
}

function compactOutput(stdout: string, skip: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || "[]");
  } catch {
    return stdout || "No matches.";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "No matches.";
  const matches = parsed.slice(Math.max(0, skip));
  return JSON.stringify(matches, null, 2);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ast_grep",
    label: "AST Grep",
    description: "Search code structurally using ast-grep. Use when syntax shape matters more than raw text.",
    promptSnippet: "ast_grep — structural AST search across code.",
    promptGuidelines: [
      "Use ast_grep for syntax-aware code discovery and search for plain text only when structure is irrelevant.",
      "AST metavariables are uppercase whole nodes: $A for one node, $_ ignored one node, $$$A for zero-or-more nodes.",
    ],
    parameters: AstGrepParams,
    executionMode: "parallel",
    async execute(_toolCallId, params: AstGrepArgs, signal, _onUpdate, ctx) {
      const args = commonArgs(params.lang, params.paths, true);
      args.splice(1, 0, "--pattern", params.pat);
      const result = await pi.exec(sgPath, args, execOptions(ctx.cwd, signal));
      if (result.code !== 0) {
        return { content: [{ type: "text", text: result.stderr || result.stdout || `ast-grep exited ${result.code}` }], details: { code: result.code } };
      }
      return { content: [{ type: "text", text: compactOutput(result.stdout, params.skip ?? 0) }], details: { code: result.code } };
    },
  });

  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description: "Rewrite code structurally using ast-grep rewrite patterns. Use for codemods where text replacement is unsafe.",
    promptSnippet: "ast_edit — structural AST rewrites/codemods.",
    promptGuidelines: ["Use ast_edit for syntax-aware rewrites; use edit for small local text changes."],
    parameters: AstEditParams,
    executionMode: "sequential",
    async execute(_toolCallId, params: AstEditArgs, signal, _onUpdate, ctx) {
      const outputs: string[] = [];
      for (const op of params.ops) {
        const args = commonArgs(params.lang, params.paths, false);
        args.splice(1, 0, "--pattern", op.pat, "--rewrite", op.out, "--update-all");
        const result = await pi.exec(sgPath, args, execOptions(ctx.cwd, signal));
        outputs.push(result.stdout.trim() || result.stderr.trim() || `rewrite exited ${result.code}`);
        if (result.code !== 0) {
          return { content: [{ type: "text", text: outputs.join("\n\n") }], details: { code: result.code }, terminate: true };
        }
      }
      return { content: [{ type: "text", text: outputs.join("\n\n") || "No rewrites reported." }], details: { code: 0 } };
    },
  });
}
