import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function loadCursors(): Cursors {
  try {
    const raw = fs.readFileSync(cursorsFile(), "utf8");
    const parsed = JSON.parse(raw) as Cursors;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCursors(cursors: Cursors): void {
  ensureDataDir();
  fs.writeFileSync(cursorsFile(), JSON.stringify(cursors, null, 2));
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
 * Read all usage events from a JSONL log file. Tolerates trailing partial
 * lines and corrupt lines (skipped).
 */
export function readEventsFile(file: string): UsageEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
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
