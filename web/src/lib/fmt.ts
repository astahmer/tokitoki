/** Client-side mirrors of src/format.ts — keep in sync. */

const TIERS: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

export function humanCount(n: number): string {
  const abs = Math.abs(n);
  for (const [threshold, suffix] of TIERS) {
    if (abs >= threshold) {
      const scaled = n / threshold;
      return `${trimZeros(scaled.toFixed(2))}${suffix}`;
    }
  }
  return String(Math.round(n));
}

export function formatCost(usd: number): string {
  if (usd >= 10) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

export function cachePct(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens;
  if (denom <= 0) return 0;
  return Math.round((cacheReadTokens / denom) * 100);
}

export function totalTokens(row: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
