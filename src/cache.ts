import path from "node:path";

import fs from "node:fs";
import { Database, type SQLQueryBindings } from "bun:sqlite";

import type { QuotaWindow, UsageEvent } from "./types.ts";
import { dataDir, eventsFile, readEventsFile, readEventsTail } from "./store.ts";
import { partitionBlocks, type BlockRow } from "./blocks.ts";import { resolveRepo } from "./repos.ts";
import { ensureSessionFts, sessionConversation } from "./sessionIndex.ts";
import { describeSessionEvent, estimateCacheDuration, type CacheDurationEstimate } from "./session-insights.ts";
import { EXTRACTION_VERSION } from "./scan.ts";
import { modelProvider } from "./model-provider.ts";

/** SQLite can briefly reject a new connection while another process is
 * recovering a WAL. Retry only that transient class; programming/schema
 * errors must still fail immediately. */
function sqliteRetry<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      const message = String(error);
      const transient = message.includes("SQLITE_BUSY") || message.includes("database is locked");
      if (!transient || attempt === 7) throw error;
      const delayMs = 20 * 2 ** attempt;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  throw lastError;
}

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
  /** Provider account identity when the snapshot came from an authenticated poll. */
  accountId: string | null;
  windowMinutes: number;
  /** Distinguishes same-duration windows on one account (Cursor's "Cursor Models" vs "Other Models"). Empty when unlabeled. */
  label: string;
  usedPct: number;
  /** Real USD spend for open-ended windows (e.g. Cursor's On-Demand). */
  amountUsd: number | null;
  resetsAt: number;
  creditsJson: string | null;
  capturedAt: string;
  /** Original event id; poll:* rows are authenticated/provider-live data. */
  eventId?: string;
}
export class EventCache {
  private db: Database;
  private repoStmtInsert: ReturnType<Database["prepare"]>;
  private rollupStmtUpsert: ReturnType<Database["prepare"]>;
  /** Injectable for tests; defaults to real filesystem resolution. */
  private repoNameFor: (dir: string) => string;

  constructor(dbPath?: string, repoNameFor?: (dir: string) => string) {
    const p = dbPath ?? path.join(dataDir(), "cache.db");
    this.db = sqliteRetry(() => new Database(p, { create: true }));
    // Concurrent invocations are normal (menubar polls every 5 min, web serves
    // on demand, users run CLI in parallel): WAL + busy timeout so writers
    // queue instead of failing with SQLITE_BUSY.
    sqliteRetry(() => this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;"));
    this.repoNameFor = repoNameFor ?? ((dir: string) => resolveRepo(dir).name);
    this.migrate();
    this.repoStmtInsert = this.db.prepare(
      "INSERT OR REPLACE INTO repo_dirs (dir, name) VALUES (?, ?)",
    );
    // One row per event added to events, upserting its daily aggregate.
    this.rollupStmtUpsert = this.db.prepare(`
      INSERT INTO daily_rollups (
        day, provider, account_key, model, machine_id, repo,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, requests
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (day, provider, account_key, model, machine_id, repo) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = cost_usd + excluded.cost_usd,
        requests = requests + 1
    `);
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
        tool TEXT,
        description TEXT
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
    if (!cols.some((c) => c.name === "description")) {
      this.db.exec("ALTER TABLE events ADD COLUMN description TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL,
        account_id TEXT,
        window_minutes INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        used_pct REAL NOT NULL,
        resets_at INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        event_id TEXT NOT NULL,
        credits_json TEXT,
        amount_usd REAL,
        PRIMARY KEY (provider, account_key, window_minutes, label, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_quota_lookup
        ON quota_snapshots(provider, account_key, captured_at);
      CREATE TABLE IF NOT EXISTS daily_rollups (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL,
        model TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        repo TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider, account_key, model, machine_id, repo)
      );
    `);
    const quotaCols = this.db.query("PRAGMA table_info(quota_snapshots)").all() as Array<{ name: string }>;
    if (!quotaCols.some((c) => c.name === "account_id")) {
      this.db.exec("ALTER TABLE quota_snapshots ADD COLUMN account_id TEXT");
    }
    // `label` must join the PRIMARY KEY (same-duration windows on one
    // account, e.g. Cursor's "Cursor Models" vs "Other Models", would
    // otherwise overwrite each other) — SQLite can't ALTER a PK in place,
    // so rebuild the table. Idempotent-guarded like the account_id ALTER.
    if (!quotaCols.some((c) => c.name === "label")) {
      this.db.exec(`
        ALTER TABLE quota_snapshots RENAME TO quota_snapshots_old;
        CREATE TABLE quota_snapshots (
          provider TEXT NOT NULL,
          account_key TEXT NOT NULL,
          account_id TEXT,
          window_minutes INTEGER NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          used_pct REAL NOT NULL,
          resets_at INTEGER NOT NULL,
          captured_at TEXT NOT NULL,
          event_id TEXT NOT NULL,
          credits_json TEXT,
          amount_usd REAL,
          PRIMARY KEY (provider, account_key, window_minutes, label, captured_at)
        );
        INSERT INTO quota_snapshots
          (provider, account_key, account_id, window_minutes, label, used_pct, resets_at, captured_at, event_id, credits_json)
          SELECT provider, account_key, account_id, window_minutes, '', used_pct, resets_at, captured_at, event_id, credits_json
          FROM quota_snapshots_old;
        DROP TABLE quota_snapshots_old;
        CREATE INDEX IF NOT EXISTS idx_quota_lookup
          ON quota_snapshots(provider, account_key, captured_at);
      `);
    }
    // Plain data column (no PK impact) — a simple guarded ALTER suffices,
    // unlike label's PK-widening rebuild above.
    const quotaColsAfterLabel = this.db.query("PRAGMA table_info(quota_snapshots)").all() as Array<{ name: string }>;
    if (!quotaColsAfterLabel.some((c) => c.name === "amount_usd")) {
      this.db.exec("ALTER TABLE quota_snapshots ADD COLUMN amount_usd REAL");
    }
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

  /** Read a small durable cache marker without exposing the SQLite handle. */
  metaValue(key: string): string | undefined {
    const row = this.db
      .query("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return row?.value;
  }

  /** Persist a small cache marker atomically alongside the projection. */
  setMetaValue(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(key, value);
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
        cost_usd, project_dir, session_id, tool, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction((rows: UsageEvent[]) => {
      let inserted = 0;
      const newRows: UsageEvent[] = [];
      for (const e of rows) {
        const changes = stmt.run(
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
          e.description ?? null,
        ).changes;
        inserted += changes;
        if (changes > 0) newRows.push(e);
      }
      // Same transaction as the event inserts so daily_rollups can never
      // drift from events mid-batch.
      if (newRows.length > 0) this.applyRollups(newRows);
      return inserted;
    });
    const n = sqliteRetry(() => tx(events)) as number;
    this.insertQuotaSnapshots(events);
    return n;
  }

  /**
   * Persist provider-embedded quota snapshots (codex rate_limits). One row
   * per window per event; latest captured_at per (provider, account, window)
   * wins in queries.
   */
  /**
   * Direct quota-snapshot insert for polled data (tokitoki poll): same table
   * and PK semantics as insertQuotaSnapshots but without requiring synthetic
   * UsageEvent shells. event_id distinguishes the origin ("poll:<iso>").
   */
  insertPolledSnapshots(input: {
    provider: string;
    accountKey: string;
    accountId?: string;
    windows: Array<{ windowMinutes: number; usedPct: number; resetsAtEpoch: number; label?: string; amountUsd?: number }>;
    credits?: { hasCredits: boolean; unlimited: boolean; balance: string; expiresAt?: string };
    capturedAtIso: string;
    eventId: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO quota_snapshots (
        provider, account_key, account_id, window_minutes, label, used_pct, resets_at,
        captured_at, event_id, credits_json, amount_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const w of input.windows) {
        const label = w.label ?? "";
        stmt.run(
          input.provider,
          input.accountKey,
          input.accountId ?? null,
          Math.round(w.windowMinutes),
          label,
          w.usedPct,
          Math.round(w.resetsAtEpoch),
          input.capturedAtIso,
          `${input.eventId}:${w.windowMinutes}:${label}`,
          input.credits !== undefined ? JSON.stringify(input.credits) : null,
          w.amountUsd ?? null,
        );
      }
    });
    sqliteRetry(() => tx());
    return input.windows.length;
  }

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
        provider, account_key, window_minutes, label, used_pct, resets_at,
        captured_at, event_id, credits_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const { e, w } of rows) {
        stmt.run(
          e.provider,
          e.accountKey,
          Math.round(w.windowMinutes),
          "",
          w.usedPct,
          Math.round(w.resetsAtEpoch),
          e.ts,
          e.id,
          e.quota?.credits !== undefined ? JSON.stringify(e.quota.credits) : null,
        );
      }
    });
    sqliteRetry(() => tx());
  }

  // -- daily rollups -------------------------------------------------------

  /**
   * Fold newly inserted events into daily_rollups. MUST run inside the same
   * transaction as the event inserts (insert() guarantees this). Repo names
   * are resolved once per batch via repo_dirs; NULL only when project_dir is
   * null.
   */
  private applyRollups(events: UsageEvent[]): void {
    const dirs = new Set<string>();
    for (const e of events) {
      if (e.projectDir !== undefined && e.projectDir.length > 0) dirs.add(e.projectDir);
    }
    let repoNames: Map<string, string | null> | undefined;
    if (dirs.size > 0) {
      this.ensureRepoMap();
      repoNames = new Map();
      const rows = this.db.query("SELECT dir, name FROM repo_dirs").all() as Array<{ dir: string; name: string }>;
      for (const r of rows) repoNames.set(r.dir, r.name);
    }
    for (const e of events) {
      this.rollupStmtUpsert.run(
        rollupDay(e.ts),
        e.provider,
        e.accountKey,
        e.model,
        e.machineId,
        e.projectDir !== undefined && e.projectDir.length > 0 ? (repoNames!.get(e.projectDir) ?? null) : null,
        Math.round(e.inputTokens),
        Math.round(e.outputTokens),
        Math.round(e.cacheReadTokens ?? 0),
        Math.round(e.cacheWriteTokens ?? 0),
        e.costUsd ?? 0,
      );
    }
  }

  /** Recompute daily_rollups from the events table in one GROUP BY pass. */
  private rebuildRollups(): void {
    this.ensureRepoMap();
    this.db.exec(`
      DELETE FROM daily_rollups;
      INSERT INTO daily_rollups (
        day, provider, account_key, model, machine_id, repo,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, requests
      )
      SELECT substr(e.ts, 1, 10) AS day,
             e.provider, e.account_key, e.model, e.machine_id, r.name AS repo,
             SUM(e.input_tokens), SUM(e.output_tokens),
             SUM(e.cache_read_tokens), SUM(e.cache_write_tokens),
             SUM(e.cost_usd), COUNT(*)
      FROM events e
      LEFT JOIN repo_dirs r ON e.project_dir = r.dir
      GROUP BY day, e.provider, e.account_key, e.model, e.machine_id, r.name;
    `);
  }

  /**
   * Cheap invariant check: every events row is reflected in exactly one
   * rollup request. On drift, heals daily_rollups from events — never from
   * the JSONL logs.
   */
  private checkRollups(): void {
    const row = this.db
      .query(
        `SELECT (SELECT COUNT(*) FROM events) AS n,
                (SELECT COALESCE(SUM(requests), 0) FROM daily_rollups) AS rolled`,
      )
      .get() as { n: number; rolled: number };
    if (row.n !== row.rolled) this.rebuildRollups();
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
    // insert() maintains rollups incrementally; the explicit pass is a cheap
    // belt-and-suspenders reset for the full-projection path.
    this.rebuildRollups();
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
    sqliteRetry(() => tx());
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
    if (tails.length === 0) {
      this.checkRollups();
      return;
    }

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
    this.checkRollups();
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
  /**
   * Quota fingerprints of the CURRENTLY-AUTHENTICATED login(s): window pairs
   * from POLLED snapshots (event_id "poll:*"). Scan-embedded windows whose
   * (windowMinutes, resetsAt) match one of these provably belong to the
   * local login; everything else may be a different account.
   */
  ownLoginFingerprints(provider: string): Set<string> {
    try {
      const rows = this.db
        .query(
          `SELECT DISTINCT window_minutes AS wm, resets_at AS resets
           FROM quota_snapshots WHERE provider = ? AND event_id LIKE 'poll:%'`,
        )
        .all(provider) as Array<{ wm: number; resets: number }>;
      return new Set(rows.map((r) => `${r.wm}:${r.resets}`));
    } catch {
      return new Set();
    }
  }

  latestQuotaSnapshots(provider: string, accountKey: string): QuotaSnapshotRow[] {
    try {
      // Copilot's API has one representative meter whose reset timestamp
      // moves on every poll. Older versions encoded time-until-reset as the
      // window length, leaving dozens of historical `NNNNMin` windows. Keep
      // only the newest Copilot snapshot while those legacy rows remain in a
      // user's rebuildable cache.
      if (provider === "copilot") {
        return this.db
          .query(
            `SELECT account_key AS accountKey, account_id AS accountId,
                    window_minutes AS windowMinutes, label AS label,
                    used_pct AS usedPct, amount_usd AS amountUsd, resets_at AS resetsAt,
                    credits_json AS creditsJson, captured_at AS capturedAt,
                    event_id AS eventId
             FROM quota_snapshots
             WHERE provider = ? AND account_key = ?
             ORDER BY captured_at DESC, window_minutes DESC
             LIMIT 1`,
          )
          .all(provider, accountKey) as QuotaSnapshotRow[];
      }
      return this.db
      .query(
          `SELECT qs.account_key AS accountKey, qs.account_id AS accountId,
                  qs.window_minutes AS windowMinutes, qs.label AS label,
                  qs.used_pct AS usedPct, qs.amount_usd AS amountUsd, qs.resets_at AS resetsAt,
                  qs.credits_json AS creditsJson, qs.captured_at AS capturedAt,
                  qs.event_id AS eventId
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

  /** Stable provider identities attached to the latest polled snapshots. */
  quotaAccountIds(provider: string, accountKey: string): Set<string> {
    try {
      const rows = this.db
        .query(
          `SELECT DISTINCT account_id AS accountId
           FROM quota_snapshots
           WHERE provider = ? AND account_key = ? AND account_id IS NOT NULL AND account_id <> ''`,
        )
        .all(provider, accountKey) as Array<{ accountId: string | null }>;
      return new Set(rows.map((r) => r.accountId).filter((id): id is string => typeof id === "string" && id.length > 0));
    } catch {
      return new Set();
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

  /**
   * Aggregate by inferred upstream model provider. The SQL first collapses
   * identical harness/account/model rows, keeping the JS remapping bounded by
   * distinct models rather than raw events.
   */
  aggregateModelProviders(sinceIso: string, providers?: string[], untilIso?: string): AggRow[] {
    const where = this.whereClause(providers, untilIso);
    const rows = this.db
      .query(
        `
        SELECT provider, account_key, model,
               COUNT(*) AS requests,
               COUNT(DISTINCT session_id) AS sessions,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(cost_usd) AS cost_usd
        FROM events
        WHERE ${where.sql}
        GROUP BY provider, account_key, model
        `,
      )
      .all(sinceIso, ...where.params) as Array<RawAggRow & { provider: string; account_key: string; model: string }>;
    const grouped = new Map<string, RawAggRow>();
    for (const row of rows) {
      const bucket = modelProvider(row.model, row.provider, row.account_key);
      const previous = grouped.get(bucket);
      if (previous === undefined) {
        grouped.set(bucket, { ...row, bucket });
      } else {
        previous.requests += row.requests;
        previous.sessions = (previous.sessions ?? 0) + (row.sessions ?? 0);
        previous.input_tokens = (previous.input_tokens ?? 0) + (row.input_tokens ?? 0);
        previous.output_tokens = (previous.output_tokens ?? 0) + (row.output_tokens ?? 0);
        previous.cache_read_tokens = (previous.cache_read_tokens ?? 0) + (row.cache_read_tokens ?? 0);
        previous.cache_write_tokens = (previous.cache_write_tokens ?? 0) + (row.cache_write_tokens ?? 0);
        previous.cost_usd = (previous.cost_usd ?? 0) + (row.cost_usd ?? 0);
      }
    }
    return [...grouped.values()].map(fromRawRow);
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
    // Reads daily_rollups (maintained transactionally by insert()) so budget
    // banners stay O(rollup rows) regardless of archive size. week/month
    // windows are day-granular: an ISO boundary maps to its UTC calendar
    // day, inclusive. Self-heal first: pre-upgrade caches have an empty
    // rollup table.
    this.checkRollups();
    const cond = (a: string, b: string): string =>
      `SUM(CASE WHEN day >= ? THEN cost_usd ELSE 0 END) AS ${a},` +
      `SUM(CASE WHEN day >= ? THEN cost_usd ELSE 0 END) AS ${b}`;
    const params = [rollupDay(weekIso), rollupDay(monthIso)];
    const totalRow = this.db
      .query(
        `SELECT ${cond("w", "m")} FROM daily_rollups`,
      )
      .get(...params) as { w: number; m: number };
    const accountRows = this.db
      .query(
        `SELECT account_key AS key, ${cond("w", "m")}
         FROM daily_rollups WHERE account_key != ''
         GROUP BY account_key`,
      )
      .all(...params) as Array<{ key: string; w: number; m: number }>;
    // "day" is read straight from events (not daily_rollups) because
    // rollups only bucket by UTC calendar day: for any timezone whose local
    // midnight doesn't land on a UTC day boundary, `day >= rollupDay(dayIso)`
    // would pull in the whole preceding UTC day too — e.g. UTC+2 local
    // midnight is 22:00 UTC the day before, so the old query counted almost
    // 22 hours of yesterday's spend as "today". The ts index keeps this a
    // cheap range scan regardless of archive size.
    const dayTotal = this.totals(dayIso).costUsd;
    const dayByAccount = new Map(
      this.aggregate(dayIso, "account")
        .filter((r) => r.bucket !== "")
        .map((r) => [r.bucket, r.costUsd]),
    );
    const accountKeys = new Set([...accountRows.map((r) => r.key), ...dayByAccount.keys()]);
    return {
      totals: { day: dayTotal, week: totalRow.w ?? 0, month: totalRow.m ?? 0 },
      accounts: [...accountKeys].map((key) => {
        const r = accountRows.find((x) => x.key === key);
        return { key, day: dayByAccount.get(key) ?? 0, week: r?.w ?? 0, month: r?.m ?? 0 };
      }),
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
   * Events folded into Claude-style 5-hour billing blocks (ccusage
   * semantics), partitioned per account_key. Needs event-level ts, so this
   * reads `events` directly — daily_rollups are too coarse for block
   * boundaries. isActive = still-open block (end is in the future relative
   * to `opts.now`, injectable for tests).
   */
  blockWindows(
    sinceIso: string,
    untilIso?: string,
    accountKey?: string,
    opts?: { now?: number },
  ): BlockRow[] {
    const conds = ["ts >= ?"];
    const params: SQLQueryBindings[] = [sinceIso];
    if (untilIso !== undefined) {
      conds.push("ts < ?");
      params.push(untilIso);
    }
    if (accountKey !== undefined) {
      conds.push("account_key = ?");
      params.push(accountKey);
    }
    const rows = this.db
      .query(
        `SELECT account_key, ts, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd
         FROM events WHERE ${conds.join(" AND ")}`,
      )
      .all(...params) as Array<{
        account_key: string;
        ts: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number | null;
        cache_write_tokens: number | null;
        cost_usd: number | null;
      }>;
    return partitionBlocks(
      rows.map((r) => ({
        ts: Date.parse(r.ts),
        accountKey: r.account_key,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens ?? 0,
        cacheWriteTokens: r.cache_write_tokens ?? 0,
        costUsd: r.cost_usd ?? 0,
      })),
      opts?.now ?? Date.now(),
    );
  }

  /**
   * Per-day token series for each of the top `topN` buckets of a dimension.
   * Days are the union across buckets; missing days are 0. Flat GROUP BY
   * query + JS-side top-N selection (a JOIN/CTE form of this was pathologically
   * slow on ~100k rows).
   */
  seriesDaily(
    sinceIso: string,
    groupBy: Exclude<Dimension, "project" | "repo">,
    topN = 5,
    metric: "tokens" | "cost" = "tokens",
  ): SeriesBucket[] {
    const column =
      groupBy === "account"
        ? "account_key"
        : groupBy === "machine"
          ? "machine_id"
          : groupBy === "provider"
            ? "provider"
            : "model";
    const valueExpr =
      metric === "cost"
        ? "SUM(cost_usd)"
        : "SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)";
    const rows = this.db
      .query(
        `
        SELECT ${column} AS bucket,
               date(ts, 'localtime') AS day,
               ${valueExpr} AS tokens
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

  /**
   * Totals over `[sinceIso, untilIso)` from daily_rollups. Day-granular:
   * ISO boundaries map to their UTC calendar day (`until` inclusive of its
   * whole day). Sessions are not derivable from rollups — always 0 here.
   */
  rollupTotals(sinceIso: string, untilIso?: string): AggRow {
    return this.rollupTotalRow(sinceIso, untilIso);
  }

  private rollupTotalRow(sinceIso: string, untilIso?: string): AggRow {
    const { sql, params } = this.rollupWindowSql(sinceIso, untilIso);
    const row = this.db
      .query(
        `
        SELECT COALESCE(SUM(requests), 0) AS requests,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(cost_usd) AS cost_usd
        FROM daily_rollups WHERE ${sql}
        `,
      )
      .get(...params) as RawAggRow;
    return fromRawRow({ ...row, bucket: "TOTAL", sessions: 0 });
  }

  /**
   * Aggregate daily_rollups in `[sinceIso, untilIso)` grouped by a rollup
   * dimension ('provider' | 'account' | 'model' | 'machine' | 'repo' | 'day').
   * Day-granular boundaries (see rollupTotals); sessions always 0.
   */
  rollupAggregate(sinceIso: string, untilIso: string | undefined, dimension: RollupDimension): AggRow[] {
    const column =
      dimension === "account"
        ? "account_key"
        : dimension === "machine"
          ? "machine_id"
          : dimension === "repo"
            ? "COALESCE(repo, '(no repo)')"
            : dimension === "provider"
              ? "provider"
              : dimension === "day"
                ? "day"
                : "model";
    const { sql, params } = this.rollupWindowSql(sinceIso, untilIso);
    const rows = this.db
      .query(
        `
        SELECT ${column} AS bucket,
               SUM(requests) AS requests,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(cost_usd) AS cost_usd
        FROM daily_rollups
        WHERE ${sql}
        GROUP BY bucket
        `,
      )
      .all(...params) as Array<RawAggRow>;
    return rows.map((r) => fromRawRow({ ...r, sessions: 0 }));
  }

  /** Rollup windows compare UTC calendar days: since-day inclusive, until-day inclusive. */
  private rollupWindowSql(sinceIso: string, untilIso?: string): {
    sql: string;
    params: SQLQueryBindings[];
  } {
    if (untilIso === undefined) return { sql: "day >= ?", params: [rollupDay(sinceIso)] };
    return {
      sql: "day >= ? AND day <= ?",
      params: [rollupDay(sinceIso), rollupDay(untilIso)],
    };
  }

  // -- hybrid rollup + events reads ---------------------------------------

  /** Exact request/token/cost sums without session counts. */
  // -- hybrid rollup + events reads ---------------------------------------

  /** Exact request/token/cost sums without session counts. */
  hybridUsage(
    sinceIso: string,
    providers?: string[],
    untilIso?: string,
    accountKey?: string,
  ): UsageTotals {
    const parts = this.hybridParts(sinceIso, untilIso, providers, accountKey);
    return sumUsage(parts);
  }

  /**
   * Exact per-bucket totals over [since, until) for a rollup dimension.
   * Same split as hybridUsage; sessions are ALWAYS 0 (not derivable from
   * day-grain data) — only use where consumers ignore sessions.
   */
  hybridAggregate(
    sinceIso: string,
    dimension: RollupDimension,
    providers?: string[],
    untilIso?: string,
    accountKey?: string,
  ): AggRow[] {
    const parts = this.hybridParts(sinceIso, untilIso, providers, accountKey, dimension);
    const byBucket = new Map<string, AggRow>();
    for (const part of parts) {
      for (const row of part) {
        const acc = byBucket.get(row.bucket);
        if (acc === undefined) byBucket.set(row.bucket, { ...row });
        else {
          acc.requests += row.requests;
          acc.inputTokens += row.inputTokens;
          acc.outputTokens += row.outputTokens;
          acc.cacheReadTokens += row.cacheReadTokens;
          acc.cacheWriteTokens += row.cacheWriteTokens;
          acc.costUsd += row.costUsd;
        }
      }
    }
    return Array.from(byBucket.values());
  }

  /**
   * Split [since, until) into rollup-served interior whole UTC days plus
   * events-served partial edge slices. Every returned list covers a disjoint
   * sub-range; together they reproduce exact ts-range semantics of the
   * events-backed queries while touching O(days×keys) rows for the bulk.
   */
  private hybridParts(
    sinceIso: string,
    untilIso: string | undefined,
    providers?: string[],
    accountKey?: string,
    dimension?: RollupDimension,
  ): Array<AggRow[]> {
    const DAY = 86_400_000;
    const startMs = Date.parse(sinceIso);
    const endMs = untilIso !== undefined ? Date.parse(untilIso) : Date.now();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return [[]];

    const firstFullStart = Math.ceil(startMs / DAY) * DAY;
    const lastFullEnd = Math.floor(endMs / DAY) * DAY;
    const parts: Array<AggRow[]> = [];

    if (lastFullEnd > firstFullStart && lastFullEnd - firstFullStart >= DAY) {
      const firstKey = new Date(firstFullStart).toISOString().slice(0, 10);
      const endKey = new Date(lastFullEnd).toISOString().slice(0, 10); // exclusive
      const conds = ["day >= ?", "day < ?"];
      const params: SQLQueryBindings[] = [firstKey, endKey];
      if (providers !== undefined && providers.length > 0) {
        conds.push(`provider IN (${providers.map(() => "?").join(",")})`);
        params.push(...providers);
      }
      if (accountKey !== undefined) {
        conds.push("account_key = ?");
        params.push(accountKey);
      }
      const column = rollupColumn(dimension ?? "day");
      const rows = this.db
        .query(
          `SELECT ${column} AS bucket,
                  SUM(requests) AS requests,
                  SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read_tokens) AS cache_read_tokens,
                  SUM(cache_write_tokens) AS cache_write_tokens,
                  SUM(cost_usd) AS cost_usd
           FROM daily_rollups WHERE ${conds.join(" AND ")}
           GROUP BY bucket`,
        )
        .all(...params) as Array<RawAggRow>;
      parts.push(rows.map((r) => fromRawRow({ ...r, sessions: 0 })));
    } else {
      parts.push([]);
    }

    // Partial edge slices straight from events (exact ISO bounds).
    const edges: Array<[number, number]> = [];
    if (startMs < firstFullStart) edges.push([startMs, Math.min(firstFullStart, endMs)]);
    if (lastFullEnd < endMs) edges.push([Math.max(startMs, lastFullEnd), endMs]);
    for (const [from, to] of edges) {
      parts.push(this.edgeRows(new Date(from).toISOString(), new Date(to).toISOString(), providers, accountKey, dimension));
    }
    return parts;
  }

  /** Events-backed rows over an exact ISO range; no sessions computed. */
  private edgeRows(
    sinceIso: string,
    untilIso: string,
    providers?: string[],
    accountKey?: string,
    dimension?: RollupDimension,
  ): AggRow[] {
    if (dimension === undefined) {
      const conds = ["ts >= ?", "ts < ?"];
      const params: SQLQueryBindings[] = [sinceIso, untilIso];
      if (providers !== undefined && providers.length > 0) {
        conds.push(`provider IN (${providers.map(() => "?").join(",")})`);
        params.push(...providers);
      }
      if (accountKey !== undefined) {
        conds.push("account_key = ?");
        params.push(accountKey);
      }
      const row = this.db
        .query(
          `SELECT COUNT(*) AS requests,
                  SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read_tokens) AS cache_read_tokens,
                  SUM(cache_write_tokens) AS cache_write_tokens,
                  SUM(cost_usd) AS cost_usd
           FROM events WHERE ${conds.join(" AND ")}`,
        )
        .get(...params) as RawAggRow;
      return [fromRawRow({ ...row, bucket: "TOTAL", sessions: 0 })];
    }
    const column = rollupColumn(dimension);
    const join =
      dimension === "repo" ? "FROM events LEFT JOIN repo_dirs ON events.project_dir = repo_dirs.dir" : "FROM events";
    if (dimension === "repo") this.ensureRepoMap();
    const conds = ["events.ts >= ?", "events.ts < ?"];
    const params: SQLQueryBindings[] = [sinceIso, untilIso];
    if (providers !== undefined && providers.length > 0) {
      conds.push(`events.provider IN (${providers.map(() => "?").join(",")})`);
      params.push(...providers);
    }
    if (accountKey !== undefined) {
      conds.push("events.account_key = ?");
      params.push(accountKey);
    }
    const rows = this.db
      .query(
        `SELECT ${column} AS bucket,
                COUNT(*) AS requests,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cost_usd) AS cost_usd
         ${join} WHERE ${conds.join(" AND ")}
         GROUP BY bucket`,
      )
      .all(...params) as Array<RawAggRow>;
    return rows.map((r) => fromRawRow({ ...r, sessions: 0 }));
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
    offset?: number;
    /** "recent" (default) = last_ts DESC so free/unbilled sessions stay
     * visible; "cost" = legacy cost-ordered leaderboard. */
    sort?: "cost" | "recent";
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
        ORDER BY ${opts.sort === "cost" ? "cost_usd DESC," : "last_ts DESC,"} input_tokens + output_tokens + cache_read_tokens + cache_write_tokens DESC
        LIMIT ? OFFSET ?
        `,
      )
      .all(opts.sinceIso, ...where.params, opts.limit ?? 10, opts.offset ?? 0) as Array<RawSessionRow>;
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
  sessionDetail(
    provider: string,
    sessionId: string,
    opts: { limit?: number; offset?: number } = {},
  ): SessionEventRow[] {
    const limit = opts.limit ?? -1;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .query(
        `
        SELECT ts, model, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens, cost_usd, tool, description
        FROM events
        WHERE provider = ? AND session_id = ?
        ORDER BY ts, id
        LIMIT ? OFFSET ?
        `,
      )
      .all(provider, sessionId, limit, offset) as Array<RawSessionEventRow>;
    const conversation = sessionConversation(this.db, provider, sessionId)?.body ?? null;
    return rows.map((r, index) => ({
      ts: r.ts,
      model: r.model,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheWriteTokens: r.cache_write_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
      tool: r.tool ?? undefined,
      description: r.description ?? describeSessionEvent(r, index, conversation),
    }));
  }

  sessionCacheEstimate(provider: string, sessionId: string): CacheDurationEstimate {
    const rows = this.db.query(
      `SELECT ts, input_tokens, cache_read_tokens
       FROM events WHERE provider = ? AND session_id = ? ORDER BY ts, id`,
    ).all(provider, sessionId) as Array<{ ts: string; input_tokens: number | null; cache_read_tokens: number | null }>;
    return estimateCacheDuration(rows.map((row) => ({
      ts: row.ts,
      inputTokens: row.input_tokens ?? 0,
      cacheReadTokens: row.cache_read_tokens ?? 0,
    })));
  }

  sessionEventCount(provider: string, sessionId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS count FROM events WHERE provider = ? AND session_id = ?")
      .get(provider, sessionId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  sessionTokensBefore(provider: string, sessionId: string, limit: number): number {
    if (limit <= 0) return 0;
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens
         FROM (
           SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM events
           WHERE provider = ? AND session_id = ?
           ORDER BY ts, id
           LIMIT ?
         )`,
      )
      .get(provider, sessionId, limit) as { tokens?: number } | undefined;
    return Number(row?.tokens ?? 0);
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

/** Dimensions answerable from the daily_rollups table alone (no sessions). */
export type RollupDimension = "model" | "repo" | "account" | "machine" | "provider" | "day";

/** UTC calendar day of an ISO timestamp — the daily_rollups grouping key. */
function rollupDay(isoTs: string): string {
  return isoTs.slice(0, 10);
}

function rollupColumn(dimension: RollupDimension): string {
  switch (dimension) {
    case "account":
      return "account_key";
    case "machine":
      return "machine_id";
    case "repo":
      return "COALESCE(repo, '(no repo)')";
    case "day":
      return "day";
    case "provider":
      return "provider";
    default:
      return "model";
  }
}

/** Exact sums without session counts (sessions are not in daily_rollups). */
export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

function sumUsage(parts: AggRow[][]): UsageTotals {
  const out: UsageTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  for (const part of parts) {
    for (const row of part) {
      out.requests += row.requests;
      out.inputTokens += row.inputTokens;
      out.outputTokens += row.outputTokens;
      out.cacheReadTokens += row.cacheReadTokens;
      out.cacheWriteTokens += row.cacheWriteTokens;
      out.costUsd += row.costUsd;
    }
  }
  return out;
}

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
  tool?: string;
  description: string;
}

interface RawSessionEventRow {
  ts: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  tool: string | null;
  description: string | null;
}
