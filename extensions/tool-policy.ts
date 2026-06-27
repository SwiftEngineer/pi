import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const BLOCKED_COMMAND_WORDS: Record<string, true> = {
  cat: true,
  head: true,
  tail: true,
  less: true,
  more: true,
  ls: true,
  grep: true,
  rg: true,
  ripgrep: true,
  ag: true,
  ack: true,
  find: true,
  fd: true,
  locate: true,
  awk: true,
  sed: true,
};

function shellWords(command: string): string[] {
  const words: string[] = [];
  const re = /(?:^|[;&|(){}\s])([A-Za-z0-9_./-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) if (match[1]) words.push(match[1]);
  return words;
}

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

function bashViolation(command: string): string | undefined {
  if (/\|\s*(head|tail)\b/.test(command)) return "Do not pipe through head/tail; Pi already truncates tool output.";
  if (/\b2>\s*&\s*1\b|\b2>\s*\/dev\/null\b/.test(command)) return "Do not redirect stderr; Pi already captures stdout and stderr.";
  if (/\bsed\s+-n\b/.test(command)) return "Use read offsets/ranges instead of sed for line ranges.";
  for (const word of shellWords(command)) {
    const name = basename(word);
    if (BLOCKED_COMMAND_WORDS[name]) {
      return `Use the dedicated Pi tool instead of shelling out to ${name}.`;
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "bash") return;
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const reason = bashViolation(command);
    if (!reason) return;
    return { block: true, reason };
  });

}
