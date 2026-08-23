import fs from "node:fs";

import type { UsageEvent } from "./types.ts";
import type { FileScanState, Provider } from "./providers/types.ts";
import { appendEvents, loadCursors, saveCursors } from "./store.ts";

export interface ScanResult {
  provider: string;
  filesScanned: number;
  eventsEmitted: number;
}

/** Read files in slices small enough for Buffer.toString limits. */
const CHUNK_SIZE = 8 * 1024 * 1024;

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
 */
export function scanProvider(provider: Provider, machineId: string): ScanResult {
  const cursors = loadCursors();
  const roots = provider.discoverRoots();
  const files = roots.flatMap((r) => provider.listFiles(r));

  let filesTouched = 0;
  let totalEvents = 0;
  const newEvents: UsageEvent[] = [];

  for (const file of files) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size === 0) continue;

    const entry = cursors[file];
    const fresh = entry === undefined;
    let offset = fresh ? 0 : entry.offset;
    const state: FileScanState = fresh ? {} : { ...(entry.state ?? {}) };
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
      const ctxBase = { path: file, state, freshFile: fresh && offset === 0, machineId };
      let leftover = "";

      while (offset < size) {
        const length = Math.min(CHUNK_SIZE, size - offset);
        const buffer = Buffer.alloc(length);
        const read = fs.readSync(fd, buffer, 0, length, offset);
        if (read === 0) break;
        const text = leftover + buffer.toString("utf8", 0, read);

        const endsWithNewline = text.endsWith("\n");
        const lines = text.split("\n");
        if (!endsWithNewline) {
          // Incomplete trailing line: carried into the next chunk, or left
          // unconsumed when the file ends without a final newline.
          leftover = lines.pop() ?? "";
        } else if (lines.length > 0 && lines[lines.length - 1] === "") {
          // "a\nb\n" splits to [a,b,""] — the empty tail is not a line
          lines.pop();
        }

        let consumedBytes = 0;
        for (const line of lines) {
          consumedBytes += Buffer.byteLength(line, "utf8") + 1; // + newline
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const emitted = provider.parseLine(trimmed, ctxBase);
            if (emitted.length > 0) {
              touched = true;
              totalEvents += emitted.length;
              for (const e of emitted) newEvents.push(e);
            }
          } catch {
            // A malformed line must never kill a scan
          }
        }

        offset += consumedBytes;
        if (consumedBytes === 0) {
          // Only an unterminated trailing line remains — nothing more can be
          // consumed until the file grows.
          break;
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    if (touched || fresh) {
      filesTouched++;
      cursors[file] = { offset, state };
    }
  }

  appendEvents(newEvents);
  saveCursors(cursors);
  return { provider: provider.id, filesScanned: filesTouched, eventsEmitted: totalEvents };
}
