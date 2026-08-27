import fs from "node:fs";
import path from "node:path";

import type { Database } from "bun:sqlite";

import { PROVIDERS } from "./providers/index.ts";
import type { Provider, SessionDoc } from "./providers/types.ts";
import { cleanSessionText, sessionTitle } from "./sessionText.ts";

/**
 * FTS5 full-text index over session conversations. Freshness is keyed per
 * store file on (mtimeMs, size) — independent of scan cursors, so indexing
 * never disturbs the usage-event pipeline.
 *
 * Column order matters for snippet(): 0=session_id, 1=provider, 2=account_key,
 * 3=started_at, 4=title, 5=body, 6=file. snippet(...,-1,...) picks the best
 * matching column automatically.
 */
export function ensureSessionFts(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED,
      provider UNINDEXED,
      account_key UNINDEXED,
      started_at UNINDEXED,
      title,
      body,
      file UNINDEXED
    );
    CREATE TABLE IF NOT EXISTS fts_files (
      file TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
}

export interface SessionIndexStats {
  filesIndexed: number;
  docsIndexed: number;
  durationMs: number;
  /** True when a recent index run made this call a no-op (throttle). */
  throttled?: boolean;
  /** Files exceeding MAX_INDEX_FILE_BYTES, not indexed. */
  skippedLargeFiles?: number;
}

/** Guard truly pathological stores while still indexing normal long-running
 * Codex rollouts. Extractors cap indexed text separately, so a 100–200MB
 * append-only rollout does not create an equivalently large FTS row. */
const MAX_INDEX_FILE_BYTES = 256 * 1024 * 1024;
/** Minimum interval between full incremental index runs (search-call path). */
const UPDATE_THROTTLE_MS = 120_000;
// Bump whenever extraction changes materially; otherwise an existing local
// index would keep stale titles/bodies until every source file changes.
const EXTRACTOR_VERSION = "4";

function ensureExtractorVersion(db: Database): void {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    const row = db.query("SELECT value FROM meta WHERE key = 'fts_extractor_version'").get() as { value?: string } | undefined;
    if (row?.value === EXTRACTOR_VERSION) return;
    db.exec("DELETE FROM sessions_fts; DELETE FROM fts_files;");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_extractor_version', ?)").run(EXTRACTOR_VERSION);
  } catch {
    // Bare test databases may not expose metadata; normal indexing remains usable.
  }
}

function lastIndexRunMs(db: Database): number {
  try {
    const row = db
      .query("SELECT value FROM meta WHERE key = 'fts_last_update_ms'")
      .get() as { value?: string } | undefined;
    return row?.value !== undefined ? Number(row.value) : 0;
  } catch {
    return 0; // meta table absent (bare test dbs)
  }
}

function markIndexRun(db: Database, t0Ms: number): void {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_last_update_ms', ?)").run(String(t0Ms));
  } catch {
    // best-effort
  }
}

/** Drop and rebuild the whole index from every provider's stores. Always
 * bypasses the update throttle — explicit user action. */
export function rebuildSessionIndex(db: Database, providers: Provider[] = PROVIDERS): SessionIndexStats {
  const t0 = performance.now();
  ensureSessionFts(db);
  ensureExtractorVersion(db);
  db.exec("DELETE FROM sessions_fts; DELETE FROM fts_files;");
  const stats = updateSessionIndex(db, providers, { force: true });
  markIndexRun(db, Date.now());
  return { ...stats, durationMs: Math.round(performance.now() - t0) };
}

/**
 * Index only store files whose (mtimeMs, size) changed since the last run.
 * Providers without extractSessionDocs are skipped.
 */
export function updateSessionIndex(
  db: Database,
  providers: Provider[] = PROVIDERS,
  opts: { force?: boolean; throttleMs?: number; maxFileBytes?: number } = {},
): SessionIndexStats {
  const t0 = performance.now();
  ensureSessionFts(db);
  // Throttle: searches must stay fast; a fresh incremental pass is only
  // needed when store files actually changed since the last pass.
  const throttleMs = opts.throttleMs ?? UPDATE_THROTTLE_MS;
  if (opts.force !== true && Date.now() - lastIndexRunMs(db) < throttleMs) {
    return { filesIndexed: 0, docsIndexed: 0, durationMs: Math.round(performance.now() - t0), throttled: true };
  }
  let skippedLargeFiles = 0;
  const fileRows = db.query("SELECT file, mtime_ms, size FROM fts_files").all() as Array<{
    file: string;
    mtime_ms: number;
    size: number;
  }>;
  const known = new Map(fileRows.map((r) => [r.file, r]));

  const insertDoc = db.prepare(
    `INSERT INTO sessions_fts (session_id, provider, account_key, started_at, title, body, file)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFile = db.prepare("INSERT OR REPLACE INTO fts_files (file, mtime_ms, size) VALUES (?, ?, ?)");
  const deleteFile = db.prepare("DELETE FROM sessions_fts WHERE file = ?");
  const deleteFileState = db.prepare("DELETE FROM fts_files WHERE file = ?");

  let filesIndexed = 0;
  let docsIndexed = 0;

  const tx = db.transaction((provider: Provider, file: string, mtimeMs: number, size: number, docs: SessionDoc[]) => {
    deleteFile.run(file);
    deleteFileState.run(file);
    for (const doc of docs) {
      insertDoc.run(doc.sessionId, provider.id, doc.accountKey ?? null, doc.startedAt ?? null, doc.title, doc.body, file);
    }
    insertFile.run(file, Math.round(mtimeMs), size);
  });

  for (const provider of providers) {
    if (provider.extractSessionDocs === undefined) continue;
    const roots = provider.discoverRoots();
    for (const root of roots) {
      for (const file of provider.listFiles(root)) {
        let st: fs.Stats;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        const mtimeMs = Math.round(st.mtimeMs);
        const prev = known.get(file);
        if (prev !== undefined && prev.mtime_ms === mtimeMs && prev.size === st.size) continue;
        // DB-backed stores (scanDb providers) extract via bounded SQL queries,
        // not whole-file reads — the byte cap exists to protect against
        // reading giant JSONL/JSON files and must not exclude them.
        if (
          provider.scanDb === undefined &&
          st.size > (opts.maxFileBytes ?? MAX_INDEX_FILE_BYTES)
        ) {
          skippedLargeFiles += 1;
          continue;
        }
        let docs: SessionDoc[];
        try {
          docs = provider.extractSessionDocs!(file);
        } catch {
          continue;
        }
        tx(provider, file, mtimeMs, st.size, docs);
        filesIndexed += 1;
        docsIndexed += docs.length;
      }
    }
  }

  markIndexRun(db, Date.now());
  return { filesIndexed, docsIndexed, durationMs: Math.round(performance.now() - t0), skippedLargeFiles };
}

export interface SessionSearchRow {
  provider: string;
  sessionId: string;
  accountKey: string;
  startedAt: string;
  title: string;
  /** Snippet with [[match]] markers around hits. */
  snippet: string;
  requests: number;
  totalTokens: number;
  cachePct: number;
  costUsd: number;
  repos: string[];
}

export interface SessionSearchOptions {
  query: string;
  providers?: string[];
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
  offset?: number;
}

/**
 * Quote each whitespace-separated term so FTS5 never sees user syntax
 * (column filters, NEAR, boolean ops, quotes). Terms AND together; embedded
 * double quotes are doubled per FTS5 string-literal rules.
 */
export function escapeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  return terms.join(" ");
}

export interface SessionSearchResult {
  rows: SessionSearchRow[];
  hasMore: boolean;
  /** Milliseconds spent in the MATCH query itself. */
  searchMs: number;
}

/** Full-text session search with snippet highlights + event aggregates. */
export function searchSessions(db: Database, opts: SessionSearchOptions): SessionSearchResult {
  ensureSessionFts(db);
  const match = escapeFtsQuery(opts.query);
  if (match.length === 0) return { rows: [], hasMore: false, searchMs: 0 };

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  const providerFilter =
    opts.providers !== undefined && opts.providers.length > 0
      ? `AND provider IN (${opts.providers.map(() => "?").join(",")})`
      : "";

  const t0 = performance.now();
  // MATCH + rank first; snippet() cannot run inside a grouped query, so hits
  // are resolved to rowids here and enriched one-by-one below.
  const hits = db
    .query(
      `
      SELECT rowid, session_id AS sessionId, provider
      FROM sessions_fts
      WHERE sessions_fts MATCH ? ${providerFilter}
      ORDER BY rank
      LIMIT ? OFFSET ?
      `,
    )
    .all(match, ...((opts.providers?.length ?? 0) > 0 ? opts.providers! : []), limit + 1, offset) as Array<{
    rowid: number;
    sessionId: string;
    provider: string;
  }>;
  const searchMs = Math.round(performance.now() - t0);

  const hasMore = hits.length > limit;
  const page = hits.slice(0, limit);

  const metaStmt = db.query(
    "SELECT account_key, started_at, title, body FROM sessions_fts WHERE rowid = ?",
  );

  // Aggregate usage numbers for the page's sessions from the events table
  // (absent on bare test databases — degrade to zeros).
  const hasEvents =
    (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").all() as unknown[]).length > 0;
  const aggStmt = hasEvents
    ? db.prepare(
        `SELECT COUNT(*) AS requests,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
            COALESCE(SUM(cache_read_tokens + cache_write_tokens), 0) AS cached,
            COALESCE(SUM(cost_usd), 0) AS cost,
            GROUP_CONCAT(DISTINCT COALESCE(r.name, '(no repo)')) AS repos
     FROM events e LEFT JOIN repo_dirs r ON e.project_dir = r.dir
     WHERE e.provider = ? AND e.session_id = ?`,
      )
    : null;

  const rows: SessionSearchRow[] = [];
  const terms = opts.query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const hit of page) {
    const meta = metaStmt.get(hit.rowid) as {
      account_key: string | null;
      started_at: string | null;
      title: string | null;
      body: string;
    };
    const agg =
      aggStmt !== null
        ? (aggStmt.get(hit.provider, hit.sessionId) as {
            requests: number;
            tokens: number;
            cached: number;
            cost: number;
            repos: string | null;
          })
        : { requests: 0, tokens: 0, cached: 0, cost: 0, repos: null };
    const totalTokens = Number(agg.tokens ?? 0);
    const cached = Number(agg.cached ?? 0);
    const startedAt = meta.started_at ?? "";
    const rawTitle = meta.title ?? "";
    const displayTitle = rawTitle.includes("recommended_plugins") || rawTitle.trim().startsWith("<")
      || rawTitle.toLowerCase().includes("here is a list of plugins")
      || (rawTitle.trim().startsWith("-") && meta.body.toLowerCase().includes("here is a list of plugins"))
      ? sessionTitle(meta.body)
      : sessionTitle(rawTitle);
    // Window filters apply to the session start (post-MATCH, cheap).
    if (opts.sinceIso !== undefined && startedAt !== "" && startedAt < opts.sinceIso) continue;
    if (opts.untilIso !== undefined && startedAt !== "" && startedAt > opts.untilIso) continue;
    rows.push({
      provider: hit.provider,
      sessionId: hit.sessionId,
      accountKey: meta.account_key ?? "default",
      startedAt,
      title: displayTitle,
      snippet: makeSnippet(`${sessionTitle(meta.title ?? "")}\n${cleanSessionText(meta.body)}`, terms),
      requests: Number(agg.requests ?? 0),
      totalTokens,
      cachePct: totalTokens > 0 ? Math.round((cached / totalTokens) * 100) : 0,
      costUsd: Number(agg.cost ?? 0),
      repos: agg.repos ? agg.repos.split(",").filter(Boolean) : [],
    });
  }

  return { rows, hasMore, searchMs };
}

/** Return the indexed conversation body for a session, bounded for UI use. */
export function sessionConversation(
  db: Database,
  provider: string,
  sessionId: string,
): { title: string; body: string } | null {
  ensureSessionFts(db);
  const row = db
    .query(
      `SELECT title, body FROM sessions_fts
       WHERE provider = ? AND session_id = ?
       ORDER BY length(body) DESC LIMIT 1`,
    )
    .get(provider, sessionId) as { title?: string | null; body?: string | null } | undefined;
  if (row == null) return null;
  const body = cleanSessionText(String(row.body ?? ""));
  return { title: sessionTitle(row.title ?? body), body: body.slice(0, 12_000) };
}

/** Compact metadata for leaderboard rows, backed by the same indexed body as
 * search/detail. This keeps recent-session views useful when a harness does
 * not persist a first-class title. */
export function sessionPreview(
  db: Database,
  provider: string,
  sessionId: string,
): { title: string; snippet: string } | null {
  const conversation = sessionConversation(db, provider, sessionId);
  if (conversation === null) return null;
  const lines = conversation.body.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = conversation.title.trim() || lines[0]?.slice(0, 200) || "";
  const snippet = (lines.slice(0, 3).join(" ") || title).slice(0, 300);
  return { title, snippet };
}

/**
 * Bun's sqlite build ships a broken snippet(), so we cut our own window:
 * find the earliest occurrence of any query term and mark every term hit
 * inside a ~±100-char window with [[ ]].
 */
function makeSnippet(text: string, terms: string[]): string {
  if (terms.length === 0) return text.slice(0, 200);
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (first < 0 || idx < first)) first = idx;
  }
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, first + 160);
  let slice = text.slice(start, end);
  if (start > 0) slice = "…" + slice;
  if (end < text.length) slice += "…";
  // Mark term hits (longest terms first so overlaps keep the longer marker).
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
    slice = slice.replace(re, (m) => `[[${m}]]`);
  }
  return slice;
}

/** Store-file key helper used by tests. */
export function ftsFileKey(file: string): string {
  return path.resolve(file);
}
