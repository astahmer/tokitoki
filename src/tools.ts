/**
 * Tool-level attribution helpers ("every dollar traced to whatever put the
 * tokens in context" — see github.com/HerringtonDarkholme/token-cost).
 *
 * Extraction rules per provider:
 * - claude-code: assistant message content blocks type:"tool_use" carry the
 *   tool name on the same message that reports usage. The Bash tool's command
 *   is collapsed to its first word (`Bash` → `rg`, `cargo`, ...).
 * - codex: response_item payloads with custom_tool_call/function_call names,
 *   plus CommandExecution items. `tools.exec_command({"cmd":"..."})` collapses
 *   to the first word of cmd.
 * - pi: assistant message content blocks type:"toolCall" w/ name; bash calls
 *   collapse to the command's first word.
 */

/** First meaningful word of a shell command line ("rg foo" → "rg"). */
export function firstCommandWord(command: string | undefined): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (trimmed.length === 0) return undefined;
  // Skip env assignments and flags: FOO=bar rg -l x → rg
  for (const token of trimmed.split(/\s+/)) {
    if (token.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token.startsWith("-")) continue;
    return token.slice(0, 40);
  }
  return trimmed.split(/\s+/)[0]?.slice(0, 40);
}

/**
 * Collapse a shell-running tool call to `shell:<first-word>` so attribution
 * answers "which commands burned the tokens" instead of a useless "Bash".
 */
export function shellToolName(command: unknown): string {
  const word = typeof command === "string" ? firstCommandWord(command) : undefined;
  return word === undefined ? "shell" : `shell:${word}`;
}

/**
 * Codex unified-exec calls embed the real command in a JS one-liner:
 *   const r = await tools.exec_command({"cmd":"rtk sed -n ..."})
 *   const r = await tools.codex_app__read_thread({threadId:...})
 * Returns undefined when the shape is unrecognized.
 */
export function extractCodexToolName(name: string, input: string): string | undefined {
  if (name !== "exec") return name || undefined;
  const match = /tools\.([A-Za-z0-9_]+)\s*\(\s*(\{)/.exec(input);
  if (match === null) return "exec";
  const fn = match[1];
  if (fn !== "exec_command") return fn;
  const cmdMatch = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (cmdMatch !== null) {
    let cmd = cmdMatch[1];
    try {
      cmd = JSON.parse(`"${cmdMatch[1]}"`) as string;
    } catch {
      // keep raw escape sequence form
    }
    const word = firstCommandWord(cmd);
    if (word !== undefined) return `shell:${word}`;
  }
  return "exec";
}

/**
 * Display rollup for the tool dimension: MCP namespaced tools collapse to
 * their server (`mcp__pencil__execute` → `mcp:pencil`).
 */
export function formatToolName(tool: string): string {
  if (tool.startsWith("mcp__")) {
    const rest = tool.slice(5);
    const sep = rest.indexOf("__");
    if (sep > 0) return `mcp:${rest.slice(0, sep)}`;
    return `mcp:${rest}`;
  }
  return tool;
}
