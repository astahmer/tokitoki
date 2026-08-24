import path from "node:path";

import fs from "node:fs";
import { Database, type SQLQueryBindings } from "bun:sqlite";

import type { QuotaWindow, UsageEvent } from "./types.ts";
import { dataDir, eventsFile, readEventsFile, readEventsTail } from "./store.ts";import { resolveRepo } from "./repos.ts";
import { ensureSessionFts } from "./sessionIndex.ts";
import { EXTRACTION_VERSION } from "./scan.ts";

/**
 * SQLite cache over the merged event logs. Rebuildable at any time: it is a
 * pure projection of (local + extra) JSONL files deduped on event id.
 */
interface UsageRow {
  tokens: number;
  cost: number;
  requests: number;
}

const ZERO_ROW: UsageRow = { tokens: 0, cost: 0, requests: 0 };

export interface QuotaSnapshotRow {
  accountKey: string;
  windowMinutes: number;
  usedPct: number;
  resetsAt: number;
  creditsJson: string | null;
  capturedAt: string;
}
export class EventCache {
  private db: Database;
  private repoStmtInsert: ReturnType<Database["prepare"]>;
  /** Injectable for tests; defaults to real filesystem resolution. */
  private repoNameFor: (dir: string) => string;

  constructor(dbPath?: string, repoNameFor?: (dir: string) => string) {
    const p = dbPath ?? path.join(dataDir(), "cache.db");
    this.db = new Database(p, { create: true });
    // Concurrent invocations are normal (menubar polls every 5 min, web serves
    // on demand, users run CLI in parallel): WAL + busy timeout so writers
    // queue instead of failing with SQLITE_BUSY.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;");
    this.repoNameFor = repoNameFor ?? ((dir: string) => resolveRepo(dir).name);
    this.migrate();
    this.repoStmtInsert = this.db.prepare(
      "INSERT OR REPLACE INTO repo_dirs (dir, name) VALUES (?, ?)",
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        project_dir TEXT,
        session_id TEXT,
        tool TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE TABLE IF NOT EXISTS repo_dirs (
        dir TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    // Older caches predate the tool column; ALTER is idempotent-guarded.
    const cols = this.db.query("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "tool")) {
      this.db.exec("ALTER TABLE events ADD COLUMN tool TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL,
        window_minutes INTEGER NOT NULL,
        used_pct REAL NOT NULL,
        resets_at INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        event_id TEXT NOT NULL,
        credits_json TEXT,
        PRIMARY KEY (provider, account_key, window_minutes, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_lookup
        ON quota_snapshots(provider, account_key, captured_at);
    `);
    try {
      ensureSessionFts(this.db);
    } catch {
      // fts5 unavailable in this sqlite build — search features degrade.
    }
  }

  /** Raw database handle (used by the session search index). */
  get database(): Database {
    return this.db;
  }

  /**
   * True when the cache was built by older extraction logic (e.g. before the
   * tool dimension existed) and must be rebuilt from the event logs even
   * though event ids are unchanged.
   */
  isStaleFor(extractionVersion: number): boolean {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'extraction_version'")
      .get() as { value?: string } | undefined;
    return row?.value !== String(extractionVersion);
  }

  markExtractionVersion(extractionVersion: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('extraction_version', ?)")
      .run(String(extractionVersion));
  }

  /** Insert events, ignoring duplicates (dedupe on the stable id). */
  insert(events: UsageEvent[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        id, ts, machine_id, provider, account_key, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, project_dir, session_id, tool
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((rows: UsageEvent[]) => {
      let inserted = 0;
      for (const e of rows) {
        inserted += stmt.run(
          e.id,
          e.ts,
          e.machineId,
          e.provider,
          e.accountKey,
          e.model,
          Math.round(e.inputTokens),
          Math.round(e.outputTokens),
          Math.round(e.cacheReadTokens ?? 0),
          Math.round(e.cacheWriteTokens ?? 0),
          e.costUsd ?? 0,
          e.projectDir ?? null,
          e.sessionId ?? null,
          e.tool ?? null,
        ).changes;
      }
      return inserted;
    });
    const n = tx(events) as number;
    this.insertQuotaSnapshots(events);
    return n;
  }

  /**
   * Persist provider-embedded quota snapshots (codex rate_limits). One row
   * per window per event; latest captured_at per (provider, account, window)
   * wins in queries.
   */
  private insertQuotaSnapshots(events: UsageEvent[]): void {
    const rows: Array<{ e: UsageEvent; w: QuotaWindow }> = [];
    for (const e of events) {
      if (e.quota === undefined) continue;
      for (const w of [e.quota.primary, e.quota.secondary]) {
        if (w !== undefined) rows.push({ e, w });
      }
    }
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO quota_snapshots (
        provider, account_key, window_minutes, used_pct, resets_at,
        captured_at, event_id, credits_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const { e, w } of rows) {
        stmt.run(
          e.provider,
          e.accountKey,
          Math.round(w.windowMinutes),
          w.usedPct,
          Math.round(w.resetsAtEpoch),
          e.ts,
          e.id,
          e.quota?.credits !== undefined ? JSON.stringify(e.quota.credits) : null,
        );
      }
    });
    tx();
  }

  /** Full rebuild from all known event log files. */
  rebuild(extraFiles: string[]): void {
    this.db.exec("DELETE FROM events");
    const files = [eventsFile(), ...extraFiles];
    // First occurrence wins (local log precedes synced ones), EXCEPT when a
    // later duplicate is strictly richer than the kept one: tool-attributed
    // beats unattributed, embedded quota beats none (extraction replays
    // re-append enriched events under the same stable id).
    const byId = new Map<string, UsageEvent>();
    const richness = (e: UsageEvent): number => (e.tool !== undefined ? 2 : 0) + (e.quota !== undefined ? 1 : 0);
    for (const file of files) {
      for (const e of readEventsFile(file)) {
        const kept = byId.get(e.id);
        if (kept === undefined || richness(e) > richness(kept)) byId.set(e.id, e);
      }
    }
    this.insert(Array.from(byId.values()));
    this.recordLogOffsets(files);
  }

  /**
   * Upsert with the same richness semantics as rebuild: existing rows are
   * upgraded only when the incoming event is strictly richer (tool and/or
   * quota added). Plain INSERT OR IGNORE keeps first-occurrence-wins.
   */
  private upsertRicher(events: UsageEvent[]): void {
    if (events.length === 0) return;
    this.insert(events);
    const needsTool = events.some((e) => e.tool !== undefined);
    if (!needsTool) return;
    const stmt = this.db.prepare("UPDATE events SET tool = ? WHERE id = ? AND tool IS NULL");
    const tx = this.db.transaction(() => {
      for (const e of events) {
        if (e.tool !== undefined) stmt.run(e.tool, e.id);
      }
    });
    tx();
  }

  // -- log-offset tracking -------------------------------------------------

  /** meta key holding {file → consumed byte offset} for append-only logs. */
  private static LOG_OFFSETS_KEY = "log_offsets";

  private logOffsets(): Record<string, number> {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = ?")
      .get(EventCache.LOG_OFFSETS_KEY) as { value?: string } | undefined;
    if (row?.value === undefined) return {};
    try {
      return JSON.parse(row.value) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private saveLogOffsets(offsets: Record<string, number>): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(EventCache.LOG_OFFSETS_KEY, JSON.stringify(offsets));
  }

  /**
   * Record every known log's current size as consumed. Used after rebuild or
   * after a direct scan-time ingest so sync() does not re-read those bytes.
   */
  recordLogOffsets(files: string[] = [eventsFile()]): void {
    const offsets = this.logOffsets();
    for (const file of files) {
      try {
        offsets[file] = fs.statSync(file).size;
      } catch {
        // file missing — leave any previous entry alone
      }
    }
    this.saveLogOffsets(offsets);
  }

  /** Ensure the cache reflects every line in the local + extra logs. */
  sync(extraFiles: string[]): void {
    // Extraction logic changed since this cache was built → full rebuild
    // (ids are unchanged but derived fields like `tool` may differ).
    if (this.isStaleFor(EXTRACTION_VERSION)) {
      this.rebuild(extraFiles);
      this.markExtractionVersion(EXTRACTION_VERSION);
      return;
    }

    const files = [eventsFile(), ...extraFiles];
    const offsets = this.logOffsets();
    let needsFullRebuild = false;
    const tails: Array<{ file: string; from: number }> = [];
    for (const file of files) {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue; // vanished — nothing to consume
      }
      const from = offsets[file];
      if (from === undefined || from > size) {
        // Never tracked (cache predates offset tracking) or the file shrank /
        // was replaced wholesale by a sync backend → full projection is the
        // only safe answer.
        needsFullRebuild = true;
        break;
      }
      if (from < size) tails.push({ file, from });
    }
    if (needsFullRebuild) {
      this.rebuild(extraFiles);
      return;
    }
    if (tails.length === 0) return;

    // Local log first so first-occurrence-wins matches rebuild semantics,
    // then upgrade enriched duplicates from later logs.
    let offsetsChanged = false;
    for (const { file, from } of tails) {
      const { events, newSize } = readEventsTail(file, from);
      this.upsertRicher(events);
      offsets[file] = newSize;
      offsetsChanged = true;
    }
    if (offsetsChanged) this.saveLogOffsets(offsets);
  }

  count(): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  /**
   * Make sure every distinct project_dir in events has a repo mapping.
   * Dirs are stable, so the table only ever grows; unknown dirs are resolved
   * once via resolveRepo and cached forever.
   */
  /** Distinct (accountKey → provider) pairs seen in the window. */
  accountProviders(sinceIso: string): Map<string, string> {
    const rows = this.db
      .query(
        `SELECT DISTINCT account_key AS key, provider FROM events WHERE ts >= ?`,
      )
      .all(sinceIso) as Array<{ key: string; provider: string }>;
    return new Map(rows.map((r) => [r.key, r.provider]));
  }

  /** Accounts present in the local cache, for `budgets init` seeding. */
  detectedAccounts(): Array<{ provider: string; accountKey: string; events: number }> {
    return this.db
      .query(
        `SELECT provider AS provider, account_key AS accountKey, COUNT(*) AS events
         FROM events GROUP BY provider, account_key ORDER BY events DESC`,
      )
      .all() as Array<{ provider: string; accountKey: string; events: number }>;
  }

  /** Usage summed over an account's events since a cutoff (ISO-8601). */
  windowUsageForAccount(provider: string, accountKey: string, sinceIso: string): {
    tokens: number;
    cost: number;
    requests: number;
  } {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COUNT(*) AS requests
         FROM events WHERE provider = ? AND account_key = ? AND ts >= ?`,
      )
      .get(provider, accountKey, sinceIso) as UsageRow | undefined;
    return row ?? ZERO_ROW;
  }

  /**
   * Latest embedded quota snapshot per window length for one provider+account.
   * Real provider-reported data (currently codex rate_limits only).
   */
  latestQuotaSnapshots(provider: string, accountKey: string): QuotaSnapshotRow[] {
    try {
      return this.db
        .query(
          `SELECT qs.account_key AS accountKey, qs.window_minutes AS windowMinutes,
                  qs.used_pct AS usedPct, qs.resets_at AS resetsAt,
                  qs.credits_json AS creditsJson, qs.captured_at AS capturedAt
           FROM quota_snapshots qs
           JOIN (
             SELECT window_minutes, MAX(captured_at) AS captured_at
             FROM quota_snapshots
             WHERE provider = ? AND account_key = ?
             GROUP BY window_minutes
           ) latest
             ON qs.window_minutes = latest.window_minutes
            AND qs.captured_at = latest.captured_at
           WHERE qs.provider = ? AND qs.account_key = ?`,
        )
        .all(provider, accountKey, provider, accountKey) as QuotaSnapshotRow[];
    } catch {
      // table missing in pre-migration cache — treated as no embedded data
      return [];
    }
  }

  /** All-time per-provider stats for the provenance view. */
  providerStats(): Map<string, { events: number; models: Set<string>; accounts: Set<string> }> {
    const rows = this.db
      .query(
        `SELECT provider, model, account_key, COUNT(*) AS n FROM events GROUP BY provider, model, account_key`,
      )
      .all() as Array<{ provider: string; model: string; account_key: string; n: number }>;
    const out = new Map<string, { events: number; models: Set<string>; accounts: Set<string> }>();
    for (const r of rows) {
      let entry = out.get(r.provider);
      if (entry === undefined) {
        entry = { events: 0, models: new Set(), accounts: new Set() };
        out.set(r.provider, entry);
      }
      entry.events += r.n;
      entry.models.add(r.model);
      if (r.account_key !== null && r.account_key.length > 0) entry.accounts.add(r.account_key);
    }
    return out;
  }

  private ensureRepoMap(): void {
    const dirs = this.db
      .query(
        `SELECT DISTINCT e.project_dir AS dir FROM events e
         WHERE e.project_dir IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM repo_dirs r WHERE r.dir = e.project_dir)`,
      )
      .all() as Array<{ dir: string }>;
    for (const { dir } of dirs) {
      this.repoStmtInsert.run(dir, this.repoNameFor(dir));
    }
  }

  private whereClause(
    providers?: string[],
    untilIso?: string,
    accountKey?: string,
  ): { sql: string; params: SQLQueryBindings[] } {
    const parts = ["ts >= ?"];
    const params: SQLQueryBindings[] = [];
    if (providers !== undefined && providers.length > 0) {
      const placeholders = providers.map(() => "?").join(", ");
      parts.push(`provider IN (${placeholders})`);
      params.push(...providers);
    }
    if (untilIso !== undefined) {
      parts.push("ts < ?");
      params.push(untilIso);
    }
    if (accountKey !== undefined && accountKey.length > 0) {
      parts.push("account_key = ?");
      params.push(accountKey);
    }
    return { sql: parts.join(" AND "), params };
  }

  /**
   * Aggregate events in `[sinceIso, untilIso)` (untilIso open-ended when
   * omitted), grouped by one dimension, optionally filtered to providers.
   */
  aggregate(
    sinceIso: string,
    groupBy: Dimension,
    providers?: string[],
    untilIso?: string,
    accountKey?: string,
  ): AggRow[] {
    // Repo rollup needs the mapping populated before joining on it.
    if (groupBy === "repo") this.ensureRepoMap();
    const column =
      groupBy === "project"
        ? "COALESCE(project_dir, '(no project)')"
        : groupBy === "repo"
          ? "COALESCE(repo_dirs.name, '(no repo)')"
          : groupBy === "account"
            ? "account_key"
            : groupBy === "machine"
              ? "machine_id"
              : groupBy === "tool"
                ? TOOL_BUCKET_SQL
                : groupBy === "provider"
                  ? "provider"
                  : "model";
    const join =
      groupBy === "repo" ? "FROM events LEFT JOIN repo_dirs ON events.project_dir = repo_dirs.dir" : "FROM events";
    const where = this.whereClause(providers, untilIso, accountKey);
    const rows = this.db
      .query(
        `
        SELECT ${column} AS bucket,
               COUNT(*) AS requests,
               COUNT(DISTINCT session_id) AS sessions,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(cost_usd) AS cost_usd
        ${join}
        WHERE ${where.sql}
        GROUP BY bucket
        `,
      )
      .all(sinceIso, ...where.params) as Array<RawAggRow>;
    return rows.map(fromRawRow);
  }

  /** Single TOTAL row over the window (global distinct sessions, no grouping). */
  totals(sinceIso: string, providers?: string[], untilIso?: string, accountKey?: string): AggRow {
    const where = this.whereClause(providers, untilIso, accountKey);
    const row = this.db
      .query(
        `
        SELECT COUNT(*) AS requests,
               COUNT(DISTINCT session_id) AS sessions,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(cost_usd) AS cost_usd
        FROM events
        WHERE ${where.sql}
        `,
      )
      .get(sinceIso, ...where.params) as RawAggRow;
    return fromRawRow({ ...row, bucket: "TOTAL" });
  }

  /**
   * Total + per-account spend for three windows in two queries (instead of
   * six full scans). Used by the post-scan budget banners, which run on every
   * scan and must stay near-free.
   */
  spendSnapshot(dayIso: string, weekIso: string, monthIso: string): {
    totals: { day: number; week: number; month: number };
    accounts: Array<{ key: string; day: number; week: number; month: number }>;
  } {
    const cond = (col: string, a: string, b: string, c: string): string =>
      `SUM(CASE WHEN ts >= ? THEN ${col} ELSE 0 END) AS ${a},` +
      `SUM(CASE WHEN ts >= ? THEN ${col} ELSE 0 END) AS ${b},` +
      `SUM(CASE WHEN ts >= ? THEN ${col} ELSE 0 END) AS ${c}`;
    const params = [dayIso, weekIso, monthIso];
    const totalRow = this.db
      .query(
        `SELECT ${cond("cost_usd", "d", "w", "m")} FROM events`,
      )
      .get(...params) as { d: number; w: number; m: number };
    const accountRows = this.db
      .query(
        `SELECT account_key AS key, ${cond("cost_usd", "d", "w", "m")}
         FROM events WHERE account_key IS NOT NULL AND account_key != ''
         GROUP BY account_key`,
      )
      .all(...params) as Array<{ key: string; d: number; w: number; m: number }>;
    return {
      totals: { day: totalRow.d ?? 0, week: totalRow.w ?? 0, month: totalRow.m ?? 0 },
      accounts: accountRows.map((r) => ({ key: r.key, day: r.d, week: r.w, month: r.m })),
    };
  }

  /** Metrics per local calendar day since `sinceIso` (UTC-stored ts),
   *  optionally bounded above by `untilIso`. */
  dailyTotals(sinceIso: string, untilIso?: string): DailyTotal[] {
    const bound = untilIso !== undefined ? "AND ts < ?" : "";
    const params: SQLQueryBindings[] = untilIso !== undefined ? [sinceIso, untilIso] : [sinceIso];
    const rows = this.db
      .query(
        `
        SELECT date(ts, 'localtime') AS day,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
               SUM(cost_usd) AS cost_usd,
               COUNT(*) AS requests
        FROM events
        WHERE ts >= ? ${bound}
        GROUP BY day
        ORDER BY day
        `,
      )
      .all(...params) as Array<{
        day: string;
        tokens: number | null;
        cost_usd: number | null;
        requests: number | null;
      }>;
    return rows.map((r) => ({
      day: r.day ?? "?",
      tokens: r.tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
      requests: r.requests ?? 0,
    }));
  }

  /**
   * Per-day token series for each of the top `topN` buckets of a dimension.
   * Days are the union across buckets; missing days are 0. Flat GROUP BY
   * query + JS-side top-N selection (a JOIN/CTE form of this was pathologically
   * slow on ~100k rows).
   */
  seriesDaily(sinceIso: string, groupBy: Exclude<Dimension, "project" | "repo">, topN = 5): SeriesBucket[] {
    const column =
      groupBy === "account"
        ? "account_key"
        : groupBy === "machine"
          ? "machine_id"
          : groupBy === "provider"
            ? "provider"
            : "model";
    const rows = this.db
      .query(
        `
        SELECT ${column} AS bucket,
               date(ts, 'localtime') AS day,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
        FROM events
        WHERE ts >= ?
        GROUP BY bucket, day
        `,
      )
      .all(sinceIso) as Array<{ bucket: string; day: string; tokens: number | null }>;

    const totals = new Map<string, number>();
    const byBucket = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const tokens = r.tokens ?? 0;
      totals.set(r.bucket, (totals.get(r.bucket) ?? 0) + tokens);
      let inner = byBucket.get(r.bucket);
      if (inner === undefined) {
        inner = new Map();
        byBucket.set(r.bucket, inner);
      }
      inner.set(r.day, tokens);
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([bucket]) => bucket);
    const days = [...new Set(rows.map((r) => r.day))].sort();
    return top.map((bucket) => {
      const inner = byBucket.get(bucket)!;
      return {
        bucket,
        days,
        values: days.map((d) => inner.get(d) ?? 0),
      };
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * Costliest / heaviest sessions in the window, grouped by (provider,
   * session_id). Ordered by cost desc, tokens desc so free accounts still
   * surface by volume. Null session_ids (events without one) are excluded.
   */
  topSessions(opts: {
    sinceIso: string;
    untilIso?: string;
    providers?: string[];
    accountKey?: string;
    limit?: number;
  }): SessionSummary[] {
    this.ensureRepoMap();
    const where = this.whereClause(opts.providers, opts.untilIso, opts.accountKey);
    const rows = this.db
      .query(
        `
        SELECT e.provider AS provider,
               e.session_id AS session_id,
               MIN(e.ts) AS first_ts,
               MAX(e.ts) AS last_ts,
               COUNT(*) AS requests,
               MIN(e.account_key) AS account_key,
               GROUP_CONCAT(DISTINCT e.model) AS models,
               GROUP_CONCAT(DISTINCT COALESCE(r.name, '(no repo)')) AS repos,
               SUM(e.input_tokens) AS input_tokens,
               SUM(e.output_tokens) AS output_tokens,
               SUM(e.cache_read_tokens) AS cache_read_tokens,
               SUM(e.cache_write_tokens) AS cache_write_tokens,
               SUM(e.cost_usd) AS cost_usd
        FROM events e
        LEFT JOIN repo_dirs r ON e.project_dir = r.dir
        WHERE e.session_id IS NOT NULL AND ${where.sql}
        GROUP BY e.provider, e.session_id
        ORDER BY cost_usd DESC, input_tokens + output_tokens + cache_read_tokens + cache_write_tokens DESC
        LIMIT ?
        `,
      )
      .all(opts.sinceIso, ...where.params, opts.limit ?? 10) as Array<RawSessionRow>;
    return rows.map(sessionFromRaw);
  }

  /** Providers that have events for a session id (drill-down disambiguation). */
  sessionProviders(sessionId: string): string[] {
    const rows = this.db
      .query(
        "SELECT DISTINCT provider FROM events WHERE session_id = ? ORDER BY provider",
      )
      .all(sessionId) as Array<{ provider: string }>;
    return rows.map((r) => r.provider);
  }

  /** Request-by-request timeline for one session, ordered by ts. */
  sessionDetail(provider: string, sessionId: string): SessionEventRow[] {
    const rows = this.db
      .query(
        `
        SELECT ts, model, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, cost_usd
        FROM events
        WHERE provider = ? AND session_id = ?
        ORDER BY ts, id
        `,
      )
      .all(provider, sessionId) as Array<RawSessionEventRow>;
    return rows.map((r) => ({
      ts: r.ts,
      model: r.model,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheWriteTokens: r.cache_write_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
    }));
  }
}

export type Dimension =
  | "model"
  | "project"
  | "repo"
  | "account"
  | "machine"
  | "provider"
  | "tool";

export const DIMENSIONS: Dimension[] = [
  "model",
  "project",
  "repo",
  "account",
  "machine",
  "provider",
  "tool",
];

interface RawAggRow {
  bucket: string;
  requests: number;
  sessions?: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

function fromRawRow(r: RawAggRow): AggRow {
  return {
    bucket: r.bucket,
    requests: r.requests,
    sessions: r.sessions ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheWriteTokens: r.cache_write_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
  };
}

export interface AggRow {
  bucket: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface DailyTotal {
  day: string;
  tokens: number;
  costUsd: number;
  requests: number;
}

export interface SeriesBucket {
  bucket: string;
  days: string[];
  values: number[];
}

interface RawSessionRow {
  provider: string;
  session_id: string | null;
  first_ts: string;
  last_ts: string;
  requests: number;
  account_key: string | null;
  models: string | null;
  repos: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

/** Leaderboard row: one coding-agent session across all its requests. */
export interface SessionSummary {
  sessionId: string;
  provider: string;
  accountKey: string;
  /** First request timestamp (ISO). */
  startedAt: string;
  lastRequestAt: string;
  requests: number;
  models: string[];
  repos: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cachePct: number;
  costUsd: number;
}

function sessionFromRaw(r: RawSessionRow): SessionSummary {
  const inputTokens = r.input_tokens ?? 0;
  const outputTokens = r.output_tokens ?? 0;
  const cacheReadTokens = r.cache_read_tokens ?? 0;
  const cacheWriteTokens = r.cache_write_tokens ?? 0;
  return {
    sessionId: r.session_id ?? "?",
    provider: r.provider,
    accountKey: r.account_key ?? "default",
    startedAt: r.first_ts,
    lastRequestAt: r.last_ts,
    requests: r.requests,
    models: (r.models ?? "?").split(",").filter((m) => m.length > 0),
    repos: (r.repos ?? "(no repo)").split(",").filter((x) => x.length > 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cachePct: cachePctOf(inputTokens, cacheReadTokens),
    costUsd: r.cost_usd ?? 0,
  };
}

function cachePctOf(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens;
  if (denom <= 0) return 0;
  return Math.round((cacheReadTokens / denom) * 100);
}

/**
 * Tool-dimension bucket: provider-qualified so identically-named tools from
 * different harnesses don't merge, with MCP namespacing rolled up to the
 * server (`codex/mcp:pencil`). Unattributed turns (plain text/thinking) land
 * under '(unattributed)' per provider.
 */
const TOOL_BUCKET_SQL = `
  provider || '/' || CASE
    WHEN tool IS NULL THEN '(unattributed)'
    WHEN substr(tool, 1, 5) = 'mcp__' AND instr(substr(tool, 6), '__') > 0
      THEN 'mcp:' || substr(tool, 6, instr(substr(tool, 6), '__') - 1)
    ELSE tool
  END
`; // referenced twice (SELECT + GROUP BY), keep in sync

export interface SessionEventRow {
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

interface RawSessionEventRow {
  ts: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}
