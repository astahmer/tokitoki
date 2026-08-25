import type { UsageEvent } from "../types.ts";

/**
 * Persisted per-file scanner state so incremental scans keep context
 * (current model, session metadata, line counters) across runs.
 */
export type FileScanState = Record<string, unknown>;

export interface ParsedEntry {
  events: UsageEvent[];
}

export interface EntryContext {
  /** Absolute path of the file being scanned */
  path: string;
  /** Mutable state bag persisted between scans (JSON-serializable) */
  state: FileScanState;
  /** True while replaying from byte 0 (lets providers reset state) */
  freshFile: boolean;
  /** Machine attribution for locally produced events */
  machineId: string;
}

/** Context handed to DB-backed providers (see Provider.scanDb). */
export interface DbScanContext {
  /** Mutable state bag persisted between scans (JSON-serializable) */
  state: FileScanState;
  /** True on first sight of this store (or after an extraction-version bump) */
  freshFile: boolean;
  /** Machine attribution for locally produced events */
  machineId: string;
}

/**
 * A harness adapter. Adding support for a new coding agent means dropping one
 * file in src/providers/ exporting this interface and registering it in
 * index.ts.
 */
export interface Provider {
  id: string;
  label: string;
  /** Env override honored by discoverRoots (e.g. CLAUDE_CONFIG_DIR) — shown in sources. */
  envVar?: string;

  /**
   * Roots to scan for this provider's session stores. Must respect the
   * harness's env overrides ($CLAUDE_CONFIG_DIR, $PI_DIR, ...) and any
   * provider-specific config override.
   */
  discoverRoots(): string[];

  /**
   * Return candidate store files under the given roots (recursive). For
   * JSONL providers these are line-scanned; for DB providers (scanDb set)
   * each file is handed to scanDb as a whole.
   */
  listFiles(root: string): string[];

  /**
   * Parse one JSONL line. Called only for complete lines; providers should
   * skip unrelated entry types. State persists between scans via ctx.state.
   */
  parseLine(line: string, ctx: EntryContext): UsageEvent[];

  /**
   * Scan one SQLite-backed store file instead of walking JSONL lines.
   * Implementations manage their own incremental cursor inside ctx.state
   * (e.g. a row watermark) and return all newly-usable events; re-emitting
   * an event with an already-known id is safe (cache/log dedupe).
   * When set, scanProviderCore calls this per listed file and skips the
   * byte-offset JSONL machinery entirely.
   */
  scanDb?(storePath: string, ctx: DbScanContext): UsageEvent[];

  /** Session text extraction for the search index (absent = not searchable). */
  extractSessionDocs?: ExtractSessionDocs;

  /**
   * Provenance note shown by `tokitoki sources` — e.g. stores found on disk
   * that expose no token usage, or skeleton providers awaiting a real store.
   */
  usageNote?: string;
}

/** One indexable conversation extracted from a provider store file. */
export interface SessionDoc {
  sessionId: string;
  /** Account label when derivable without extra work (best effort). */
  accountKey?: string;
  /** ISO-8601 session start when the format records one. */
  startedAt?: string;
  /** First user prompt, truncated — the row's human handle. */
  title: string;
  /** Concatenated user+assistant text and tool names. Capped at ~1MB. */
  body: string;
}

/**
 * Optional full-text extraction for the sessions search index. Implementations
 * re-walk a raw store file independently of scan cursors; freshness is keyed
 * on file mtime+size instead.
 */
export type ExtractSessionDocs = (file: string) => SessionDoc[];

/** Read an env-overridable path with a default under $HOME. */
export function homePath(envVar: string, suffix: string): string {
  const override = process.env[envVar];
  if (override !== undefined && override.length > 0) return override;
  return `${process.env.HOME ?? "~"}${suffix}`;
}
