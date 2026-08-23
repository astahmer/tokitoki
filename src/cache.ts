import path from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";

import type { UsageEvent } from "./types.ts";
import { dataDir, eventsFile, readEventsFile } from "./store.ts";
import { resolveRepo } from "./repos.ts";

/**
 * SQLite cache over the merged event logs. Rebuildable at any time: it is a
 * pure projection of (local + extra) JSONL files deduped on event id.
 */
export class EventCache {
  private db: Database;
  private repoStmtInsert: ReturnType<Database["prepare"]>;
  /** Injectable for tests; defaults to real filesystem resolution. */
  private repoNameFor: (dir: string) => string;

  constructor(dbPath?: string, repoNameFor?: (dir: string) => string) {
    const p = dbPath ?? path.join(dataDir(), "cache.db");
    this.db = new Database(p, { create: true });
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
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_provider ON events(provider);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE TABLE IF NOT EXISTS repo_dirs (
        dir TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
  }

  /** Insert events, ignoring duplicates (dedupe on the stable id). */
  insert(events: UsageEvent[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        id, ts, machine_id, provider, account_key, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, project_dir, session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        ).changes;
      }
      return inserted;
    });
    return tx(events) as number;
  }

  /** Full rebuild from all known event log files. */
  rebuild(extraFiles: string[]): void {
    this.db.exec("DELETE FROM events");
    const files = [eventsFile(), ...extraFiles];
    for (const file of files) {
      // Dedup within/across files happens via INSERT OR IGNORE
      this.insert(readEventsFile(file));
    }
  }

  /** Ensure the cache reflects every line in the local + extra logs. */
  sync(extraFiles: string[]): void {
    const count = this.count();
    const total = new Set<string>();
    for (const file of [eventsFile(), ...extraFiles]) {
      for (const e of readEventsFile(file)) total.add(e.id);
    }
    if (total.size !== count) this.rebuild(extraFiles);
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

export type Dimension = "model" | "project" | "repo" | "account" | "machine" | "provider";

export const DIMENSIONS: Dimension[] = ["model", "project", "repo", "account", "machine", "provider"];

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
