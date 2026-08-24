/** Normalized usage event — the single currency of tokitoki. */
export interface UsageEvent {
  /** Stable cross-machine dedupe key: `${provider}:${accountKey}:${sessionId}:${entryId}` */
  id: string;
  /** ISO-8601 timestamp */
  ts: string;
  machineId: string;
  provider: string;
  /**
   * Account attribution without secrets: API key hash prefix or a
   * subscription/account label (e.g. "codex:plus", "default").
   */
  accountKey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Cost in USD when reported by the harness, else estimated. */
  costUsd?: number;
  projectDir?: string;
  sessionId?: string;
  /**
   * Tool/function that caused the request, when the harness records it:
   * "Edit", "bash:rg", "mcp__pencil__execute", ... Absent for plain
   * text/thinking turns and older events (pre tool-extraction).
   */
  tool?: string;
  /** Embedded provider quota snapshot (codex rate_limits), when present. */
  quota?: QuotaSnapshot;
}

/**
 * Provider-embedded quota snapshot (real rate-limit data from the harness,
 * currently codex rollout `rate_limits`). Distinct from user-set plan caps:
 * this is what the provider itself reports.
 */
export interface QuotaWindow {
  /** Provider-reported share of the window consumed, 0–100. */
  usedPct: number;
  /** Window length in minutes (300 = 5h, 10080 = weekly, ...). */
  windowMinutes: number;
  /** Unix epoch seconds when the window resets. */
  resetsAtEpoch: number;
}

export interface QuotaSnapshot {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string };
}

/** Optional on UsageEvent — only providers with embedded quota set it. */
export interface UsageEventQuota {
  quota?: QuotaSnapshot;
}

/** True when the event carries all fields downstream code relies on. */
export function isValidUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.ts === "string" &&
    !Number.isNaN(Date.parse(e.ts)) &&
    typeof e.machineId === "string" &&
    typeof e.provider === "string" &&
    typeof e.accountKey === "string" &&
    typeof e.model === "string" &&
    typeof e.inputTokens === "number" &&
    typeof e.outputTokens === "number"
  );
}
