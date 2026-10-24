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
 * T3 Code's live store since Orchestrator V2 is
 * ~/.t3/userdata/statev2.sqlite. state.sqlite is the V1 database and stops
 * receiving threads once V2 exists. V2 turns may carry turnTokenUsage.
 * All T3 rows stay available as application activity and session detail,
 * outside account totals already supplied by the underlying harnesses.
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
 * V1 still has no per-turn token counts, so that file stays a chars/4
 * estimate. V2 turns use turnTokenUsage and are not added to totals.
 */
export const T3CODE_NO_USAGE_NOTE =
  "T3 Code activity is shown separately and excluded from totals; the underlying harnesses supply account usage. Costs shown via T3 Code are estimates.";

export function t3codeStateDbDir(): string {
  return homePath("T3CODE_DIR", "/.t3/userdata");
}

function stateDbFile(root: string): string {
  const v2 = path.join(root, "statev2.sqlite");
  try {
    if (fs.statSync(v2).isFile()) return v2;
  } catch {
    // V1-only installs still use state.sqlite.
  }
  return path.join(root, "state.sqlite");
}

function isV2Store(db: Database): boolean {
  return hasTables(db, ["orchestration_v2_projection_threads", "orchestration_v2_projection_messages"]);
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
  return names.every((n) => stmt.get(n) != null);
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

function payloadText(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function modelFromThreadPayload(payload: string | null): { instanceId: string; model: string } | undefined {
  if (payload === null) return undefined;
  try {
    const parsed = JSON.parse(payload) as { providerInstanceId?: unknown; modelSelection?: { instanceId?: unknown; model?: unknown } };
    const instanceId = typeof parsed.modelSelection?.instanceId === "string" && parsed.modelSelection.instanceId.length > 0
      ? parsed.modelSelection.instanceId
      : typeof parsed.providerInstanceId === "string" ? parsed.providerInstanceId : "";
    const model = typeof parsed.modelSelection?.model === "string" ? parsed.modelSelection.model : "unknown";
    if (instanceId.length === 0) return undefined;
    return { instanceId, model };
  } catch {
    return undefined;
  }
}

function extractV2SessionDocs(db: Database): SessionDoc[] {
  const threads = db
    .prepare(
      `SELECT thread_id, title, created_at, payload_json, provider_instance_id
       FROM orchestration_v2_projection_threads
       WHERE deleted_at IS NULL`,
    )
    .all() as Array<{
    thread_id: string;
    title: string;
    created_at: string;
    payload_json: string;
    provider_instance_id: string | null;
  }>;
  const bodyStmt = db.prepare(
    `SELECT role, payload_json FROM orchestration_v2_projection_messages
     WHERE thread_id = ? AND role IN ('user', 'assistant')
     ORDER BY created_at ASC LIMIT 4000`,
  );
  const docs: SessionDoc[] = [];
  for (const thread of threads) {
    const rows = bodyStmt.all(thread.thread_id) as Array<{ role: string; payload_json: string }>;
    const parts: string[] = [];
    let len = 0;
    for (const row of rows) {
      const text = payloadText(row.payload_json);
      if (text.length === 0) continue;
      parts.push(text);
      len += text.length;
      if (len >= BODY_CAP) break;
    }
    const body = parts.join("\n").slice(0, BODY_CAP);
    if (thread.title.length === 0 && body.length === 0) continue;
    const routed = modelFromThreadPayload(thread.payload_json);
    docs.push({
      sessionId: thread.thread_id,
      accountKey: routed?.instanceId ?? thread.provider_instance_id ?? "default",
      startedAt: thread.created_at,
      title: thread.title.slice(0, 200),
      body: body.length > 0 ? body : thread.title,
    });
  }
  return docs;
}

/** Observed per-turn activity; underlying harnesses supply account totals. */
function scanV2Turns(db: Database, ctx: DbScanContext): UsageEvent[] {
  if (!hasTables(db, ["orchestration_v2_projection_provider_turns"])) return [];
  const watermark = ctx.state.turnUsageVersion === 1 && typeof ctx.state.turnRowid === "number" ? ctx.state.turnRowid : 0;
  ctx.state.turnUsageVersion = 1;
  const rows = db
    .prepare(
      `SELECT t.rowid, t.provider_turn_id, t.thread_id, t.completed_at, t.started_at, t.payload_json,
              th.provider_instance_id, th.payload_json AS thread_payload
       FROM orchestration_v2_projection_provider_turns t
       JOIN orchestration_v2_projection_threads th ON th.thread_id = t.thread_id
       WHERE t.rowid > ?
       ORDER BY t.rowid ASC LIMIT 5000`,
    )
    .all(watermark) as Array<{
    rowid: number;
    provider_turn_id: string;
    thread_id: string;
    completed_at: string | null;
    started_at: string | null;
    payload_json: string;
    provider_instance_id: string | null;
    thread_payload: string;
  }>;
  const events: UsageEvent[] = [];
  for (const row of rows) {
    ctx.state.turnRowid = row.rowid;
    const routed = modelFromThreadPayload(row.thread_payload);
    const instanceId = routed?.instanceId ?? row.provider_instance_id ?? "";
    if (instanceId.length === 0) continue;
    let usage: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(row.payload_json) as { turnTokenUsage?: unknown; status?: unknown };
      if (parsed.status !== "completed" || typeof parsed.turnTokenUsage !== "object" || parsed.turnTokenUsage === null) continue;
      usage = parsed.turnTokenUsage as Record<string, unknown>;
    } catch {
      continue;
    }
    if (usage.usageStatus === "unavailable") continue;
    const count = (key: string): number => {
      const value = usage?.[key];
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
    };
    const inputTokens = count("inputTokens");
    const outputTokens = count("outputTokens");
    const cacheReadTokens = count("cachedInputTokens");
    const cacheWriteTokens = count("cacheCreationTokens");
    if (inputTokens === 0 && outputTokens === 0) continue;
    const model = routed?.model ?? "unknown";
    const ts = row.completed_at ?? row.started_at;
    if (ts === null) continue;
    events.push({
      id: eventId("t3code", instanceId, row.thread_id, row.provider_turn_id),
      ts,
      machineId: ctx.machineId,
      provider: "t3code",
      accountKey: instanceId,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: estimateCost(model, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }),
      sessionId: row.thread_id,
    });
  }
  return events;
}

export function extractT3SessionDocs(storePath: string): SessionDoc[] {
  const db = openStore(storePath);
  if (db === undefined) return [];
  try {
    if (isV2Store(db)) return extractV2SessionDocs(db);
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
    if (isV2Store(db)) return scanV2Turns(db, ctx);
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
