import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { dataDir, eventsFile } from "./store.ts";

/**
 * Monthly gzip rotation of the local event log.
 *
 * Layout: <dataDir>/events-archive/<yyyy-mm>.jsonl.gz — one file per UTC
 * month of events. The current log keeps the most recent `keepMonths` months;
 * older complete lines move into their month's archive. Archives are merged
 * (not replaced) so an interrupted or repeated rotation can never lose data,
 * and lines are deduped on the event `id` field during merges — re-running
 * rotation over overlapping input is idempotent by construction.
 */

export interface RotateResult {
  /** Archive month keys (yyyy-mm) that received new writes. */
  rotated: string[];
  /** Approximate bytes removed from the live log (uncompressed line bytes). */
  bytesSaved: number;
}

function archiveDir(): string {
  return path.join(dataDir(), "events-archive");
}

export function archiveFilePath(monthKey: string): string {
  return path.join(archiveDir(), `${monthKey}.jsonl.gz`);
}

/** List existing archive files as month keys (yyyy-mm), sorted ascending. */
export function readArchiveMonths(): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(archiveDir());
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".jsonl.gz"))
    .map((f) => f.replace(/\.jsonl\.gz$/, ""))
    .sort();
}

/** UTC yyyy-mm for a timestamp string; null when absent/unparseable. */
function monthKeyOf(ts: unknown): string | null {
  if (typeof ts !== "string" || ts.length === 0) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

/** Month key `now - keepMonths` falls into; months strictly before it archive. */
function cutoffMonth(now: Date, keepMonths: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keepMonths, 1));
  return d.toISOString().slice(0, 7);
}

interface LineEntry {
  raw: string;
  month: string | null;
  id: string | null;
}

/** Split the live log into per-line metadata; unparseable JSON keeps month=null. */
function classifyLines(raw: string): LineEntry[] {
  const out: LineEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let month: string | null = null;
    let id: string | null = null;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown; id?: unknown };
      month = monthKeyOf(parsed.ts);
      id = typeof parsed.id === "string" ? parsed.id : null;
    } catch {
      // corrupt line — stays in the live log untouched
    }
    out.push({ raw: line, month, id });
  }
  return out;
}

/** Decode one .gz archive into dedupe-ready line entries. */
function readArchiveLines(file: string): LineEntry[] {
  const buf = fs.readFileSync(file);
  const text = gunzipSync(buf).toString("utf8");
  return classifyLines(text);
}

/** Atomic gzip write: tmp file → rename. */
function writeArchiveGz(file: string, lines: LineEntry[]): void {
  const payload = gzipSync(Buffer.from(lines.map((l) => l.raw).join("\n") + "\n", "utf8"));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload);
  fs.renameSync(tmp, file);
}

export async function rotateEventsLog(opts?: {
  keepMonths?: number;
  now?: Date;
}): Promise<RotateResult> {
  const keepMonths = opts?.keepMonths ?? 3;
  const now = opts?.now ?? new Date();
  const cutoff = cutoffMonth(now, keepMonths);

  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile(), "utf8");
  } catch {
    return { rotated: [], bytesSaved: 0 };
  }

  const lines = classifyLines(raw);
  // Partition: archivable = complete lines whose ts month is strictly older
  // than the cutoff; everything else (recent + corrupt/no-ts) stays put.
  const byMonth = new Map<string, Map<string, LineEntry>>();
  const kept: LineEntry[] = [];
  let bytesSaved = 0;

  for (const entry of lines) {
    if (entry.month !== null && entry.month < cutoff && entry.id !== null) {
      let bucket = byMonth.get(entry.month);
      if (bucket === undefined) {
        bucket = new Map();
        byMonth.set(entry.month, bucket);
      }
      if (!bucket.has(entry.id)) bucket.set(entry.id, entry);
      bytesSaved += Buffer.byteLength(entry.raw, "utf8") + 1;
    } else {
      kept.push(entry);
    }
  }

  if (byMonth.size === 0) return { rotated: [], bytesSaved: 0 };

  fs.mkdirSync(archiveDir(), { recursive: true });

  // Merge each month with any existing archive. Dedupe on event id across
  // (existing ∪ incoming), first occurrence wins — this is what makes
  // re-rotation and crash-recovery idempotent.
  const rotated: string[] = [];
  for (const [month, incoming] of [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = archiveFilePath(month);
    const merged = new Map<string, LineEntry>();
    if (fs.existsSync(file)) {
      for (const existing of readArchiveLines(file)) {
        if (existing.id === null || !merged.has(existing.id)) merged.set(existing.id ?? existing.raw, existing);
      }
    }
    for (const [id, entry] of incoming) {
      if (!merged.has(id)) merged.set(id, entry);
    }
    writeArchiveGz(file, [...merged.values()]);
    rotated.push(month);
  }

  // Rewrite the live log last: only after every archive write succeeded.
  const tmpLog = `${eventsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmpLog, kept.map((l) => l.raw).join("\n") + (kept.length > 0 ? "\n" : ""));
  fs.renameSync(tmpLog, eventsFile());

  return { rotated, bytesSaved };
}
