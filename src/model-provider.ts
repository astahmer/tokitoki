/**
 * Best-effort upstream provider attribution for a model name.
 *
 * Harness and provider are intentionally different axes: `pi`, `codex`, and
 * `claude-code` are where usage was recorded, while `openai`, `anthropic`,
 * `openrouter`, etc. describe the model service when the local data makes
 * that distinction possible.
 */
export function modelProvider(model: string, harness = "", accountKey = ""): string {
  const value = model.trim().toLowerCase();
  const prefix = value.split("/", 1)[0] ?? "";
  const explicit: Record<string, string> = {
    openrouter: "openrouter",
    opencode: "opencode",
    "opencode-go": "opencode",
    "codex-work": "openai",
    "codex-perso": "openai",
    anthropic: "anthropic",
    openai: "openai",
    google: "google",
    gemini: "google",
    xai: "xai",
    deepseek: "deepseek",
    minimax: "minimax",
    moonshot: "moonshot",
    kimi: "moonshot",
    zhipu: "zhipu",
    glm: "zhipu",
  };
  // Gateway prefixes identify the routing service directly. Other prefixes
  // (for example anthropic/...) can still be wrapped by an OpenRouter or
  // OpenCode account, so let account identity win for those.
  if (prefix === "openrouter" || prefix === "opencode" || prefix === "opencode-go") {
    return explicit[prefix]!;
  }

  const account = accountKey.toLowerCase();
  if (account.includes("openrouter")) return "openrouter";
  if (account.includes("opencode")) return "opencode";
  if (account.includes("codex") || harness === "codex") return "openai";

  if (explicit[prefix] !== undefined) return explicit[prefix]!;

  if (value.includes("claude")) return "anthropic";
  if (value.includes("gemini")) return "google";
  if (value.includes("grok")) return "xai";
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("minimax")) return "minimax";
  if (value.includes("kimi")) return "moonshot";
  if (value.includes("glm")) return "zhipu";
  if (value.startsWith("gpt-") || value.startsWith("o1") || value.startsWith("o3") || value.startsWith("o4")) {
    return "openai";
  }
  return "other";
}
