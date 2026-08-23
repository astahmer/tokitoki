import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { UsageEvent } from "./types.ts";
import { dataDir, eventsFile, readEventsFile } from "./store.ts";

/**
 * SQLite cache over the merged event logs. Rebuildable at any time: it is a
 * pure projection of (local + extra) JSONL files deduped on event id.
 */
export class EventCache {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const p = dbPath ?? path.join(dataDir(), "cache.db");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
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
      ) VALUES (
        @id, @ts, @machineId, @provider, @accountKey, @model,
        @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
        @costUsd, @projectDir, @sessionId
      )
    `);
    const tx = this.db.transaction((rows: UsageEvent[]) => {
      let inserted = 0;
      for (const e of rows) {
        inserted += stmt.run({
          id: e.id,
          ts: e.ts,
          machineId: e.machineId,
          provider: e.provider,
          accountKey: e.accountKey,
          model: e.model,
          inputTokens: Math.round(e.inputTokens),
          outputTokens: Math.round(e.outputTokens),
          cacheReadTokens: Math.round(e.cacheReadTokens ?? 0),
          cacheWriteTokens: Math.round(e.cacheWriteTokens ?? 0),
          costUsd: e.costUsd ?? 0,
          projectDir: e.projectDir ?? null,
          sessionId: e.sessionId ?? null,
        }).changes;
      }
      return inserted;
    });
    return tx(events);
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
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    return row.n;
  }

  /**
   * Aggregate events since `sinceIso`, grouped by one dimension.
   * Returns rows sorted by token volume descending.
   */
  aggregate(
    sinceIso: string,
    groupBy: "model" | "project" | "account" | "machine" | "provider",
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
    const rows = this.db
      .prepare(
        `
        SELECT ${column} AS bucket,
               COUNT(*) AS requests,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_write_tokens) AS cache_write_tokens,
               SUM(cost_usd) AS cost_usd
        FROM events
        WHERE ts >= ?
        GROUP BY bucket
        ORDER BY input_tokens + output_tokens DESC
        `,
      )
      .all(sinceIso) as Array<{
      bucket: string;
      requests: number;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      cache_write_tokens: number | null;
      cost_usd: number | null;
    }>;
    return rows.map((r) => ({
      bucket: r.bucket,
      requests: r.requests,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      cacheReadTokens: r.cache_read_tokens ?? 0,
      cacheWriteTokens: r.cache_write_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export interface AggRow {
  bucket: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}
