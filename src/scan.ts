import fs from "node:fs";

import type { UsageEvent } from "./types.ts";
import type { FileScanState, Provider } from "./providers/types.ts";
import {
  appendEvents,
  loadProviderCursors,
  saveProviderCursors,
} from "./store.ts";

export interface ScanResult {
  provider: string;
  filesScanned: number;
  eventsEmitted: number;
}

export interface ScanHooks {
  /** Called with batches of extracted events as they are produced. */
  onEvents?: (events: UsageEvent[]) => void;
  /**
   * Persist the provider's cursor entries. Called periodically (byte-budgeted)
   * and once at the end, so an interrupted scan resumes where it stopped
   * instead of replaying gigabytes.
   */
  onSaveCursors: (cursors: Record<string, { offset: number; state?: Record<string, unknown> }>) => void;
}

/** Cursor saves are throttled to one write per this many processed bytes. */
const CURSOR_SAVE_INTERVAL_BYTES = 32 * 1024 * 1024;

/** Events handed to onEvents in batches of roughly this size. */
const EVENT_BATCH_SIZE = 2000;

/** Read files in slices small enough for Buffer.toString limits. */
const CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Bump when provider extraction logic changes in a way that should re-derive
 * already-scanned events (e.g. adding the `tool` field). Re-emitted events
 * keep their stable ids, so cache/log dedupe makes replays idempotent.
 */
export const EXTRACTION_VERSION = 3; // v3: codex quota snapshots extracted

/**
 * Incrementally scan one provider's session stores.
 *
 * Cursor semantics per file:
 * - `offset` = bytes already consumed; only complete newline-terminated
 *   lines are processed. An incomplete trailing line is left unconsumed and
 *   re-read on the next scan.
 * - `offset > file size` (truncation/rotation) resets the file scan.
 * - Provider `state` persists between scans so format context (current model,
 *   session header, line counters) survives incremental runs.
 *
 * Hooks decide where events go and how cursors persist; `scanProvider` wires
 * them to the local event log + per-provider cursor shard, the scan worker
 * streams batches to its parent instead.
 */
export function scanProviderCore(provider: Provider, machineId: string, hooks: ScanHooks): ScanResult {
  const cursors = loadProviderCursors(provider.id);
  const roots = provider.discoverRoots();
  const files = roots.flatMap((r) => provider.listFiles(r));
  // Shard writes are restricted to this provider's own files: the merged
  // cursor view also carries legacy entries from other providers, and letting
  // those leak into the shard would let stale copies win the shard merge.
  const ownFiles = new Set(files);

  let filesTouched = 0;
  let totalEvents = 0;
  let bytesSinceSave = 0;
  let pendingBatch: UsageEvent[] = [];

  const flushBatch = () => {
    if (pendingBatch.length === 0) return;
    hooks.onEvents?.(pendingBatch);
    pendingBatch = [];
  };
  const maybeSaveCursors = (force = false) => {
    if (!force && bytesSinceSave < CURSOR_SAVE_INTERVAL_BYTES) return;
    bytesSinceSave = 0;
    flushBatch();
    const own: typeof cursors = {};
    for (const [f, entry] of Object.entries(cursors)) {
      if (ownFiles.has(f)) own[f] = entry;
    }
    hooks.onSaveCursors(own);
  };

  for (const file of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size === 0) continue;

    // DB-backed providers: hand over the whole store, cursor state lives in
    // ctx.state (row watermark); offset is pinned to file size so the JSONL
    // skip logic below never applies.
    if (provider.scanDb !== undefined) {
      const entry = cursors[file];
      const fresh = entry === undefined || entry.state?.extractionVersion !== EXTRACTION_VERSION;
      const state: FileScanState = fresh ? {} : { ...(entry.state ?? {}) };
      state.extractionVersion = EXTRACTION_VERSION;
      try {
        const events = provider.scanDb(file, { state, freshFile: fresh, machineId });
        if (events.length > 0) {
          pendingBatch.push(...events);
          totalEvents += events.length;
          flushBatch();
        }
        filesTouched += 1;
        cursors[file] = { offset: size, state };
      } catch (error) {
        console.error(`scan: ${provider.id} db ${file}: ${String(error)}`);
      }
      continue;
    }

    const entry = cursors[file];
    const fresh = entry === undefined;
    let offset = fresh ? 0 : entry.offset;
    const state: FileScanState = fresh ? {} : { ...(entry.state ?? {}) };
    let replayed = false;
    // Extraction logic changed since this file was scanned → full replay.
    if (!fresh && state.extractionVersion !== EXTRACTION_VERSION) {
      offset = 0;
      for (const k of Object.keys(state)) delete state[k];
      replayed = true;
    }
    state.extractionVersion = EXTRACTION_VERSION;
    // Truncated or replaced file → start over
    if (!fresh && offset > size) {
      offset = 0;
      for (const k of Object.keys(state)) delete state[k];
    }
    if (offset >= size) continue;

    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      continue;
    }

    let touched = false;
    try {
      const ctxBase = { path: file, state, freshFile: (fresh && offset === 0) || replayed, machineId };
      // `offset` = safe consumption point (end of the last complete line);
      // `readPos` races ahead while a single line spans multiple chunks.
      // Codex rollouts contain multi-hundred-MB lines, so a chunk with no
      // newline is NOT necessarily an unterminated tail. Lines are delimited
      // by scanning raw bytes so multi-byte UTF-8 split across chunks cannot
      // skew the byte accounting.
      let readPos = offset;
      let pending: Buffer = Buffer.alloc(0); // bytes of an incomplete line

      while (readPos < size) {
        const length = Math.min(CHUNK_SIZE, size - readPos);
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, readPos);
        if (read === 0) break;
        readPos += read;
        const atEof = readPos >= size;
        const buf =
          pending.length === 0 ? buffer.subarray(0, read) : Buffer.concat([pending, buffer.subarray(0, read)]);

        let start = 0;
        for (;;) {
          const nl = buf.indexOf(0x0a, start);
          if (nl === -1) break;
          const line = buf.subarray(start, nl).toString("utf8");
          start = nl + 1;
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const emitted = provider.parseLine(trimmed, ctxBase);
            if (emitted.length > 0) {
              touched = true;
              totalEvents += emitted.length;
              for (const e of emitted) {
                pendingBatch.push(e);
                if (pendingBatch.length >= EVENT_BATCH_SIZE) flushBatch();
              }
            }
          } catch {
            // A malformed line must never kill a scan
          }
        }

        pending = buf.subarray(start);
        const consumedBytes = buf.length - pending.length;
        if (consumedBytes > 0) {
          offset += consumedBytes;
          bytesSinceSave += consumedBytes;
          cursors[file] = { offset, state };
          maybeSaveCursors();
        }
        if (pending.length > 0) {
          if (atEof) {
            // Genuine unterminated final line — nothing more to consume
            // until the file grows.
            break;
          }
          // Oversized line spanning chunks: keep the bytes and read on.
        }
      }
      // Files whose first line is still incomplete get an explicit entry so
      // they count as tracked (offset 0) instead of vanishing from the map.
      if (cursors[file] === undefined) cursors[file] = { offset, state };
    } finally {
      fs.closeSync(fd);
    }

    if (touched || fresh) {
      filesTouched++;
    }
  }

  maybeSaveCursors(true);
  return { provider: provider.id, filesScanned: filesTouched, eventsEmitted: totalEvents };
}

/**
 * Scan one provider in-process: events append to the local log in batches,
 * cursors persist to the provider's shard as the scan progresses. Used by
 * tests and as the fallback when workers are unavailable.
 */
export function scanProvider(provider: Provider, machineId: string): ScanResult {
  return scanProviderCore(provider, machineId, {
    onEvents: (events) => appendEvents(events),
    onSaveCursors: (cursors) => saveProviderCursors(provider.id, cursors),
  });
}
