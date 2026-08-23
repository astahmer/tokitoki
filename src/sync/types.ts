import type { UsageEvent } from "../types.ts";

/**
 * Pluggable cross-machine transport for usage events.
 *
 * Contract:
 * - `pull()` yields raw JSONL lines (one JSON event per line) contributed by
 *   OTHER machines. Lines are validated downstream before entering the local
 *   store — adapters may yield liberally, invalid lines are skipped there.
 * - `push()` publishes this machine's lines. Adapters must be idempotent:
 *   pushing the same lines twice must not duplicate anything remotely.
 * - Adapters never touch the local events.jsonl themselves; merging pulled
 *   lines goes through the normal dedupe path (cache INSERT OR IGNORE).
 */
export interface SyncAdapter {
  readonly id: "dir" | "git" | "atproto";
  readonly label: string;
  pull(): AsyncIterable<string>;
  push(lines: string[]): Promise<void>;
  /**
   * Local folder where presence heartbeats live, when the transport is
   * filesystem-backed (null = presence not supported over this transport).
   */
  heartbeatDir?(): string | null;
}

/** `[sync]` section of config.toml / config.json. */
export interface SyncConfig {
  backend?: "dir" | "git" | "atproto";
  /** dir adapter: folder watched/shared by Syncthing */
  path?: string;
  /** git adapter: private repo URL (ssh or https) */
  url?: string;
  /** git adapter: branch (default "main") */
  branch?: string;
  /** atproto adapter: PDS base URL (default https://bsky.social) */
  pds?: string;
  /** atproto adapter: handle (e.g. you.bsky.social) */
  handle?: string;
  /** atproto adapter: app password (prefer TOKITOKI_ATPROTO_APP_PASSWORD env) */
  appPassword?: string;
}

/** Parse one JSONL line into a validated event, or null when invalid. */
export function lineToEvent(line: string): UsageEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // Lazy import avoided: validation lives in types.ts (no deps).
    const e = parsed as Record<string, unknown>;
    if (
      typeof e !== "object" ||
      e === null ||
      typeof e.id !== "string" ||
      typeof e.ts !== "string" ||
      Number.isNaN(Date.parse(e.ts)) ||
      typeof e.machineId !== "string" ||
      typeof e.provider !== "string" ||
      typeof e.accountKey !== "string" ||
      typeof e.model !== "string" ||
      typeof e.inputTokens !== "number" ||
      typeof e.outputTokens !== "number"
    ) {
      return null;
    }
    return parsed as UsageEvent;
  } catch {
    return null;
  }
}
