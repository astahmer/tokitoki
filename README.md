# tokitoki

Unified coding-agent usage & session analytics across machines, harnesses, and
accounts. Merges the best of `ccusage`, CodexBar, and openusage.ai.

## Why

- Multiple Macs run the same/different harnesses (pi, Claude Code, Codex,
  OpenCode...) with the same named accounts/keys — usage is fragmented and
  double-counted per machine.
- Existing tools each cover one slice:
  - **ccusage** (18k⭐): CLI totals from Claude Code JSONL — primitive, single
    source, no multi-machine merge
  - **CodexBar**: menu-bar usage for Codex + Claude Code, supports multiple
    accounts
  - **openusage.ai**: nicer overall UX but no multi-account support

## Goals

1. **Multi-harness ingestion**: pi (`~/.pi`), Claude Code (`~/.claude`),
   Codex, OpenCode session stores → normalized event model
2. **Per-machine attribution**: every record tagged with `machine_id`;
   totals never double-count
3. **Dedup across machines**: stable identity =
   `(harness, account/key, sessionId, messageId|requestId)` — same session
   synced to two Macs counts once
4. **Dimensions**: per API key / account (subscription vs API), per model,
   per project/repo, per day/week/month, per machine
5. **Views**: CLI (`tokitoki today|week|month`), TUI dashboard, optional
   menu-bar/web UI later
6. **Live + historical**: incremental scan with cursor files; cheap rescan

## Architecture sketch

- Each machine: local scanner writes normalized JSONL append-log
  (`~/.local/share/tokitoki/events.jsonl`) + sqlite cache
- Sync layer: pluggable — Syncthing dir first (zero infra), restic/R2 as backup
- Aggregation: merge all synced logs, dedupe on identity key, aggregate in
  sqlite; totals are pure functions of the merged log
- Store format: append-only, conflict-friendly (Syncthing-safe: last-writer
  wins per line, no mutable DB as sync unit)

## Open questions

- Which harnesses ship token/cost data natively in their stores? (Claude Code
  yes; pi sessions carry usage? verify) — fallback: estimate from model+tokens
- ~~Which harnesses ship token/cost data natively in their stores?~~ Verified:
  pi yes (usage.cost), Claude Code yes (sometimes costUSD), Codex only
  cumulative/delta token counts (cost estimated from pricing table)
- Subscription plans (Pro/Max) have cost-less limits: track % of plan limit
  instead of $ where applicable
- Menu-bar app: separate shell or TUI-only first?

## Setup

Requires [Bun](https://bun.sh) (no Node toolchain needed):

```sh
bun install
# run ad hoc:
bun src/cli.ts scan
bun link          # optional, exposes `tokitoki`
```

Standalone binary (no runtime needed on target machine):

```sh
bun run compile   # → dist/tokitoki
```


## Usage

```sh
tokitoki scan                       # incremental scan of all providers
tokitoki scan --provider pi         # one provider (pi | claude-code | codex)
tokitoki today                      # today's usage grouped by model
tokitoki report --last week --by account
tokitoki report --last month --json # machine-readable

# sort by any column, filter by provider (repeatable), toggle Δ vs previous period
tokitoki report --last week --by model --sort cost        # default order: cost desc
tokitoki report --last week --sort %cache --asc
tokitoki report --last week --provider pi --provider codex
tokitoki report --last week --no-delta                   # Δ on by default

# ASCII visuals + evolution over time
tokitoki chart --last month                 # daily token bars
 tokitoki chart --last week --spark          # compact sparkline
tokitoki chart --last month --by provider --spark   # one sparkline per provider
tokitoki pie --by model                     # share-of-tokens legend with cost bars
```

Table output uses letter-suffixed numbers (`1.71B`, `23.7M`), `%cache`
(cache share of prompt tokens), a `%share` column (share of cost — falls
back to token share when every row costs $0), `sess` (distinct sessions) and
`avg/req` (tokens per request) columns, human costs, and a TOTAL row.
Sortable columns: `name | requests | sessions | avg | input | output | cache |
%cache | cost`.

When `--delta` is on (default for `report`), each cost cell carries `▲/▼`
vs the equally-sized previous window (`▲` green / `▼` red on TTYs;
`▲new` = bucket absent last period).

`today` and `report --last month` end with a burn line:
`burn: $X.XX/day → projected $Y by month end` (request-based when all costs
are $0). `today` also lists the top-3 projects month-to-date.

Dimensions: `model | project | account | machine | provider`.
Periods: `day` = local calendar day; `week`/`month` = rolling 7/30 days.

Multi-machine merge: sync `~/.local/share/tokitoki/events.jsonl` between Macs
(e.g. Syncthing) and list the other machines' files in
`~/.config/tokitoki/config.json`:

```json
{
  "extraEventFiles": ["~/syncthing/tokitoki-other-mac/events.jsonl"],
  "providers": { "pi": { "paths": ["/custom/pi/sessions"] } },
  "plans": {
    "codex-work": { "kind": "subscription", "monthlyRequestCap": 30000 },
    "opencode-*": { "kind": "subscription", "monthlyCostCap": 200 }
  }
}
```

Events dedupe on a stable id `(provider, accountKey, sessionId, entryId)` —
the same session synced to two machines counts once.

## Sync (cross-machine)

`tokitoki sync [--backend dir|git|atproto] [--push|--pull|--both]` moves
normalized events between machines. Backend + connection come from `[sync]`
in config.toml:

### dir — Syncthing folder (zero infra)

```toml
[sync]
backend = "dir"
path = "~/Sync/tokitoki"   # one <machineId>.jsonl per machine, no conflicts
```

Each machine writes only its own file; pull reads everyone else's. Point your
Syncthing shared folder at that path on both Macs and run `tokitoki sync` on
each (or a launchd/cron job hourly).

### git — private repo

```toml
[sync]
backend = "git"
url = "git@github.com:you/tokitoki-events-private.git"
branch = "main"
```

Push = commit this machine's file + push; pull = fetch + read other machines'
files. Works with any private git host; auth is whatever your ssh-agent/
credential helper already has.

### atproto — scaffold (lexicon unpublished)

```toml
[sync]
backend = "atproto"
pds = "https://bsky.social"      # or cirrus/your PDS
handle = "you.bsky.social"
# app password via TOKITOKI_ATPROTO_APP_PASSWORD env (preferred) or appPassword here
```

Stores one record per event under `tokitoki.<handle>.usage`. ⚠️ Guarded behind
`--sync-atproto`: the lexicon is NOT published yet and the nsid embeds a handle
label, so strict PDS validation may reject writes until a real lexicon is
registered.

Pulled lines land in `~/.local/share/tokitoki/remote-events.jsonl` — never in
your local log — and merge into every report through the normal dedupe path,
so re-pulling identical lines is always a no-op.

### Plan gauges (honest approximation)

Rows whose accountKey matches a `plans` pattern (exact or trailing `*`) show
a month-to-date usage gauge instead of a cost cell — most useful with
`--by account`. Providers don't expose subscription quotas, so caps are
user-configured estimates; the gauge is only as honest as the cap you set.

- Tests + runner are Bun-native (`bun test`, imports from `bun:test`); sqlite is `bun:sqlite`
## Web dashboard

```sh
tokitoki web            # → http://localhost:7788  (--port to change)
```

Local-only, dependency-free single page served by Bun.serve:

- Summary cards: week cost (with Δ vs previous week), burn/day + projected
  month-end, requests, sessions, tokens, cache %
- Multi-account tabs: every accountKey gets its own segment; picking one
  scopes cards, chart, and table to it
- Group-by dimension tabs (model / provider / account / machine / project)
- Sortable table (click headers) with share-of-total bars
- Inline-SVG stacked area chart of daily tokens per bucket over 30 days

Visual direction follows openusage.ai's dark-card look with CodexBar-style
monospace numbers. API endpoints (`/api/summary`, `/api/timeseries`,
`/api/table`) reuse the exact CLI aggregation — see `src/web/api.ts` if you
want to script them.

## Status / known limits

- Codex provider is best effort (format observed on codex 0.146.x); unknown
  line shapes are skipped
- Cost for models missing from the pricing table estimates to $0
- `report` rebuilds the sqlite cache lazily when log/event counts diverge;
  very large logs may want a faster merge strategy later

## Prior art

- <https://github.com/ccusage/ccusage>
- <https://github.com/steipete/CodexBar>
- openusage.ai
