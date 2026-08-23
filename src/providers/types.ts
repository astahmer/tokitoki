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
}

/** Read an env-overridable path with a default under $HOME. */
export function homePath(envVar: string, suffix: string): string {
  const override = process.env[envVar];
  if (override !== undefined && override.length > 0) return override;
  return `${process.env.HOME ?? "~"}${suffix}`;
}
