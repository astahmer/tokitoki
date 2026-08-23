/**
 * Rough per-model USD pricing per million tokens, used only when a harness
 * does not report cost itself. Estimates are flagged by callers.
 * Keys match on prefix (longest wins) so dated snapshots like
 * "claude-sonnet-4-5-20250929" resolve.
 */
interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

const PRICES: Array<[prefix: string, price: ModelPrice]> = [
  ["claude-opus", { inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75 }],
  ["claude-sonnet", { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 }],
  ["claude-haiku", { inputPerMtok: 0.8, outputPerMtok: 4, cacheReadPerMtok: 0.08, cacheWritePerMtok: 1 }],
  ["gpt-5", { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, cacheWritePerMtok: 0 }],
  ["gpt-4.1", { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 0 }],
  ["gpt-4o", { inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 1.25, cacheWritePerMtok: 0 }],
  ["o3", { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 0 }],
  ["o4-mini", { inputPerMtok: 1.1, outputPerMtok: 4.4, cacheReadPerMtok: 0.275, cacheWritePerMtok: 0 }],
  ["gemini-2.5-pro", { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.31, cacheWritePerMtok: 0 }],
  ["gemini-2.5-flash", { inputPerMtok: 0.3, outputPerMtok: 2.5, cacheReadPerMtok: 0.075, cacheWritePerMtok: 0 }],
];

const ZERO: ModelPrice = {
  inputPerMtok: 0,
  outputPerMtok: 0,
  cacheReadPerMtok: 0,
  cacheWritePerMtok: 0,
};

export function priceForModel(model: string): ModelPrice {
  const lower = model.toLowerCase();
  let best: [string, ModelPrice] | undefined;
  for (const entry of PRICES) {
    if (lower.startsWith(entry[0])) {
      if (best === undefined || entry[0].length > best[0].length) best = entry;
    }
  }
  return best !== undefined ? best[1] : ZERO;
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
