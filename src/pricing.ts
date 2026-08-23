import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./store.ts";

/**
 * Per-model USD pricing per million tokens, used only when a harness does not
 * report cost itself. Estimates are flagged by callers.
 *
 * Live table: fetched from LiteLLM's community-maintained pricing JSON and
 * cached under the data dir with a 7-day TTL. The embedded snapshot below is
 * the offline fallback (and the seed when no cache exists yet).
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

/** Exact → longest-prefix → substring match on the lowercased model name. */
export function matchPrice(table: PricingTable, model: string): ModelPrice | undefined {
  const lower = model.toLowerCase();
  if (table[lower] !== undefined) return table[lower]!;
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (!lower.startsWith(key)) continue;
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey !== undefined) return table[bestKey]!;
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
      if (Date.now() - parsed.fetchedAt > TTL_MS) void refreshPricing();
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

/** Fetch LiteLLM's pricing JSON into the cache; swaps the live table in. Never throws. */
export async function refreshPricing(force = false): Promise<boolean> {
  if (!force && !shouldAttempt()) return false;
  markAttempt();
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const table = buildLiteLlmTable(await res.json());
    if (Object.keys(table).length < 50) return false; // implausible payload
    loadedTable = table;
    fs.mkdirSync(path.dirname(pricingCachePath()), { recursive: true });
    const payload: CacheFile = { fetchedAt: Date.now(), models: table };
    fs.writeFileSync(pricingCachePath(), JSON.stringify(payload));
    return true;
  } catch {
    return false; // offline: keep whatever we had (cache → embedded)
  }
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

initFromCache();
