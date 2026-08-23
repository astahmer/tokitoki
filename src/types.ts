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
