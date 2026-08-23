import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { providerConfig } from "../config.ts";
import { homePath, type EntryContext, type Provider, type SessionDoc } from "./types.ts";

/**
 * Cursor keeps its data in two sqlite databases under ~/.cursor:
 *
 *   User/globalStorage/state.vscdb   — IDE state; composer/chat transcripts
 *                                      live under ItemTable keys like
 *                                      `composerData:<uuid>` (JSON blobs)
 *   ai-tracking/ai-code-tracking.db  — AI activity tracking:
 *                                      ai_code_hashes (one row per generated
 *                                      file hash: requestId, conversationId,
 *                                      timestamp ms, model),
 *                                      conversation_summaries (title/tldr/
 *                                      overview/summaryBullets/model/mode)
 *
 * Inspected 2026-08-24 (ai-code-tracking.db, 199k hash rows): NEITHER store
 * carries token counts or costs — only request/activity traces. Per repo rule
 * this provider never fabricates UsageEvents; it contributes search-index
 * docs (summaries + transcript text when readable) and honest provenance.
 */
export const CURSOR_NO_USAGE_NOTE =
  "no token usage exposed (activity hashes + summaries only — no token counts in any inspected store)";

export function cursorRoots(): string[] {
  const override = providerConfig("cursor")?.paths;
  if (override !== undefined && override.length > 0) return override;
  return [homePath("CURSOR_DIR", "/.cursor")];
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

export const cursorProvider: Provider = {
  id: "cursor",
  label: "Cursor",
  envVar: "CURSOR_DIR",
  usageNote: CURSOR_NO_USAGE_NOTE,

  discoverRoots: cursorRoots,
  listFiles: cursorFiles,

  // Binary sqlite — the JSONL scan loop finds no parseable lines. Search
  // indexing goes through extractSessionDocs instead.
  parseLine(_line: string, _ctx: EntryContext): [] {
    return [];
  },

  extractSessionDocs: extractCursorSessionDocs,
};
