import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./store.ts";

/**
 * Per-model USD pricing per million tokens, used only when a harness does not
 * report cost itself. Estimates are flagged by callers.
 *
 * Live table: fetched from Models.dev's community-maintained catalog and
 * cached under the data dir with a 7-day TTL. LiteLLM remains a live fallback
 * because no catalog covers every provider alias used by local harnesses.
 * The embedded snapshot below is the offline fallback.
 */
export interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

export type PricingTable = Record<string, ModelPrice>;

const EMBEDDED: PricingTable = {
  "claude-opus": { inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75 },
  "claude-sonnet": { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 },
  "claude-haiku": { inputPerMtok: 0.8, outputPerMtok: 4, cacheReadPerMtok: 0.08, cacheWritePerMtok: 1 },
  "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, cacheWritePerMtok: 0 },
  "gpt-4.1": { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 0 },
  "gpt-4o": { inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 1.25, cacheWritePerMtok: 0 },
  o3: { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 0 },
  "o4-mini": { inputPerMtok: 1.1, outputPerMtok: 4.4, cacheReadPerMtok: 0.275, cacheWritePerMtok: 0 },
  "gemini-2.5-pro": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.31, cacheWritePerMtok: 0 },
  "gemini-2.5-flash": { inputPerMtok: 0.3, outputPerMtok: 2.5, cacheReadPerMtok: 0.075, cacheWritePerMtok: 0 },
};

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 7 * 24 * 3600_000;

function pricingCachePath(): string {
  return path.join(dataDir(), "pricing.json");
}

interface CacheFile {
  fetchedAt: number;
  /** model name → per-Mtok prices */
  models: PricingTable;
  source?: string;
}

function finiteCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function canonicalModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function canonicalModelAliases(value: string): string[] {
  const canonical = canonicalModelName(value);
  return canonical.startsWith("claude-")
    ? [canonical, canonical.slice("claude-".length)]
    : [canonical];
}

/** Convert Models.dev's per-Mtok catalog into the pricing shape used here. */
export function buildModelsDevTable(raw: unknown): PricingTable {
  const out: PricingTable = {};
  if (typeof raw !== "object" || raw === null) return out;

  const add = (key: string, price: ModelPrice): void => {
    const normalized = key.trim().toLowerCase();
    if (normalized.length === 0) return;
    const previous = out[normalized];
    // Keep the first priced entry for a bare alias. Provider-qualified keys
    // remain available when two providers publish different prices.
    if (previous === undefined || (previous.inputPerMtok === 0 && previous.outputPerMtok === 0)) {
      out[normalized] = price;
    }
  };

  for (const [provider, providerValue] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof providerValue !== "object" || providerValue === null) continue;
    const models = (providerValue as Record<string, unknown>).models;
    if (typeof models !== "object" || models === null) continue;
    for (const [modelId, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (typeof modelValue !== "object" || modelValue === null) continue;
      const cost = (modelValue as Record<string, unknown>).cost;
      if (typeof cost !== "object" || cost === null) continue;
      const c = cost as Record<string, unknown>;
      const input = finiteCost(c.input);
      const output = finiteCost(c.output);
      if (input === undefined && output === undefined) continue;
      const price: ModelPrice = {
        inputPerMtok: input ?? 0,
        outputPerMtok: output ?? 0,
        cacheReadPerMtok: finiteCost(c.cache_read) ?? 0,
        cacheWritePerMtok: finiteCost(c.cache_write) ?? 0,
      };
      add(`${provider}/${modelId}`, price);
      add(modelId, price);
      // Harness logs often keep only the final path segment, e.g. a provider
      // records `grok-4.5` while Models.dev uses `x-ai/grok-4.5`.
      const basename = modelId.split("/").at(-1);
      if (basename !== undefined) {
        add(basename, price);
        const canonical = canonicalModelName(basename);
        add(canonical, price);
        // OpenCode and similar logs sometimes omit the vendor family prefix
        // (`sonnet-4.5` rather than `claude-sonnet-4-5`).
        if (canonical.startsWith("claude-")) add(canonical.slice("claude-".length), price);
      }
    }
  }
  return out;
}

/** Map LiteLLM's per-token fields to our per-Mtok shape. Pure + testable. */
export function buildLiteLlmTable(raw: unknown): PricingTable {
  const out: PricingTable = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (name === ".status" || typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    // Skip non-completion rows (embeddings/search return no token pricing we use)
    if (e.input_cost_per_token === undefined && e.output_cost_per_token === undefined) continue;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    out[name.toLowerCase()] = {
      inputPerMtok: num(e.input_cost_per_token) * 1_000_000,
      outputPerMtok: num(e.output_cost_per_token) * 1_000_000,
      cacheReadPerMtok: num(e.cache_read_input_token_cost) * 1_000_000,
      cacheWritePerMtok: num(e.cache_creation_input_token_cost) * 1_000_000,
    };
  }
  return out;
}

/**
 * A prefix match is only safe when the leftover suffix looks like
 * version/date metadata (an optional separator then a digit, e.g.
 * "-20250929" or "-4-5"), not a letter — a letter starts a genuinely
 * different model-tier name ("o3" + "-mini" is a distinct, separately
 * priced model, not "o3 plus some suffix"), which a plain
 * `str.startsWith(key)` can't otherwise distinguish from a dated snapshot.
 */
function isSafeVersionSuffix(rest: string): boolean {
  return rest.length === 0 || /^[-._]?\d/.test(rest);
}

/** Exact → longest-prefix → substring match on the lowercased model name. */
export function matchPrice(table: PricingTable, model: string): ModelPrice | undefined {
  const lower = model.toLowerCase();
  if (table[lower] !== undefined) return table[lower]!;
  const canonical = canonicalModelName(model);
  for (const alias of canonicalModelAliases(model)) {
    if (table[alias] !== undefined) return table[alias]!;
  }
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (!lower.startsWith(key) || !isSafeVersionSuffix(lower.slice(key.length))) continue;
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey !== undefined) return table[bestKey]!;
  let bestCanonicalKey: string | undefined;
  let bestCanonicalLength = 0;
  for (const key of Object.keys(table)) {
    for (const normalizedKey of canonicalModelAliases(key)) {
      if (!canonical.startsWith(normalizedKey) || !isSafeVersionSuffix(canonical.slice(normalizedKey.length))) continue;
      if (normalizedKey.length > bestCanonicalLength) {
        bestCanonicalKey = key;
        bestCanonicalLength = normalizedKey.length;
      }
    }
  }
  if (bestCanonicalKey !== undefined) return table[bestCanonicalKey]!;
  // Substring fallback so things like "accounts/.../gemini-2.5-pro" or
  // "openrouter/gpt-4o" still resolve.
  for (const key of Object.keys(table)) {
    if (key.length >= 3 && lower.includes(key)) return table[key]!;
  }
  return undefined;
}

const warnedUnmatched = new Set<string>();

function activeTable(): PricingTable {
  return loadedTable ?? EMBEDDED;
}

let loadedTable: PricingTable | null = null;
let refreshStarted = false;

/** Sync-load cached pricing at startup; async refresh only when stale. */
function initFromCache(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(pricingCachePath(), "utf8")) as CacheFile;
    if (parsed.models !== undefined && typeof parsed.models === "object") {
      loadedTable = parsed.models;
      // Migrate older LiteLLM caches to Models.dev immediately; otherwise a
      // still-fresh cache would hide the new source until the normal TTL.
      if (parsed.source !== MODELS_DEV_URL || Date.now() - parsed.fetchedAt > TTL_MS) void refreshPricing();
      return;
    }
  } catch {
    /* no cache yet */
  }
  void refreshPricing(); // throttled internally
}

const ATTEMPT_PATH = () => path.join(dataDir(), "pricing.last-attempt");
const RETRY_MS = 3600_000;

/** Throttle so an offline machine doesn't fetch on every invocation. */
function shouldAttempt(now = Date.now()): boolean {
  try {
    return now - Number(fs.readFileSync(ATTEMPT_PATH(), "utf8")) > RETRY_MS;
  } catch {
    return true;
  }
}

function markAttempt(now = Date.now()): void {
  try {
    fs.mkdirSync(path.dirname(ATTEMPT_PATH()), { recursive: true });
    fs.writeFileSync(ATTEMPT_PATH(), String(now));
  } catch {
    /* best effort */
  }
}

/** Fetch live pricing into the cache; Models.dev is primary, LiteLLM fallback. */
export async function refreshPricing(force = false): Promise<boolean> {
  if (!force && !shouldAttempt()) return false;
  markAttempt();
  const sources: Array<[string, (raw: unknown) => PricingTable]> = [
    [MODELS_DEV_URL, buildModelsDevTable],
    [LITELLM_URL, buildLiteLlmTable],
  ];
  for (const [url, build] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const table = build(await res.json());
      if (Object.keys(table).length < 50) continue; // implausible payload
      loadedTable = table;
      fs.mkdirSync(path.dirname(pricingCachePath()), { recursive: true });
      const payload: CacheFile = { fetchedAt: Date.now(), models: table, source: url };
      fs.writeFileSync(pricingCachePath(), JSON.stringify(payload));
      return true;
    } catch {
      // Try the fallback source before retaining the existing cache.
    }
  }
  return false; // offline: keep whatever we had (cache → embedded)
}

const ZERO: ModelPrice = {
  inputPerMtok: 0,
  outputPerMtok: 0,
  cacheReadPerMtok: 0,
  cacheWritePerMtok: 0,
};

/** Test seam: force a table without touching the filesystem/network. */
export function setTableForTests(table: PricingTable): void {
  loadedTable = table;
}

export function priceForModel(model: string): ModelPrice {
  const price = matchPrice(activeTable(), model);
  if (price !== undefined) return price;
  // Fallback to embedded even when a live table is loaded — it may know
  // models the fresh upstream file dropped.
  const embedded = matchPrice(EMBEDDED, model);
  if (embedded === undefined && !warnedUnmatched.has(model)) {
    warnedUnmatched.add(model);
    console.error(`\x1b[2mtokitoki: no pricing data for '${model}' — estimating as $0\x1b[0m`);
  }
  return embedded ?? ZERO;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function estimateCost(model: string, tokens: TokenCounts): number {
  const p = priceForModel(model);
  return (
    (tokens.inputTokens / 1e6) * p.inputPerMtok +
    (tokens.outputTokens / 1e6) * p.outputPerMtok +
    (tokens.cacheReadTokens / 1e6) * p.cacheReadPerMtok +
    (tokens.cacheWriteTokens / 1e6) * p.cacheWritePerMtok
  );
}

/** Chars-per-token used only where a store never records real counts (Cursor, T3 Code). */
const CHARS_PER_TOKEN = 4;

/** Rough token count from message length, for stores with no real token data. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

initFromCache();
