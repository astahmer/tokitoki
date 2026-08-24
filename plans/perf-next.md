# Plan: perf next — daily rollups + event-log retention

Status: planned. Builds on the 2026-08-25 scan overhaul (sharded cursors,
worker scan, incremental sync, spendSnapshot).

## 1. Daily rollup table (the "i dont get it" one, explained)

**Problem**: reports/menubar/budgets aggregate over the `events` table every
time. Today: ~250k events → 0.8s CPU per report. Fine now, but cost grows
linearly forever with archive size (the menubar polls every 5 min; MCP tools
will multiply read traffic).

**Idea**: maintain a pre-aggregated summary table alongside `events`:

```sql
CREATE TABLE daily_rollups (
  day TEXT NOT NULL,             -- UTC yyyy-mm-dd from ts
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  model TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  repo TEXT,                     -- resolved via repo_dirs at rollup time
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd REAL, requests INTEGER,
  PRIMARY KEY (day, provider, account_key, model, machine_id, repo)
);
```

- `insert()` maintains it in the same transaction (INSERT ... ON CONFLICT DO
  UPDATE). Cost: one extra upsert per event batch — negligible vs parse.
- `rebuild()` recomputes it from scratch in one pass.
- Reports with day-or-coarser granularity (`today`, `week`, `month`, chart,
  pie, grid, budgets, menubar-payload) switch to reading rollups:
  O(days × accounts) rows instead of O(events). Sessions/tools/per-request
  views keep using `events`.
- Correctness guard: `COUNT(events) == SUM(requests)` consistency check on
  sync(); mismatch → rebuild rollups (not full events projection).
- Migration: backfill once inside rebuild (one extra pass, seconds).

**Expected effect**: report CPU drops to ~ms and stays flat as history grows;
menubar 5-min polls and future MCP reads become nearly free.

## 2. events.jsonl retention / rotation

**Problem**: single append-only JSONL is ~730MB and grows forever. Full replays
are now rare (only extraction-version bumps), but they exist — and cold-starts
on new machines re-read everything.

**Design**:
- Rotate by month: `events.jsonl` (current) + `events-archive/<yyyy-mm>.jsonl.gz`
- Reader (`readEventsFile`/`readEventsTail`) learns `.gz`; tail reads only
  ever hit the current file, archives are only read during rebuild.
- Rotation runs opportunistically after a successful scan+cache-ingest: when
  the current file's earliest complete month is > N months old (default 3),
  gzip-and-move it, then record the rotation in `meta` so offsets stay valid.
- Safety: rotation is atomic-ish (write tmp .gz, fsync, rename, then truncate
  head of current file); interrupted rotation leaves both copies → next pass
  dedupes by id anyway (insert is idempotent).
- Config: `storage.archiveMonths` (0 = keep everything uncompressed).

**Expected effect**: rebuilds touch mostly-gzipped cold data (~5–10× less IO);
disk growth bounded to recent months uncompressed.

## Order

1. Rollups first (unlocks flat-cost reports for menubar + MCP).
2. Retention second (independent; touches reader paths).

## Non-goals here

- Persistent daemon (scan floor is already 0.24s).
- Any language/runtime change (settled: Bun is right).
