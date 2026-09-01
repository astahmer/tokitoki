import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import type { UsageEvent } from "../types.ts";
import type { DbScanContext, SessionDoc } from "./types.ts";
import { eventId } from "../machine.ts";
import { estimateCost, estimateTokensFromChars } from "../pricing.ts";
import { providerConfig } from "../config.ts";
import { homePath, type EntryContext, type Provider } from "./types.ts";

/**
 * T3 Code's real source of truth is a local event-sourced SQLite database at
 * ~/.t3/userdata/state.sqlite, run by T3 Code's own local server (confirmed
 * against pingdotgg/t3code's docs/internals/scripts.md, and by matching real
 * thread titles on disk, 2026-09-01). The Electron app's IndexedDB store
 * (used by an earlier version of this provider) is only renderer-side UI
 * scratch state — sparse, sometimes empty, not the actual thread data.
 *
 * Relevant tables:
 *   projection_threads         — thread_id, title, model_selection_json,
 *                                 created_at/updated_at, deleted_at
 *   projection_thread_messages — message_id, thread_id, role
 *                                 ('user'|'assistant'), text, created_at
 *   provider_session_runtime   — thread_id, provider_name,
 *                                 provider_instance_id (fallback for threads
 *                                 with no model_selection_json yet)
 *
 * `model_selection_json.instanceId` (e.g. "cursor", "claudeAgent") is which
 * backend a thread is routed through — T3 Code is bring-your-own-subscription,
 * so a "cursor" thread bills against the user's own Cursor account, not a
 * separate T3 Code allocation.
 *
 * Inspected 2026-09-01: unlike Cursor's own local stores, T3 Code DOES carry
 * real per-call `usage`/`typedUsage` token counts in
 * projection_thread_activities — but only for Claude-routed subagent
 * Task-tool calls. Cursor-routed (grok) threads carry none anywhere in this
 * database either, confirmed by grepping their own activity payloads. So
 * usage below stays a chars/4 estimate for every thread — for consistent,
 * comparable numbers rather than some threads exact and most not.
 */
export const T3CODE_NO_USAGE_NOTE =
  "no exact token/cost data for cursor-routed threads — usage below is estimated from message length";

export function t3codeStateDbDir(): string {
  return homePath("T3CODE_DIR", "/.t3/userdata");
}

function stateDbFile(root: string): string {
  return path.join(root, "state.sqlite");
}

/** Open read-only, falling back to immutable mode for a WAL db with no live writer. */
function openStore(storePath: string): Database | undefined {
  if (!fs.existsSync(storePath)) return undefined;
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
      return undefined;
    }
  }
}

function hasTables(db: Database, names: string[]): boolean {
  const stmt = db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?");
  return names.every((n) => stmt.get(n) !== undefined);
}

/** `{instanceId, model}` from a thread's model_selection_json, falling back to its runtime row. */
function threadRouting(
  modelSelectionJson: string | null,
  runtimeInstanceId: string | null,
  runtimeProviderName: string | null,
): { instanceId: string; model: string } {
  let instanceId = runtimeInstanceId ?? runtimeProviderName ?? "default";
  let model = "unknown";
  if (modelSelectionJson !== null) {
    try {
      const parsed = JSON.parse(modelSelectionJson) as { instanceId?: string; model?: string };
      if (typeof parsed.instanceId === "string" && parsed.instanceId.length > 0) instanceId = parsed.instanceId;
      if (typeof parsed.model === "string" && parsed.model.length > 0) model = parsed.model;
    } catch {
      // malformed JSON — keep the runtime-row fallback
    }
  }
  return { instanceId, model };
}

const BODY_CAP = 512 * 1024;

export function extractT3SessionDocs(storePath: string): SessionDoc[] {
  const db = openStore(storePath);
  if (db === undefined) return [];
  try {
    if (!hasTables(db, ["projection_threads", "projection_thread_messages"])) return [];

    const threads = db
      .prepare(
        `SELECT t.thread_id, t.title, t.created_at, t.model_selection_json,
                r.provider_instance_id, r.provider_name
         FROM projection_threads t
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
         WHERE t.deleted_at IS NULL`,
      )
      .all() as Array<{
      thread_id: string;
      title: string;
      created_at: string;
      model_selection_json: string | null;
      provider_instance_id: string | null;
      provider_name: string | null;
    }>;

    const bodyStmt = db.prepare(
      `SELECT role, text FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT 4000`,
    );
    const docs: SessionDoc[] = [];
    for (const t of threads) {
      const rows = bodyStmt.all(t.thread_id) as Array<{ role: string; text: string }>;
      const parts: string[] = [];
      let len = 0;
      for (const r of rows) {
        if (r.text.length === 0) continue;
        parts.push(r.text);
        len += r.text.length;
        if (len >= BODY_CAP) break;
      }
      const body = parts.join("\n").slice(0, BODY_CAP);
      if (t.title.length === 0 && body.length === 0) continue;
      const { instanceId } = threadRouting(t.model_selection_json, t.provider_instance_id, t.provider_name);
      docs.push({ sessionId: t.thread_id, accountKey: instanceId, startedAt: t.created_at, title: t.title, body });
    }
    return docs;
  } finally {
    db.close();
  }
}

interface MessageRow {
  rowid: number;
  message_id: string;
  thread_id: string;
  role: string;
  text: string;
  created_at: string;
}

/**
 * Estimated per-turn UsageEvents (chars/4, both sides — see module doc for
 * why this is an estimate, not real usage). Incremental via a rowid
 * watermark; the user/assistant pairing map persists in ctx.state so a turn
 * split across two scans still pairs correctly.
 */
function scanT3CodeUsageEvents(storePath: string, ctx: DbScanContext): UsageEvent[] {
  const db = openStore(storePath);
  if (db === undefined) return [];
  try {
    if (!hasTables(db, ["projection_thread_messages", "projection_threads"])) return [];

    const watermark = typeof ctx.state.msgRowid === "number" ? ctx.state.msgRowid : 0;
    const rows = db
      .prepare(
        `SELECT rowid, message_id, thread_id, role, text, created_at
         FROM projection_thread_messages
         WHERE rowid > ? ORDER BY rowid ASC LIMIT 50000`,
      )
      .all(watermark) as MessageRow[];
    if (rows.length === 0) return [];

    const routingStmt = db.prepare(
      `SELECT t.model_selection_json, r.provider_instance_id, r.provider_name
       FROM projection_threads t
       LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
       WHERE t.thread_id = ?`,
    );
    const routingCache = new Map<string, { instanceId: string; model: string }>();
    const routingFor = (threadId: string): { instanceId: string; model: string } => {
      const cached = routingCache.get(threadId);
      if (cached !== undefined) return cached;
      const row = routingStmt.get(threadId) as
        | { model_selection_json: string | null; provider_instance_id: string | null; provider_name: string | null }
        | undefined;
      const routing = threadRouting(row?.model_selection_json ?? null, row?.provider_instance_id ?? null, row?.provider_name ?? null);
      routingCache.set(threadId, routing);
      return routing;
    };

    const lastUserChars = (ctx.state.lastUserChars ??= {}) as Record<string, number>;
    const events: UsageEvent[] = [];
    for (const row of rows) {
      ctx.state.msgRowid = row.rowid;
      if (row.role === "user") {
        lastUserChars[row.thread_id] = row.text.length;
        continue;
      }
      if (row.role !== "assistant" || row.text.length === 0) continue;
      const inputTokens = estimateTokensFromChars(lastUserChars[row.thread_id] ?? 0);
      delete lastUserChars[row.thread_id];
      const outputTokens = estimateTokensFromChars(row.text.length);
      const { instanceId, model } = routingFor(row.thread_id);
      events.push({
        id: eventId("t3code", instanceId, row.thread_id, row.message_id),
        ts: row.created_at,
        machineId: ctx.machineId,
        provider: "t3code",
        accountKey: instanceId,
        model,
        inputTokens,
        outputTokens,
        costUsd: estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }),
        sessionId: row.thread_id,
      });
    }
    return events;
  } finally {
    db.close();
  }
}

export const t3CodeProvider: Provider = {
  id: "t3code",
  label: "T3 Code",
  envVar: "T3CODE_DIR",
  usageNote: T3CODE_NO_USAGE_NOTE,

  discoverRoots(): string[] {
    const override = providerConfig(this.id)?.paths;
    if (override !== undefined && override.length > 0) return override;
    return [t3codeStateDbDir()];
  },

  listFiles(root: string): string[] {
    const file = stateDbFile(root);
    try {
      return fs.statSync(file).isFile() ? [file] : [];
    } catch {
      return [];
    }
  },

  // SQLite — the JSONL scan loop finds no parseable lines. scanDb below
  // replaces it; this is never called.
  parseLine(_line: string, _ctx: EntryContext): [] {
    return [];
  },

  scanDb: scanT3CodeUsageEvents,

  extractSessionDocs: extractT3SessionDocs,
};
