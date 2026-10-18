/**
 * One source of truth for how providers, harnesses, and upstream vendors are
 * named and drawn. Ids cover harnesses (claude-code, pi, …), quota sources
 * (zai, kimi, …), and vendors (anthropic, google, …); a vendor's own entry
 * carries its status page.
 */

export type StatusPageSource =
  | { kind: "statuspage"; url: string }
  | { kind: "google-workspace"; productId: string; url: string };

export interface ProviderInfo {
  displayName: string;
  /** Compact label for bar pills and tight rows. */
  shortName: string;
  /** Upstream vendor id; absent for routed harnesses whose vendor depends on the model. */
  vendor?: string;
  /** Routes to other vendors' models: `vendor` only applies when the model's maker is unknown. */
  gateway?: boolean;
  /** Material Symbols icon name used when no logo asset exists. */
  icon: string;
  /** Asset key under integrations/dms/tokitoki/assets/provider-logos/<logo>.svg. */
  logo?: string;
  statusPage?: StatusPageSource;
  /** Legacy upstream keys (saved strip/selection settings) that mean this vendor. */
  aliases?: string[];
}

const GEMINI_STATUS: StatusPageSource = {
  kind: "google-workspace",
  productId: "npdyhgECDJ6tB66MxXyo",
  url: "https://www.google.com/appsstatus/dashboard/products/npdyhgECDJ6tB66MxXyo/history",
};

export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderInfo>> = {
  // Vendors
  anthropic: {
    displayName: "Anthropic",
    shortName: "Claude",
    vendor: "anthropic",
    aliases: ["claude"],
    icon: "psychology",
    logo: "claude-code",
    statusPage: { kind: "statuspage", url: "https://status.claude.com" },
  },
  openai: {
    displayName: "OpenAI",
    shortName: "OpenAI",
    vendor: "openai",
    icon: "smart_toy",
    logo: "codex",
    statusPage: { kind: "statuspage", url: "https://status.openai.com" },
  },
  google: { displayName: "Google", shortName: "Gemini", vendor: "google", aliases: ["gemini"], icon: "auto_awesome", logo: "gemini-cli", statusPage: GEMINI_STATUS },
  github: {
    displayName: "GitHub",
    shortName: "Copilot",
    vendor: "github",
    aliases: ["copilot"],
    icon: "assistant",
    logo: "copilot",
    statusPage: { kind: "statuspage", url: "https://www.githubstatus.com" },
  },
  cursor: {
    displayName: "Cursor",
    shortName: "Cursor",
    vendor: "cursor",
    icon: "mouse",
    logo: "cursor",
    statusPage: { kind: "statuspage", url: "https://status.cursor.com" },
  },
  openrouter: { displayName: "OpenRouter", shortName: "OpenRouter", vendor: "openrouter", gateway: true, icon: "alt_route", logo: "openrouter" },
  opencode: { displayName: "OpenCode", shortName: "OpenCode", vendor: "opencode", gateway: true, icon: "code", logo: "opencode" },
  xai: { displayName: "xAI", shortName: "Grok", vendor: "xai", aliases: ["grok"], icon: "bolt", logo: "grok" },
  deepseek: { displayName: "DeepSeek", shortName: "DeepSeek", vendor: "deepseek", icon: "water", logo: "deepseek" },
  moonshot: { displayName: "Moonshot AI", shortName: "Kimi", vendor: "moonshot", aliases: ["kimi"], icon: "dark_mode", logo: "kimi" },
  zhipu: { displayName: "Z.ai", shortName: "Z.ai", vendor: "zhipu", aliases: ["zai"], icon: "hub" },
  minimax: { displayName: "MiniMax", shortName: "MiniMax", vendor: "minimax", icon: "hub" },
  mistral: { displayName: "Mistral", shortName: "Mistral", vendor: "mistral", icon: "air" },
  alibaba: { displayName: "Alibaba Qwen", shortName: "Qwen", vendor: "alibaba", icon: "hub" },
  meta: { displayName: "Meta", shortName: "Llama", vendor: "meta", icon: "hub" },
  commandcode: { displayName: "Command Code", shortName: "Command Code", vendor: "commandcode", gateway: true, icon: "code" },

  // Harnesses
  "claude-code": { displayName: "Claude Code", shortName: "Claude", vendor: "anthropic", icon: "psychology", logo: "claude-code" },
  codex: { displayName: "Codex", shortName: "Codex", vendor: "openai", icon: "smart_toy", logo: "codex" },
  opencodex: { displayName: "opencodex", shortName: "Codex", vendor: "openai", icon: "smart_toy", logo: "codex" },
  "gemini-cli": { displayName: "Gemini CLI", shortName: "Gemini", vendor: "google", icon: "auto_awesome", logo: "gemini-cli" },
  "antigravity-cli": { displayName: "Antigravity", shortName: "Antigravity", vendor: "google", icon: "rocket_launch", logo: "gemini-cli" },
  copilot: { displayName: "GitHub Copilot", shortName: "Copilot", vendor: "github", icon: "assistant", logo: "copilot" },
  grok: { displayName: "Grok", shortName: "Grok", vendor: "xai", icon: "bolt", logo: "grok" },
  "opencode-go": { displayName: "OpenCode Go", shortName: "OpenCode", vendor: "opencode", gateway: true, icon: "code", logo: "opencode" },
  pi: { displayName: "Pi", shortName: "Pi", icon: "terminal" },
  t3code: { displayName: "T3 Code", shortName: "T3", icon: "terminal" },
  aider: { displayName: "Aider", shortName: "Aider", icon: "terminal" },
  goose: { displayName: "Goose", shortName: "Goose", icon: "terminal" },
  amp: { displayName: "Amp", shortName: "Amp", icon: "terminal" },
  zed: { displayName: "Zed", shortName: "Zed", icon: "terminal" },

  // Quota sources
  zai: { displayName: "Z.ai", shortName: "Z.ai", vendor: "zhipu", icon: "hub" },
  kimi: { displayName: "Kimi Code", shortName: "Kimi", vendor: "moonshot", icon: "dark_mode", logo: "kimi" },
};

const titleCase = (value: string): string =>
  value.split(/[-_\s]+/).filter((part) => part.length > 0).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");

/** Registry entry, or a neutral fallback built from the raw id. */
export const providerInfo = (id: string): ProviderInfo =>
  PROVIDER_REGISTRY[id] ?? { displayName: titleCase(id) || "Unknown provider", shortName: titleCase(id) || "Unknown", icon: "terminal" };
