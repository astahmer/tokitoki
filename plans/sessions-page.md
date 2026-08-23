# Plan: unified sessions page (search everything)

Goal: one page listing **every session from every harness/provider**, with
fast full-text search across all conversation content.

## Data layer

- **FTS5 virtual table** (`sessions_fts`) indexed during `scan`: columns =
  session_id, provider, account_key, repo, started_at, title/first prompt,
  body (concatenated user+assistant text, tool names)
- Incremental: only new/changed files get re-indexed (reuse scan cursors);
  content-addressed by (provider, sessionId, file mtime hash)
- Body size guard: cap per-session indexed text (~1MB) — search quality fine,
  DB stays lean
- Store next to existing sqlite cache; rebuild command: `tokitoki reindex`

## Query UX

- Web Sessions tab upgrades to the default landing view:
  - Filter rail: provider chips, account, repo, date range (existing
    WindowSelection), model
  - Search box → FTS5 MATCH query with snippet() highlights around matches
  - Rows: date, provider icon/color dot, account email toggle, first-prompt
    preview w/ highlighted match, requests/tokens/cost mini-columns
  - Click → existing session drill-down timeline, matched messages expanded
- CLI parity: `tokitoki sessions --search "kumo"` — same FTS query, prints
  matching sessions + best snippet line

## Performance targets

- Index build: ~1–2 min for ~100k events one-time; incremental adds <1s
- Search: FTS5 handles this scale (<50ms); paged fetch (50/page) for render

## Open questions

- Multi-machine: search only local index or also synced event files? (synced
  files lack bodies today — bodies would need syncing too; phase 2 decision:
  sync a compact `bodies.jsonl` alongside events.jsonl, Syncthing-friendly)
- Tool-level search ("find where I used Bash with rm") — depends on tool
  attribution landing (token-cost integration) since it needs tool names
  indexed separately
