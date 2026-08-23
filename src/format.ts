/**
 * Human-readable formatting shared by report, chart, and pie.
 */
const TOKEN_TIERS: Array<[threshold: number, suffix: string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** Letter-suffixed counts: 1.71B, 23.7M, 92.8M, 3.9B, 812K, 999. */
export function humanCount(n: number): string {
  const abs = Math.abs(n);
  for (const [threshold, suffix] of TOKEN_TIERS) {
    if (abs >= threshold) {
      const scaled = n / threshold;
      return `${trimZeros(scaled.toFixed(2))}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/** Plain integer with thousands separators. */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Costs: full precision under $10 (2 decimals), no decimals at $10+ with
 * thousands separators — "$9.42", "$1,080".
 */
export function formatCost(usd: number): string {
  if (usd >= 10) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Cache share of prompt tokens: cacheRead / (input + cacheRead) * 100,
 * rounded to a whole percent; 0 when there is nothing cached.
 */
export function cachePct(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens;
  if (denom <= 0) return 0;
  return Math.round((cacheReadTokens / denom) * 100);
}

/** Fixed-width horizontal bar, e.g. ████████████░░░░. */
export function bar(fraction: number, width: number, fill = "█", empty = "░"): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return fill.repeat(filled) + empty.repeat(width - filled);
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Compact sparkline over a value series, normalized to its own max. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return SPARK_CHARS[0]!.repeat(values.length);
  return values
    .map((v) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * (SPARK_CHARS.length - 0.0001)))]!)
    .join("");
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
