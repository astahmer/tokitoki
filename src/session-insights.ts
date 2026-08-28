/** Small, deterministic insights shared by web, CLI and menubar session views. */

export interface CacheSample {
  ts: string;
  inputTokens: number;
  cacheReadTokens: number;
}

export interface CacheDurationEstimate {
  estimatedSeconds: number | null;
  confidence: "low" | "medium" | "high";
  samples: number;
  busts: number;
  lastBustAt: string | null;
}

/**
 * Estimate a cache lifetime from request-level cache-read continuity.
 * A bust is a sharp drop from a warm cache to a cold request. We deliberately
 * return null when there is not enough evidence instead of inventing a TTL.
 */
export function estimateCacheDuration(samples: readonly CacheSample[]): CacheDurationEstimate {
  const ordered = samples
    .map((sample) => ({
      ...sample,
      time: Date.parse(sample.ts),
      ratio: sample.cacheReadTokens / Math.max(1, sample.inputTokens + sample.cacheReadTokens),
    }))
    .filter((sample) => Number.isFinite(sample.time))
    .sort((a, b) => a.time - b.time);
  const bustTimes: number[] = [];
  let warm = false;
  for (const sample of ordered) {
    if (sample.ratio >= 0.35 && sample.cacheReadTokens > 0) {
      warm = true;
      continue;
    }
    if (!warm || sample.ratio > 0.18) continue;
    const previous = bustTimes.at(-1);
    // A single cold request can be a transient provider response; collapse
    // nearby drops so it cannot make the estimate look artificially short.
    if (previous === undefined || sample.time - previous >= 60_000) bustTimes.push(sample.time);
    warm = false;
  }
  const intervals = bustTimes.slice(1).map((time, i) => time - bustTimes[i]!).filter((n) => n > 0);
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const median = sortedIntervals.length === 0
    ? null
    : sortedIntervals[Math.floor(sortedIntervals.length / 2)]!;
  const confidence = sortedIntervals.length >= 3 ? "high" : sortedIntervals.length >= 1 ? "medium" : "low";
  return {
    estimatedSeconds: median === null ? null : Math.round(median / 1000),
    confidence,
    samples: ordered.length,
    busts: bustTimes.length,
    lastBustAt: bustTimes.length > 0 ? new Date(bustTimes.at(-1)!).toISOString() : null,
  };
}

function compact(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Human-readable event label used by chart hover cards. */
export function describeSessionEvent(
  event: { tool?: string | null; model: string },
  index: number,
  conversationBody?: string | null,
): string {
  if (event.tool !== undefined && event.tool !== null && event.tool.trim().length > 0) {
    return `tool call · ${compact(event.tool, 96)}`;
  }
  const messages = (conversationBody ?? "")
    .split(/\n{2,}/)
    .map((part) => compact(part))
    .filter(Boolean);
  const excerpt = messages[index] ?? messages[index % Math.max(1, messages.length)] ?? "";
  if (excerpt.length > 0) return `message excerpt · ${excerpt}`;
  return `model response · ${compact(event.model, 96)} · request ${index + 1}`;
}
