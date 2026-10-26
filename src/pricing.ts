import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { UsageEvent } from "./types.ts";
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
  inputPerMtok?: number;
  outputPerMtok?: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
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

const cachedRate = z.number().finite().nonnegative().optional();
const pricingCacheSchema = z.object({
  formatVersion: z.literal(2),
  fetchedAt: z.number().finite().nonnegative(),
  models: z.record(z.string(), z.object({
    inputPerMtok: cachedRate, outputPerMtok: cachedRate,
    cacheReadPerMtok: cachedRate, cacheWritePerMtok: cachedRate,
  })),
  source: z.string().optional(),
});
type CacheFile = z.infer<typeof pricingCacheSchema>;

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
    if (previous === undefined) {
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
      if ([c.input, c.output, c.cache_read, c.cache_write].some(value =>
        value !== undefined && finiteCost(value) === undefined)) continue;
      const input = finiteCost(c.input);
      const output = finiteCost(c.output);
      if (input === undefined && output === undefined) continue;
      const price: ModelPrice = {
        inputPerMtok: input,
        outputPerMtok: output,
        cacheReadPerMtok: finiteCost(c.cache_read),
        cacheWritePerMtok: finiteCost(c.cache_write),
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
    const fields = [e.input_cost_per_token, e.output_cost_per_token,
      e.cache_read_input_token_cost, e.cache_creation_input_token_cost];
    if (fields.some(value => value !== undefined && finiteCost(value) === undefined)) continue;
    const perMillion = (v: unknown): number | undefined => {
      const value = finiteCost(v);
      return value === undefined ? undefined : finiteCost(value * 1_000_000);
    };
    out[name.toLowerCase()] = {
      inputPerMtok: perMillion(e.input_cost_per_token),
      outputPerMtok: perMillion(e.output_cost_per_token),
      cacheReadPerMtok: perMillion(e.cache_read_input_token_cost),
      cacheWritePerMtok: perMillion(e.cache_creation_input_token_cost),
    };
  }
  return out;
}

/** Only a calendar-date snapshot suffix may extend an explicitly priced name. */
function isSafeVersionSuffix(rest: string): boolean {
  if (rest.length === 0) return true;
  const date = /^-(20\d{2})-?(\d{2})-?(\d{2})$/.exec(rest);
  if (date === null) return false;
  const iso = date[1] + "-" + date[2] + "-" + date[3];
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

/** Exact names win; strip provider paths, then allow calendar-date snapshots. */
export function matchPrice(table: PricingTable, model: string): ModelPrice | undefined {
  const lower = model.trim().toLowerCase();
  // Keep provider-qualified prices ahead of bare aliases.
  const segments = lower.split("/");
  const candidates = segments.map((_, index) => segments.slice(index).join("/"));
  for (const candidate of candidates) {
    if (Object.hasOwn(table, candidate) && table[candidate] !== undefined) return table[candidate];
  }
  for (const candidate of candidates) {
    const aliases = canonicalModelAliases(candidate);
    let best: ModelPrice | undefined;
    let bestLength = -1;
    for (const [key, price] of Object.entries(table)) {
      // Qualified keys must match their provider, never become bare aliases.
      if (key.includes("/") && !candidate.includes("/")) continue;
      for (const normalizedKey of canonicalModelAliases(key)) {
        if (aliases.some(alias => alias.startsWith(normalizedKey) &&
          isSafeVersionSuffix(alias.slice(normalizedKey.length))) && normalizedKey.length > bestLength) {
          best = price;
          bestLength = normalizedKey.length;
        }
      }
    }
    if (best !== undefined) return best;
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
    // Older caches filled missing rates with zero, losing the free/unknown distinction.
    const parsed = pricingCacheSchema.safeParse(JSON.parse(fs.readFileSync(pricingCachePath(), "utf8")));
    if (parsed.success) {
      loadedTable = parsed.data.models;
      // Migrate older LiteLLM caches to Models.dev immediately; otherwise a
      // still-fresh cache would hide the new source until the normal TTL.
      if (parsed.data.source !== MODELS_DEV_URL || Date.now() - parsed.data.fetchedAt > TTL_MS) void refreshPricing();
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
      const payload: CacheFile = { formatVersion: 2, fetchedAt: Date.now(), models: table, source: url };
      fs.writeFileSync(pricingCachePath(), JSON.stringify(payload));
      return true;
    } catch {
      // Try the fallback source before retaining the existing cache.
    }
  }
  return false; // offline: keep whatever we had (cache → embedded)
}

/** Test seam: force a table without touching the filesystem/network. */
export function setTableForTests(table: PricingTable | null): void {
  loadedTable = table;
}

export function priceForModel(model: string): ModelPrice | undefined {
  const price = matchPrice(activeTable(), model);
  if (price !== undefined) return price;
  // Fallback to embedded even when a live table is loaded — it may know
  // models the fresh upstream file dropped.
  const embedded = matchPrice(EMBEDDED, model);
  if (embedded === undefined && !warnedUnmatched.has(model)) {
    warnedUnmatched.add(model);
    console.error(`\x1b[2mtokitoki: no pricing data for '${model}' — cost unavailable\x1b[0m`);
  }
  return embedded;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Token buckets are disjoint: inputTokens is uncached input for pricing. */
export function estimateCost(model: string, tokens: TokenCounts): number | undefined {
  // Runtime validation matters: provider payloads are not guaranteed by TS.
  const counts = [tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheWriteTokens];
  if (!counts.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
  const p = priceForModel(model);
  if (p === undefined) return undefined;
  const rates = [p.inputPerMtok, p.outputPerMtok, p.cacheReadPerMtok, p.cacheWritePerMtok];
  let cost = 0;
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index]!;
    if (count === 0) continue;
    const rate = finiteCost(rates[index]);
    // Missing consumed classes are unknown, not free.
    if (rate === undefined) return undefined;
    cost += (count / 1e6) * rate;
  }
  return finiteCost(cost);
}

export interface UsageCost {
  costUsd?: number;
  costSource: NonNullable<UsageEvent["costSource"]>;
}

/** A valid harness-reported amount, including zero, takes precedence. */
export function resolveUsageCost(input: {
  model: string;
  tokens: TokenCounts;
  reportedCost?: unknown;
}): UsageCost {
  const reported = finiteCost(input.reportedCost);
  if (reported !== undefined) return { costUsd: reported, costSource: "reported" };
  const estimated = estimateCost(input.model, input.tokens);
  return estimated === undefined
    ? { costSource: "unpriced" }
    : { costUsd: estimated, costSource: "estimated" };
}

/** Chars-per-token used only where a store never records real counts (Cursor, T3 Code). */
const CHARS_PER_TOKEN = 4;

/** Rough token count from message length, for stores with no real token data. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

initFromCache();
