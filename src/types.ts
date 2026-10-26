/** Normalized usage event — the single currency of tokitoki. */
export interface UsageEvent {
  /** Native lineage proves this is an original request, not copied history. */
  originalUsage?: true;
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
  /** Uncached input; cache read/write buckets are separate and additive. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Token counters from the provider, or estimates of visible text. Absent on legacy events. */
  tokenSource?: "reported" | "estimated";
  tokenEstimationMethod?: "characters/4";
  /** Cost in USD when reported by the harness, else estimated. */
  costUsd?: number;
  /** Absent on legacy events; unpriced means no reliable amount is available. */
  costSource?: "reported" | "estimated" | "unpriced";
  projectDir?: string;
  sessionId?: string;
  /**
   * Tool/function that caused the request, when the harness records it:
   * "Edit", "bash:rg", "mcp__pencil__execute", ... Absent for plain
   * text/thinking turns and older events (pre tool-extraction).
   */
  tool?: string;
  /** Short user-facing description of the request, when the harness exposes it. */
  description?: string;
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
  /** Window length in minutes; 0 is legacy metadata for an unknown duration. */
  windowMinutes: number;
  /** Unix epoch seconds when the window resets. */
  resetsAtEpoch: number;
  bucketId?: string;
  windowId?: string;
  scope?: "session" | "daily" | "weekly" | "monthly" | "model" | "other";
  label?: string;
  model?: string;
  windowStart?: string;
  windowEnd?: string;
  observedAt?: string;
}

export interface QuotaSnapshot {
  /** Stable identity carried by the source event/session, never inferred from current auth. */
  accountId?: string;
  /** Meter identity, independent of the account and window duration. */
  limitId?: string;
  limitName?: string;
  /** Both window slots were explicitly serialized, including null removals. Absent means partial. */
  complete?: boolean;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string;
    /** Provider-reported expiry for purchased/banked reset credits. */
    expiresAt?: string;
  };
}

/** Provider quota observation, independent of a billable request. */
export interface QuotaObservationEvent {
  id: string;
  ts: string;
  provider: string;
  accountKey: string;
  sessionId?: string;
  quota: QuotaSnapshot;
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
