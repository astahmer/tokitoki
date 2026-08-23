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

  /** Return candidate JSONL files under the given roots (recursive). */
  listFiles(root: string): string[];

  /**
   * Parse one JSONL line. Called only for complete lines; providers should
   * skip unrelated entry types. State persists between scans via ctx.state.
   */
  parseLine(line: string, ctx: EntryContext): UsageEvent[];

  /** Session text extraction for the search index (absent = not searchable). */
  extractSessionDocs?: ExtractSessionDocs;
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
