import fs from "node:fs";
import path from "node:path";

import type { SessionDoc } from "./types.ts";
import { providerConfig } from "../config.ts";
import { homePath, type EntryContext, type Provider } from "./types.ts";

/**
 * T3 Code (Electron IDE) keeps its thread store inside an IndexedDB LevelDB
 * under ~/Library/Application Support/t3code. Each record embeds a JSON
 * thread snapshot:
 *
 *   {"schemaVersion":2,"environmentId":...,"threadId":"<uuid>",
 *    "snapshot":{"snapshotSequence":N,"thread":{
 *      "id":"<uuid>","title":"...","modelSelection":{"instanceId":...,
 *      "model":"..."},"messages":[{"role":"user","text":"..."},...]}}}
 *
 * Inspected 2026-08-24: snapshots carry titles, model selections and user
 * messages but NO token usage or cost fields — so this provider is
 * search-index only (sessions page), never a source of UsageEvents.
 */
export const T3CODE_NO_USAGE_NOTE = "no usage data exposed (thread metadata only)";

export function t3codeLevelDbDir(): string {
  return path.join(
    homePath("T3CODE_DIR", "/Library/Application Support/t3code"),
    "IndexedDB/t3code_app_0.indexeddb.leveldb",
  );
}

/** .ldb (compacted) + .log (write-ahead) are the two data file kinds. */
function isLevelDbDataFile(name: string): boolean {
  return name.endsWith(".ldb") || name.endsWith(".log");
}

export const t3CodeProvider: Provider = {
  id: "t3code",
  label: "T3 Code",
  envVar: "T3CODE_DIR",
  usageNote: T3CODE_NO_USAGE_NOTE,

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [t3codeLevelDbDir()];
  },

  listFiles(root: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isFile() && isLevelDbDataFile(e.name)).map((e) => path.join(root, e.name));
  },

  // Binary LevelDB — the JSONL scan loop finds no parseable lines. Search
  // indexing goes through extractSessionDocs instead.
  parseLine(_line: string, _ctx: EntryContext): [] {
    return [];
  },

  extractSessionDocs: extractT3SessionDocs,
};

const SNAPSHOT_MARKER = '{"schemaVersion":';
const WINDOW_BYTES = 256 * 1024;
const BODY_CAP = 512 * 1024;
const ISO_TIMESTAMP_RE = /20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;

/**
 * Pull thread snapshots out of raw LevelDB bytes. Records can straddle chunk
 * boundaries and contain partial JSON, so this is deliberately regex-based
 * over an unescaped latin1 view rather than JSON.parse.
 */
export function extractT3SessionDocs(file: string): SessionDoc[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  if (buf.length === 0) return [];
  const text = buf.toString("latin1");

  const byThread = new Map<string, SessionDoc>();
  let idx = text.indexOf(SNAPSHOT_MARKER);
  while (idx !== -1) {
    const next = text.indexOf(SNAPSHOT_MARKER, idx + SNAPSHOT_MARKER.length);
    const windowEnd = Math.min(next === -1 ? text.length : next, idx + WINDOW_BYTES);
    const window = text.slice(idx, windowEnd);

    const idMatch = /"threadId":"([0-9a-f-]{36})"/.exec(window);
    if (idMatch !== null) {
      const sessionId = idMatch[1]!;
      const title = unescapeJson(/"title":"((?:[^"\\]|\\.)*)"/.exec(window)?.[1] ?? "");
      const bodyParts: string[] = [];
      for (const m of window.matchAll(/"role":"user","text":"((?:[^"\\]|\\.)*)"/g)) {
        bodyParts.push(unescapeJson(m[1] ?? ""));
        if (bodyParts.join("\n").length > BODY_CAP) break;
      }
      const explicitStartedAt = /"createdAt":"([^"]+)"/.exec(window)?.[1];
      // Some compacted LevelDB records preserve the timestamp value but
      // damage/interleave the surrounding property name. Keep those T3
      // sessions in the correct date window by falling back to the earliest
      // ISO timestamp embedded in the snapshot.
      const timestamps = [...window.matchAll(ISO_TIMESTAMP_RE)].map((match) => match[0]).sort();
      const startedAt = explicitStartedAt ?? timestamps[0];
      const model = /"modelSelection":\{"instanceId":"([^"]*)","model":"([^"]*)"/.exec(window);
      const accountKey = model?.[1];
      const prev = byThread.get(sessionId);
      const body = bodyParts.join("\n").slice(0, BODY_CAP);
      // Later snapshots of the same thread are newer — keep whichever has more text.
      if (body.length > (prev?.body.length ?? -1)) {
        byThread.set(sessionId, { sessionId, accountKey, startedAt, title, body });
      }
    }
    idx = next;
  }

  return [...byThread.values()].filter((d) => d.title.length > 0 || d.body.length > 0);
}

function unescapeJson(raw: string): string {
  let out: string;
  try {
    out = JSON.parse(`"${raw}"`) as string;
  } catch {
    out = raw;
  }
  return out.replace(/\s+/g, " ").trim();
}
