import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import type { UsageEvent } from "../types.ts";
import { eventId } from "../machine.ts";
import { estimateCost } from "../pricing.ts";
import { providerConfig } from "../config.ts";
import type { DbScanContext, Provider, SessionDoc } from "./types.ts";

/**
 * opencode (sst/opencode) adapter.
 *
 * Store layout (verified against real stores):
 * - SQLite databases at $XDG_DATA_HOME/opencode/opencode*.db (default
 *   ~/.local/share/opencode/). Multiple generations coexist on disk
 *   (opencode.db, opencode-stable.db, ...) — every one is scanned and
 *   event ids are stable, so overlapping content dedupes.
 * - `session` table: one row per conversation — directory, title, model,
 *   aggregate tokens/cost, time_created/time_updated (ms epoch).
 * - `message` table: data JSON per message. Assistant rows carry
 *   {role, cost, tokens:{input,output,reasoning,cache:{read,write}},
 *   modelID, providerID, time:{created,completed}}. `time_updated`
 *   advances while a response streams, so it is the incremental cursor.
 * - Legacy JSON-file layouts (storage/session/... , *.jsonl) are not
 *   written by any version found in the wild here; the DB is the source
 *   of truth since the sqlite migration.
 */
/** Provider id — referenced from scanDb without relying on `this`. */
const PROVIDER_ID = "opencode";

export const opencodeProvider: Provider = {
  id: PROVIDER_ID,
  label: "opencode",

  discoverRoots(): string[] {
    const configured = providerConfig(this.id)?.paths;
    if (configured !== undefined && configured.length > 0) return configured;
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg !== undefined && xdg.length > 0 ? xdg : `${process.env.HOME ?? "~"}/.local/share`;
    return [`${base}/opencode`];
  },

  listFiles(root: string): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return [];
    }
    return entries
      .filter((f) => /^opencode.*\.db$/i.test(f))
      .map((f) => path.join(root, f))
      .sort();
  },

  /** Never called — scanDb replaces the JSONL walk for this provider. */
  parseLine(): UsageEvent[] {
    return [];
  },

  scanDb(storePath: string, ctx: DbScanContext): UsageEvent[] {
    const db = openStore(storePath);
    if (db === null) return [];
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message','session')")
        .all();
      if (tables.length < 2) return []; // not a (recognized) opencode store

      // Incremental cursor: high-water mark on message.time_updated (ms).
      // Streaming updates bump time_updated on an existing row; re-emitting
      // its stable event id is harmless (dedupe downstream).
      const watermark = typeof ctx.state.watermark === "number" ? ctx.state.watermark : 0;
      const rows = db
        .prepare(
          `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data, s.directory
           FROM message m JOIN session s ON s.id = m.session_id
           WHERE m.time_updated > ? ORDER BY m.time_updated ASC LIMIT 50000`,
        )
        .all(watermark) as Array<{
        id: string;
        session_id: string;
        time_created: number;
        time_updated: number;
        data: string;
        directory: string | null;
      }>;

      const events: UsageEvent[] = [];
      for (const row of rows) {
        if (row.time_updated > watermark) ctx.state.watermark = row.time_updated;
        const parsed = parseMessageData(row.data);
        if (parsed === null) continue;
        const { role, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd, model, account, completed } = parsed;
        if (role !== "assistant") continue;
        // A streaming response keeps bumping time_updated with growing
        // partial token counts. Downstream dedupe is first-write-wins
        // (cache.ts: INSERT OR IGNORE on event id), so a scan that catches
        // a message mid-stream would otherwise lock in an undercount
        // forever — the real, final numbers arriving later get silently
        // discarded as a "duplicate" of the same id. Wait for time.completed
        // instead; time_updated bumps again on completion, so the row is
        // naturally re-selected by the watermark query once it's done.
        if (!completed) continue;
        if (inputTokens === 0 && outputTokens === 0) continue;
        events.push({
          id: eventId(PROVIDER_ID, account, row.session_id, row.id),
          ts: new Date(row.time_created).toISOString(),
          machineId: ctx.machineId,
          provider: PROVIDER_ID,
          accountKey: account,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          costUsd,
          projectDir: row.directory ?? undefined,
          sessionId: row.session_id,
        });
      }
      return events;
    } finally {
      db.close();
    }
  },

  extractSessionDocs(storePath: string): SessionDoc[] {
    const db = openStore(storePath);
    if (db === null) return [];
    try {
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message','session','part')")
        .all();
      if (tables.length < 3) return [];

      interface SessionRow {
        id: string;
        title: string;
        directory: string | null;
        agent: string | null;
        time_created: number;
      }
      // Older store generations lack newer columns (agent/model) — probe and
      // degrade instead of failing the whole extraction.
      const cols = new Set(
        (
          db.prepare("PRAGMA table_info(session)").all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
      const agentCol = cols.has("agent") ? "agent" : "NULL as agent";
      const sessions = db
        .prepare(`SELECT id, title, directory, ${agentCol}, time_created FROM session ORDER BY time_created ASC`)
        .all() as SessionRow[];

      const docs: SessionDoc[] = [];
      for (const s of sessions) {
        // Body = concatenated text parts (user + assistant), capped hard so a
        // giant session cannot blow up the FTS index.
        const MAX_BODY = 512 * 1024;
        let body = "";
        const parts = db
          .prepare(
            `SELECT json_extract(data, '$.text') AS txt FROM part
             WHERE session_id = ? AND json_extract(data, '$.type') = 'text' AND json_extract(data, '$.text') IS NOT NULL
             ORDER BY time_created ASC LIMIT 400`,
          )
          .all(s.id) as Array<{ txt: string | null }>;
        for (const p of parts) {
          if (p.txt === null || body.length >= MAX_BODY) break;
          body += p.txt + "\n";
        }
        body = body.slice(0, MAX_BODY);
        docs.push({
          sessionId: s.id,
          accountKey: s.agent ?? undefined,
          startedAt: new Date(s.time_created).toISOString(),
          title: s.title,
          body,
        });
      }
      return docs;
    } finally {
      db.close();
    }
  },

  usageNote:
    "SQLite stores (opencode*.db under ~/.local/share/opencode); request-level tokens+cost from assistant messages",
};

/**
 * Open a store read-only. Falls back to `file:...?immutable=1` when the
 * direct open fails — legacy WAL-mode databases without a live writer
 * cannot be opened READONLY without creating -shm/-wal companions, but
 * read cleanly as immutable. Never use immutable on stores that are
 * actively written (those open fine directly).
 */
function openStore(storePath: string): Database | null {
  if (!fs.existsSync(storePath)) return null;
  // bun:sqlite defers the real open to the first statement, so each attempt
  // must execute a probe query for its errors to surface here.
  try {
    const db = new Database(storePath, { readonly: true });
    db.query("SELECT 1 AS ok").get();
    return db;
  } catch {
    try {
      const db = new Database(`file:${encodeURI(storePath)}?immutable=1`, { readonly: true });
      db.query("SELECT 1 AS ok").get();
      return db;
    } catch {
      return null;
    }
  }
}

interface ParsedMessage {
  role: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  model: string;
  account: string;
  /** True once opencode has finalized this message (time.completed is set). */
  completed: boolean;
}

/** Parse one message.data JSON blob; null when unusable. */
function parseMessageData(raw: string): ParsedMessage | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const role = typeof data.role === "string" ? data.role : "unknown";
  const tokens = (data.tokens ?? {}) as Record<string, unknown>;
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  const toNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const inputTokens = toNum(tokens.input);
  // Reasoning tokens are billed as output — fold them in (opencode reports
  // them separately; total = input + output + reasoning + cache).
  const outputTokens = toNum(tokens.output) + toNum(tokens.reasoning);
  const cacheRead = toNum(cache.read);
  const cacheWrite = toNum(cache.write);
  const model = typeof data.modelID === "string" && data.modelID.length > 0 ? data.modelID : "unknown";
  const account =
    typeof data.providerID === "string" && data.providerID.length > 0 ? data.providerID : "default";
  // A harness-reported cost of exactly $0 (e.g. a fully cached turn) is real
  // and must be trusted, not treated as "absent" and overwritten with an
  // estimate — only fall back when cost genuinely isn't a number at all.
  const costUsd =
    typeof data.cost === "number" && Number.isFinite(data.cost)
      ? data.cost
      : estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }) ||
        0;
  const time = (data.time ?? {}) as Record<string, unknown>;
  const completed = typeof time.completed === "number" && Number.isFinite(time.completed);
  return { role, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd, model, account, completed };
}
