import path from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";

import type { UsageEvent } from "./types.ts";
import { dataDir, eventsFile, readEventsFile } from "./store.ts";

/**
 * SQLite cache over the merged event logs. Rebuildable at any time: it is a
 * pure projection of (local + extra) JSONL files deduped on event id.
 */
export class EventCache {
  private db: Database;

  constructor(dbPath?: string) {
    const p = dbPath ?? path.join(dataDir(), "cache.db");
    this.db = new Database(p, { create: true });
    this.migrate();
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
    const column =
      groupBy === "project"
        ? "COALESCE(project_dir, '(no project)')"
        : groupBy === "account"
          ? "account_key"
          : groupBy === "machine"
            ? "machine_id"
            : groupBy === "provider"
              ? "provider"
              : "model";
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
        FROM events
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

  /** Total tokens per local calendar day since `sinceIso` (UTC-stored ts). */
  dailyTotals(sinceIso: string): DailyTotal[] {
    const rows = this.db
      .query(
        `
        SELECT date(ts, 'localtime') AS day,
               SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
        FROM events
        WHERE ts >= ?
        GROUP BY day
        ORDER BY day
        `,
      )
      .all(sinceIso) as Array<{ day: string; tokens: number | null }>;
    return rows.map((r) => ({ day: r.day ?? "?", tokens: r.tokens ?? 0 }));
  }

  /**
   * Per-day token series for each of the top `topN` buckets of a dimension.
   * Days are the union across buckets; missing days are 0. Flat GROUP BY
   * query + JS-side top-N selection (a JOIN/CTE form of this was pathologically
   * slow on ~100k rows).
   */
  seriesDaily(sinceIso: string, groupBy: Exclude<Dimension, "project">, topN = 5): SeriesBucket[] {
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
}

export type Dimension = "model" | "project" | "account" | "machine" | "provider";

export const DIMENSIONS: Dimension[] = ["model", "project", "account", "machine", "provider"];

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
}

export interface SeriesBucket {
  bucket: string;
  days: string[];
  values: number[];
}
