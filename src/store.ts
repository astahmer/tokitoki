import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { UsageEvent } from "./types.ts";
import { isValidUsageEvent } from "./types.ts";

/** Data dir for the local append-log + sqlite cache. */
export function dataDir(): string {
  const override = process.env.TOKITOKI_DATA_DIR;
  if (override !== undefined && override.length > 0) return override;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, "tokitoki");
  return path.join(os.homedir(), ".local", "share", "tokitoki");
}

export function eventsFile(): string {
  return path.join(dataDir(), "events.jsonl");
}

export interface CursorEntry {
  /** Byte offset consumed in the file */
  offset: number;
  /** Opaque provider state bag persisted between scans */
  state?: Record<string, unknown>;
}

export type Cursors = Record<string, CursorEntry>;

export function cursorsFile(): string {
  return path.join(dataDir(), "cursors.json");
}

/**
 * Per-provider cursor shard. Providers scan in parallel (worker per provider),
 * so a single shared cursors.json would race read-modify-write cycles; each
 * provider persists only its own shard. The legacy monolithic file is still
 * read (merged) so existing installs migrate without a re-scan.
 */
function cursorShardFile(providerId: string): string {
  return path.join(dataDir(), "cursors", `${providerId}.json`);
}

function readJsonMap(file: string): Cursors {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Cursors;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Merged view over the legacy cursors.json plus every provider shard. */
export function loadCursors(): Cursors {
  const merged = readJsonMap(cursorsFile());
  let shards: string[] = [];
  try {
    shards = fs.readdirSync(path.join(dataDir(), "cursors")).filter((f) => f.endsWith(".json"));
  } catch {
    // no shards yet
  }
  for (const s of shards) {
    Object.assign(merged, readJsonMap(path.join(dataDir(), "cursors", s)));
  }
  return merged;
}

/** Cursor entries for one provider: legacy file overlaid by its own shard. */
export function loadProviderCursors(providerId: string): Cursors {
  const merged = readJsonMap(cursorsFile());
  Object.assign(merged, readJsonMap(cursorShardFile(providerId)));
  return merged;
}

/** Persist one provider's shard atomically (tmp + rename). */
export function saveProviderCursors(providerId: string, cursors: Cursors): void {
  ensureDataDir();
  const dir = path.join(dataDir(), "cursors");
  fs.mkdirSync(dir, { recursive: true });
  const target = cursorShardFile(providerId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursors));
  fs.renameSync(tmp, target);
}

export function ensureDataDir(): void {
  fs.mkdirSync(dataDir(), { recursive: true });
}

/** Append events to the local JSONL log (one per line). */
export function appendEvents(events: UsageEvent[]): number {
  if (events.length === 0) return 0;
  ensureDataDir();
  const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(eventsFile(), payload);
  return events.length;
}

/**
 * Read only the events appended after `fromOffset`. Returns the parsed events
 * plus the new safe consumption point: the offset clamped back to the last
 * complete newline, so a partially-written trailing line is never consumed.
 * Corrupt lines are skipped.
 */
export function readEventsTail(
  file: string,
  fromOffset: number,
): { events: UsageEvent[]; newSize: number } {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { events: [], newSize: fromOffset };
  }
  if (size <= fromOffset) return { events: [], newSize: fromOffset };

  const length = size - fromOffset;
  const buffer = Buffer.alloc(length);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { events: [], newSize: fromOffset };
  }
  let text: string;
  try {
    const read = fs.readSync(fd, buffer, 0, length, fromOffset);
    text = buffer.toString("utf8", 0, read);
  } finally {
    fs.closeSync(fd);
  }

  // Clamp to the last complete line — an unterminated tail belongs to the
  // next read, otherwise its remainder would be lost forever.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { events: [], newSize: fromOffset };
  const complete = text.slice(0, lastNewline); // exclusive of the newline
  const newSize = fromOffset + Buffer.byteLength(complete, "utf8") + 1;

  const events: UsageEvent[] = [];
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidUsageEvent(parsed)) events.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return { events, newSize };
}

/** Read a log file's full text; .jsonl.gz archives are gunzipped first. */
function readLogText(file: string): string | null {
  try {
    if (file.endsWith(".gz")) {
      return gunzipSync(fs.readFileSync(file)).toString("utf8");
    }
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read all usage events from a JSONL log file (.jsonl or .jsonl.gz).
 * Tolerates trailing partial lines and corrupt lines (skipped).
 */
export function readEventsFile(file: string): UsageEvent[] {
  const raw = readLogText(file);
  if (raw === null) return [];
  const events: UsageEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidUsageEvent(parsed)) events.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return events;
}
