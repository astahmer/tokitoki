import { accountAliases } from "./config.ts";
import { PROVIDER_REGISTRY } from "./provider-registry.ts";

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
  const aliases = accountAliases();
  const aliased = aliases.get(account) ?? (value.includes("/") ? aliases.get(prefix) : undefined);
  if (aliased !== undefined) return aliased;
  if (account.includes("openrouter")) return "openrouter";
  if (account.includes("opencode")) return "opencode";
  if (account.includes("openai")) return "openai";
  if (account.includes("codex") || harness === "codex" || prefix.includes("codex")) return "openai";

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

/** Registry vendor for ids that only ever talk to their own vendor (claude-code, codex, zai, …). */
const directVendor = (id: string): string | undefined => {
  const info = PROVIDER_REGISTRY[id];
  return info?.gateway === true ? undefined : info?.vendor;
};

const GATEWAY_PREFIXES = new Set(Object.keys(PROVIDER_REGISTRY).filter((id) => PROVIDER_REGISTRY[id]?.gateway === true));

const MODEL_PREFIX_VENDORS: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  gemini: "google",
  "google-vertex": "google",
  xai: "xai",
  "x-ai": "xai",
  deepseek: "deepseek",
  minimax: "minimax",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  kimi: "moonshot",
  zhipu: "zhipu",
  "z-ai": "zhipu",
  zai: "zhipu",
  glm: "zhipu",
  mistral: "mistral",
  mistralai: "mistral",
  qwen: "alibaba",
  alibaba: "alibaba",
  "meta-llama": "meta",
  meta: "meta",
};

const MODEL_NAME_VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/claude|opus|sonnet|haiku/, "anthropic"],
  [/^(gpt|o1|o3|o4|chatgpt)|codex/, "openai"],
  [/gemini|gemma/, "google"],
  [/grok/, "xai"],
  [/deepseek/, "deepseek"],
  [/minimax/, "minimax"],
  [/kimi|moonshot/, "moonshot"],
  [/glm/, "zhipu"],
  [/mistral|codestral|devstral/, "mistral"],
  [/qwen/, "alibaba"],
  [/llama/, "meta"],
];

const vendorFromModel = (model: string): string | undefined => {
  const segments = model.trim().toLowerCase().split("/").filter((segment) => segment.length > 0);
  while (segments.length > 1 && GATEWAY_PREFIXES.has(segments[0]!)) segments.shift();
  if (segments.length > 1) {
    const prefixed = MODEL_PREFIX_VENDORS[segments[0]!];
    if (prefixed !== undefined) return prefixed;
  }
  const name = segments.at(-1) ?? "";
  return MODEL_NAME_VENDORS.find(([pattern]) => pattern.test(name))?.[1];
};

/**
 * Vendor named by an explicit `gateway/…` or `vendor/…` model prefix. This
 * outranks a direct harness: codex pointed at `opencode-go/deepseek-…` bills
 * DeepSeek through OpenCode, not OpenAI.
 */
const explicitModelVendor = (model: string): string | undefined => {
  const segments = model.trim().toLowerCase().split("/").filter((segment) => segment.length > 0);
  const prefix = segments[0];
  if (prefix === undefined || segments.length < 2) return undefined;
  if (GATEWAY_PREFIXES.has(prefix)) return vendorFromModel(model) ?? PROVIDER_REGISTRY[prefix]?.vendor;
  return MODEL_PREFIX_VENDORS[prefix];
};

/**
 * Upstream vendor (anthropic, openai, google, …) for one usage row or quota
 * account. An explicit model prefix wins, then direct harnesses map to their
 * registry vendor; routed harnesses (pi, opencode, t3code, …) use the model's
 * vendor, then the account's routing service when the model is unrecognizable.
 */
export const vendorFor = (input: { harness: string; model?: string; accountKey?: string }): string => {
  const explicit = input.model === undefined ? undefined : explicitModelVendor(input.model);
  if (explicit !== undefined) return explicit;
  const direct = directVendor(input.harness);
  if (direct !== undefined) return direct;
  const fromModel = input.model === undefined ? undefined : vendorFromModel(input.model);
  if (fromModel !== undefined) return fromModel;
  const routed = modelProvider(input.model ?? "", input.harness, input.accountKey ?? "");
  if (routed !== "other") return routed;
  // Routed harness backends are often named after the upstream harness (t3code's `claudeAgent`, `codex`, `cursor`).
  const account = (input.accountKey ?? "").toLowerCase();
  const fromAccount = account.length > 0 ? directVendor(account) ?? vendorFromModel(account) : undefined;
  return fromAccount ?? PROVIDER_REGISTRY[input.harness]?.vendor ?? "other";
};

/**
 * Vendor for an account card (harness/quota id + account key). Same mapping as
 * `vendorFor`, but an unattributable routed account keeps its raw id so cards
 * from unrelated harnesses never merge into one "other" group.
 */
export const vendorForProvider = (input: { provider: string; accountKey?: string }): string => {
  const vendor = vendorFor({ harness: input.provider, ...(input.accountKey !== undefined ? { accountKey: input.accountKey } : {}) });
  return vendor === "other" ? input.provider : vendor;
};
