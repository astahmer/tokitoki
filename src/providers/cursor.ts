import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import type { UsageEvent } from "../types.ts";
import { eventId } from "../machine.ts";
import { estimateCost, estimateTokensFromChars } from "../pricing.ts";
import { providerConfig } from "../config.ts";
import { homePath, type DbScanContext, type EntryContext, type Provider, type SessionDoc } from "./types.ts";

/**
 * Cursor's data is split across two directories:
 *
 *   ~/.cursor/ai-tracking/ai-code-tracking.db  — AI activity tracking:
 *                                      ai_code_hashes (one row per generated
 *                                      file hash: requestId, conversationId,
 *                                      timestamp ms, model),
 *                                      conversation_summaries (title/tldr/
 *                                      overview/summaryBullets/model/mode)
 *   <IDE data dir>/User/globalStorage/state.vscdb — VS Code-style IDE state.
 *                                      `composerData:<uuid>` ItemTable keys
 *                                      hold composer transcripts; the
 *                                      `cursorDiskKV` table holds per-message
 *                                      `bubbleId:<composerId>:<uuid>` rows.
 *                                      IDE data dir: macOS
 *                                      `~/Library/Application Support/Cursor`,
 *                                      Windows `%APPDATA%/Cursor`, else
 *                                      `~/.config/Cursor` — NOT `~/.cursor`,
 *                                      which only holds CLI/agent config.
 *
 * Inspected 2026-09-01: neither store carries a real cost, and bubble rows'
 * `tokenCount` field is always `{inputTokens:0,outputTokens:0}` — Cursor's
 * local IDE build never populates it. So this provider never reports an
 * exact cost; scanDb below estimates tokens from message length instead
 * (chars/4, same heuristic as other local Cursor-usage trackers) rather than
 * silently reporting sessions as zero-cost.
 */
export const CURSOR_NO_USAGE_NOTE =
  "no exact token/cost data exposed locally — usage is estimated from message length";

/** Cursor IDE's VS Code-style data dir (state.vscdb lives under here) — also used by poll.ts's quota fetch. */
export function cursorIdeDir(): string {
  if (process.platform === "darwin") return `${process.env.HOME ?? "~"}/Library/Application Support/Cursor`;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData.length > 0) return path.join(appData, "Cursor");
    return `${process.env.HOME ?? "~"}/AppData/Roaming/Cursor`;
  }
  return `${process.env.HOME ?? "~"}/.config/Cursor`;
}

export function cursorRoots(): string[] {
  const override = providerConfig("cursor")?.paths;
  if (override !== undefined && override.length > 0) return override;
  const cliDir = homePath("CURSOR_DIR", "/.cursor");
  const ideDir = cursorIdeDir();
  return ideDir === cliDir ? [cliDir] : [cliDir, ideDir];
}

export function cursorFiles(root: string): string[] {
  const candidates = [
    path.join(root, "User", "globalStorage", "state.vscdb"),
    path.join(root, "ai-tracking", "ai-code-tracking.db"),
  ];
  return candidates.filter((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
}

function openReadonly(file: string): Database | undefined {
  try {
    return new Database(file, { readonly: true });
  } catch {
    return undefined;
  }
}

/**
 * Transcript/summary extraction. Reads whatever is present:
 * - ai-code-tracking.db.conversation_summaries (schema verified on disk)
 * - state.vscdb ItemTable `composerData:*` blobs (tolerant: pulls title +
 *   user/assistant text fields out of arbitrary JSON shapes)
 */
export function extractCursorSessionDocs(file: string): SessionDoc[] {
  if (file.endsWith("ai-code-tracking.db")) return summarizeDocs(file);
  if (file.endsWith("state.vscdb")) return composerDocs(file);
  return [];
}

function summarizeDocs(file: string): SessionDoc[] {
  const db = openReadonly(file);
  if (db === undefined) return [];
  const docs: SessionDoc[] = [];
  try {
    let hasTable = false;
    try {
      hasTable =
        db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")
          .get() !== undefined;
    } catch {
      hasTable = false;
    }
    if (!hasTable) return [];
    const rows = db
      .query<Record<string, unknown>, []>(
        "SELECT conversationId, title, tldr, overview, summaryBullets, model, updatedAt FROM conversation_summaries",
      )
      .all();
    for (const r of rows) {
      const id = typeof r.conversationId === "string" ? r.conversationId : undefined;
      if (id === undefined) continue;
      const title = typeof r.title === "string" ? r.title : "";
      const parts = [r.tldr, r.overview, r.summaryBullets].filter((v): v is string => typeof v === "string");
      const body = parts.join("\n").slice(0, 512 * 1024);
      if (title.length === 0 && body.length === 0) continue;
      const model = typeof r.model === "string" ? r.model : undefined;
      docs.push({
        sessionId: id,
        accountKey: model,
        startedAt: typeof r.updatedAt === "number" ? new Date(r.updatedAt).toISOString() : undefined,
        title: title.slice(0, 200),
        body: body.length > 0 ? body : title,
      });
    }
  } catch {
    // unreadable/corrupt db — contribute nothing rather than guessing
  } finally {
    db.close();
  }
  return docs;
}

function composerDocs(file: string): SessionDoc[] {
  const db = openReadonly(file);
  if (db === undefined) {
    if (process.env.TOKITOKI_DEBUG) console.error("composerDocs: cannot open", file);
    return [];
  }
  const docs: SessionDoc[] = [];
  try {
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM ItemTable WHERE key LIKE 'composerData:%'")
      .all();
    if (process.env.TOKITOKI_DEBUG) console.error("composerDocs rows:", rows.length);
    for (const r of rows) {
      let blob: Record<string, unknown>;
      try {
        blob = JSON.parse(r.value) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = r.key.slice("composerData:".length);
      const title = typeof blob.name === "string" ? blob.name : "";
      const body = collectText(blob).slice(0, 512 * 1024);
      if (title.length === 0 && body.length === 0) continue;
      docs.push({ sessionId: id, title: title.slice(0, 200), body: body.length > 0 ? body : title });
    }
  } catch (err) {
    if (process.env.TOKITOKI_DEBUG) console.error("composerDocs error:", err);
    // missing ItemTable or incompatible shape — nothing to index
  } finally {
    db.close();
  }
  return docs;
}

/** Depth-limited harvest of human-readable strings from an arbitrary blob. */
function collectText(value: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (typeof value === "string") {
    // keep conversational-looking strings only; ids/hashes dominate otherwise
    return value.length >= 24 && /\s/.test(value) ? `${value.replace(/\s+/g, " ").trim()}\n` : "";
  }
  if (Array.isArray(value)) return value.map((v) => collectText(v, depth + 1)).join("");
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ((obj.type === "user" || obj.type === 1 || obj.role === "user") && typeof obj.text === "string") {
      return `${obj.text.replace(/\s+/g, " ").trim()}\n`;
    }
    return Object.values(obj)
      .map((v) => collectText(v, depth + 1))
      .join("");
  }
  return "";
}

/** Extract `<composerId>` from a `bubbleId:<composerId>:<bubbleUuid>` key. */
function composerIdFromBubbleKey(key: string): string | null {
  const parts = key.split(":");
  const id = parts[1];
  return parts.length >= 3 && id !== undefined && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

interface BubbleRow {
  rowid: number;
  key: string;
  type: number | null;
  text: string | null;
  model: string | null;
  createdAt: string | null;
}

/**
 * Estimated per-turn UsageEvents from `cursorDiskKV` bubble rows (see the
 * module doc for why this is an estimate, not real usage). Only state.vscdb
 * carries this table — ai-code-tracking.db has no per-message text at all.
 * Incremental via a rowid watermark in ctx.state, like opencode's scanDb.
 */
function scanCursorBubbleUsage(storePath: string, ctx: DbScanContext): UsageEvent[] {
  if (!storePath.endsWith("state.vscdb")) return [];
  const db = openReadonly(storePath);
  if (db === undefined) return [];
  try {
    let hasKV = false;
    try {
      hasKV =
        db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
          .get() !== undefined;
    } catch {
      hasKV = false;
    }
    if (!hasKV) return [];

    const watermark = typeof ctx.state.bubbleRowid === "number" ? ctx.state.bubbleRowid : 0;
    const rows = db
      .prepare(
        `SELECT rowid, key,
                json_extract(value, '$.type') as type,
                json_extract(value, '$.text') as text,
                json_extract(value, '$.modelInfo.modelName') as model,
                json_extract(value, '$.createdAt') as createdAt
         FROM cursorDiskKV
         WHERE key LIKE 'bubbleId:%' AND rowid > ?
         ORDER BY rowid ASC LIMIT 50000`,
      )
      .all(watermark) as BubbleRow[];

    const events: UsageEvent[] = [];
    // type 1 = user turn, type 2 = assistant reply (verified against a real
    // store 2026-09-01). Pair each assistant reply with the char length of
    // the user turn that immediately preceded it in the same composer.
    const lastUserChars = (ctx.state.lastUserChars ??= {}) as Record<string, number>;
    for (const row of rows) {
      ctx.state.bubbleRowid = row.rowid;
      const composerId = composerIdFromBubbleKey(row.key);
      if (composerId === null) continue;
      const text = row.text ?? "";
      if (row.type === 1) {
        lastUserChars[composerId] = text.length;
        continue;
      }
      if (row.type !== 2 || text.length === 0) continue;
      const inputTokens = estimateTokensFromChars(lastUserChars[composerId] ?? 0);
      delete lastUserChars[composerId];
      const outputTokens = estimateTokensFromChars(text.length);
      const model = row.model ?? "cursor-auto";
      const costUsd = estimateCost(model, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
      events.push({
        id: eventId("cursor", "default", composerId, row.key),
        ts: row.createdAt ?? new Date(0).toISOString(),
        machineId: ctx.machineId,
        provider: "cursor",
        accountKey: "default",
        model,
        inputTokens,
        outputTokens,
        costUsd,
        sessionId: composerId,
      });
    }
    return events;
  } finally {
    db.close();
  }
}

export const cursorProvider: Provider = {
  id: "cursor",
  label: "Cursor",
  envVar: "CURSOR_DIR",
  usageNote: CURSOR_NO_USAGE_NOTE,

  discoverRoots: cursorRoots,
  listFiles: cursorFiles,

  // Binary sqlite — the JSONL scan loop finds no parseable lines. scanDb
  // below replaces it; this is never called.
  parseLine(_line: string, _ctx: EntryContext): [] {
    return [];
  },

  scanDb: scanCursorBubbleUsage,

  extractSessionDocs: extractCursorSessionDocs,
};
