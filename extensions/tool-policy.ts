import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// bash policy
// ---------------------------------------------------------------------------

// Shell command → the dedicated Pi tool that replaces it. A command is only
// blocked when its replacement is active in the session (pi.getActiveTools()),
// so the block message always names a tool the model really has — and when no
// replacement is registered, bash remains the legitimate way to run it.
// awk/sed are deliberately absent: their dedicated replacement (search) cannot
// perform in-place edits/transforms, so they stay legitimate bash commands
// (the specific `sed -n` line-range rule below still applies).
const REPLACEMENT_TOOLS: Record<string, string> = {
  // File viewing → read
  cat: "read",
  head: "read",
  tail: "read",
  less: "read",
  more: "read",
  // Content search → search
  grep: "search",
  rg: "search",
  ripgrep: "search",
  ag: "search",
  ack: "search",
  // Filename/glob lookup → find (fs-tools)
  find: "find",
  fd: "find",
  locate: "find",
  // Directory listing → ls (fs-tools)
  ls: "ls",
};

// Wrappers that execute a following word as a command, so the word after them
// is still in command position (`sudo cat`, `xargs ls`). Flags and leading
// environment assignments are skipped too. Over-skipping only risks false
// negatives (letting a shell `cat` through), which is the safe direction —
// false positives are what broke `aws s3 ls`.
const COMMAND_PREFIXES = new Set([
  "sudo",
  "doas",
  "nohup",
  "nice",
  "time",
  "env",
  "command",
  "exec",
  "timeout",
  "stdbuf",
  "strace",
  "watch",
  "xargs",
  "flock",
  "setsid",
]);

// Words in command position: the first non-flag, non-assignment, non-wrapper
// word of each simple command (segments split on shell separators). Arguments
// like the `ls` in `aws s3 ls` are never command words.
function commandWords(command: string): string[] {
  const words: string[] = [];
  for (const segment of command.split(/[;&|()\n`{}]/)) {
    for (const token of segment.trim().split(/\s+/)) {
      if (!token || token.startsWith("-")) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // env assignment
      if (COMMAND_PREFIXES.has(token)) continue;
      words.push(basename(token));
      break; // one command per segment
    }
  }
  return words;
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

// `bash -c "..."` / `sh -c '...'` (behind common wrappers and env assignments)
// runs the quoted payload as its own command, which would otherwise bypass
// command-position detection entirely. Extract every quoted -c payload so it
// is screened with the same rules as a top-level command. Unquoted payloads
// and exotic shells fall through un-screened — the safe direction.
function shellPayloads(command: string): string[] {
  const payloads: string[] = [];
  const re =
    /(?:^|[;&|]\s*|\n\s*|\(\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:sudo|doas|env|nohup|nice|time|timeout|stdbuf|strace|command|exec)\s+)*(?:[\w./-]+\/)?(?:bash|sh|dash|ash|zsh)\s+(?:-\S+\s+)*-c\s*(["'])([\s\S]*?)\1/g;
  for (const match of command.matchAll(re)) payloads.push(match[2] ?? "");
  return payloads;
}

// Every fd-2 redirect: `2>&1`, `2>/dev/null`, `2>>file`, plus the combined
// `&>` / `&>>` variants that send stdout and stderr together.
const STDERR_REDIRECT = /\b2>|&>>?/;

function bashViolation(command: string, activeTools: ReadonlySet<string>): string | undefined {
  for (const screened of [command, ...shellPayloads(command)]) {
    if (/\|\s*(head|tail)\b/.test(screened)) return "Do not pipe through head/tail; Pi already truncates tool output.";
    if (STDERR_REDIRECT.test(screened)) return "Do not redirect stderr; Pi already captures stdout and stderr.";
    if (/\bsed\s+-n\b/.test(screened)) return "Use read offsets/ranges instead of sed for line ranges.";
    for (const name of commandWords(screened)) {
      const replacement = REPLACEMENT_TOOLS[name];
      if (replacement && activeTools.has(replacement)) {
        return `Use the ${replacement} tool instead of shelling out to ${name}.`;
      }
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "bash") return;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const reason = bashViolation(command, new Set(pi.getActiveTools()));
    if (!reason) return;
    return { block: true, reason };
  });
}
