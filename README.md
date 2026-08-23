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
tokitoki report --last week --show-email --by account  # name <email> rows
tokitoki report --last month --json # machine-readable
tokitoki grid --last year [--metric tokens|cost|requests]  # calendar heatmap

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

tokitoki budgets                            # [budgets] gauge state (day/week/month caps)
tokitoki budgets --json                     # menubar/web contract: [{scope,label,cap,used,unit,ratio,state,daysLeft}]
tokitoki sources                            # provenance: store paths, files/events scanned, accounts, models per provider
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
bun run web:build       # vite build → dist/web/  (required once)
tokitoki web            # → http://localhost:7788  (--port to change)
bun run web:dev         # vite dev server :5177, /api proxied to :7788
```

React + TypeScript SPA built with Vite, styled with Tailwind CSS v4,
primitives hand-rolled shadcn-style on **Base UI** (Switch/Tabs-class
accessibility without Radix weight), charts via **TanStack Charts**
(line timeseries + polar donut).

Build flow:

```text
web/src (React+TW) ──vite build──▶ dist/web/ ──Bun.serve static──▶ browser
                                        ▲
src/web/api.ts ◀── same aggregation as the CLI (EventCache) ── /api/* JSON
```

- `Bun.serve` (src/web/server.ts) serves `dist/web/` statically and keeps
  `/api/*` JSON endpoints; if `dist/web/` is missing it returns a helpful
  "run bun run web:build" message. No duplicated SQL: API responses come
  from the exact CLI aggregation in src/web/api.ts.
- Parity with the CLI: period + group-by tabs (incl. repo), provider filter
  chips, multi-account tabs, click-to-sort table (%share, %cache, Δ vs
  previous window, plan gauges), evolution chart, donut share, and a
  GitHub-style calendar heatmap (`/api/grid`, metric switchable; the same
  grid exists on the CLI as `tokitoki grid`).
- Account emails: providers expose the logged-in address read live from
  local harness stores (claude-code → ~/.claude.json oauthAccount;
  codex → JWT payload in ~/.codex/auth.json; pi/opencode are key-only →
  null). Toggle "show emails" in the web UI (persisted to localStorage) or
  pass `--show-email` to `report`.

## Docs

- [Publishing the ATProto lexicon](docs/atproto-lexicon.md) — NSID choice,
  schema doc, hosting/announcement, versioning rules, adapter flip checklist
- [Packaging](docs/packaging.md) — compiled binary, cross-compile targets,
  release/checksum flow, nix packaging recipe (source + prebuilt), nixfiles wiring + cli-tools cockpit reminder
- [Menu-bar app](menubar/tokitoki-menubar/) — native SwiftUI MenuBarExtra
  (macOS 13+), `swift build`, refreshes every 5 min from the compiled CLI

## Backfill imports

`tokitoki import <file.csv> [--source anthropic|openai|openrouter] [--dry-run]`
merges provider console exports into your history. Source is auto-detected
from headers; rows are deduped by a stable content hash so re-importing the
same file never double-counts. Events are attributed to provider
`<source>-import` and account `imported`.

Expected column shapes (header names matched fuzzily, case-insensitive):

| source | needs | notes |
|---|---|---|
| anthropic console | timestamp, model, input/output/cache tokens, cost | per-request rows; `Transaction ID` present |
| openai usage | date, model, token columns | aggregated daily rows → one event each |
| openrouter activity | timestamp (UTC), model, prompt/completion tokens, cost | `Provider` column present |

Unparseable rows (bad dates, zero tokens) are counted as skipped, never fatal.

## Budgets + ntfy alerts

```toml
[budgets]
daily = 10      # USD caps, global
monthly = 200
ntfy = "https://ntfy.sh/your-topic"   # optional push on threshold crossing

[budgets.accounts."codex*"]           # accountKey pattern (trailing * = prefix)
monthly = 120
```

After every scan/report/today, burn vs caps is checked at 80% and 100%.
Crossings print a ⚠ banner and POST to the ntfy topic. Alerts dedupe per
(scope, period, pattern, threshold) in `<data-dir>/alerts.json` — a threshold
fires once per period.

### Menu-bar integration

`tokitoki budgets --json` is the menubar contract. The SwiftUI app
(`menubar/`) polls it on the same 5-min timer as its reports and adds:

- **title badge**: 🟠 when any budget ≥80%, 🔴 when any exceeded (emoji dots —
  the macOS status bar renders SF symbols monochrome)
- **Budgets section**: per-cap `ProgressView` tinted by state + `$used / $cap`
  + days left in the period (hidden entirely when no `[budgets]` config)
- **anomaly row**: top flagged day from `tokitoki anomalies --json`, if any
- **native notifications** on threshold *crossings* (not while staying past
  one), deduped per (label, level) in `<data-dir>/menubar-state.json` so a
  restart never re-notifies; permission requested lazily, denial degrades to
  badge-only

## Pricing data

Model prices auto-sync from LiteLLM's community pricing JSON into
`<data-dir>/pricing.json` (7-day TTL, 1h retry throttle when offline). The
embedded snapshot is the offline fallback. Unknown models estimate as $0 with
a one-time stderr note.

## Supported harnesses

| Provider | id | Status | Store | Notes |
|---|---|---|---|---|
| Claude Code | `claude-code` | ✅ working | `~/.claude/projects` JSONL | tokens + tools + emails |
| pi | `pi` | ✅ working | `$PI_DIR/agent/sessions` JSONL | tokens, cost reported by harness |
| Codex CLI | `codex` | ✅ working | `~/.codex/sessions` JSONL | delta-usage rollouts, best effort on unknown shapes |
| T3 Code | `t3code` | ◐ indexed only | `~/Library/Application Support/t3code/IndexedDB/*.leveldb` | threads searchable (titles/prompts); store exposes **no token usage** |
| Antigravity CLI | `antigravity-cli` | ◐ provenance only | `~/.gemini/antigravity-cli/conversations/*.db` | protobuf blobs; no usage exposed |
| Cursor | `cursor` | ◐ indexed only | `state.vscdb` + `ai-tracking/ai-code-tracking.db` | transcripts/summaries searchable; **no token counts in any inspected store** (199k activity-hash rows verified) |
| Grok CLI | `grok` | ✅ working | `$GROK_HOME/sessions/**/*.jsonl` | tolerant codex-family parser (`last_token_usage` deltas preferred, flat `usage` spellings accepted) |
| Gemini CLI | `gemini-cli` | ✅ working | `~/.gemini/tmp/<hash>/chats/session-*.json` | per-message `tokens` objects when stats are recorded; sessions without them stay search-only |
| Aider | `aider` | 📐 skeleton | `.aider.chat.history.jsonl` per repo | needs per-repo discovery |
| Goose | `goose` | 📐 skeleton | `~/.config/goose/sessions` JSONL | — |
| Amp | `amp` | 📐 skeleton | `~/.local/share/amp/threads` JSON | — |
| Zed | `zed` | 📐 skeleton | `~/.local/share/zed` sqlite | schema needs inspection |

All providers honor a per-provider `paths` config override plus the env var
shown by `tokitoki sources`. Skeletons emit no events until their store exists
and a real adapter replaces them.

## Status / known limits

- Codex provider is best effort (format observed on codex 0.146.x); unknown
  line shapes are skipped
- Cost for models missing from the pricing table estimates to $0
- `report` rebuilds the sqlite cache lazily when log/event counts diverge;
  very large logs may want a faster merge strategy later

## Roadmap (competitive scan 2026-08 + web UX backlog)

What ccusage / CodexBar / openusage.ai have that we don't yet, cheapest-first:

- **Web UX polish backlog** (2026-08-23 visual pass): calendar-heatmap cells
  need a light-mode-visible color ramp (current accent/20 levels nearly
  invisible on white); verify TanStack `formatGroup` tooltips visually
  (implemented, not screenshot-verified); session-detail request timeline
  could be a chart instead of a table; keyboard navigation + focus rings for
  table/tabs; responsive layout pass for narrow viewports
- **5-hour billing blocks** (ccusage `blocks`) — Claude-specific session-window
  monitoring with active-block tracking; needs per-request timestamps we
  already store, just a different bucketing
- **Provider limit polling with reset countdowns** (CodexBar/openusage core) —
  OAuth/cookie sessions per provider to read plan quotas + reset times; big
  but the single biggest feature gap vs the menu-bar apps
- **Statusline integration** (ccusage `statusline`) — compact one-liner for
  Claude Code status bar hooks; trivial once a `tokitoki statusline` command
  emits the right shape
- **Compact table mode** for narrow terminals/screenshots (ccusage `--compact`)
- **Timezone option** for day bucketing (ccusage `--timezone UTC`)
- **Offline pricing mode + user pricing overrides** via config file
- **More harness sources** — ccusage already parses Amp, Droid, Goose, Kimi,
  Qwen, Copilot CLI, Gemini CLI, Grok... our provider interface makes each a
  small adapter
- **Config file** for defaults (ccusage.json-style) instead of env/flags only

## Prior art

- <https://github.com/ccusage/ccusage>
- <https://github.com/steipete/CodexBar>
- openusage.ai

## Changelog

### v0.4.0
- sessions page: FTS5 search across every harness, snippet highlights,
  filter rail; `tokitoki sessions --search`
- harness coverage: t3code/antigravity indexed (provenance), skeletons +
  supported-matrix for cursor/grok/gemini-cli/aider/goose/amp/zed
- tool-level cost attribution (`--by tool`, treemap mosaic in web, top
  tools in menubar) — token-cost inspired
- budgets: `tokitoki budgets init` seeds per-account caps from detected
  accounts; ntfy push at 80%/100%
- multi-machine presence: `.hb` heartbeats on sync push, machines strip
  in Sources tab + `tokitoki presence`, menubar active-machines line
- explicit period headers everywhere; duration ranges (`--last 24h`,
  `--from/--to` ISO); `-v`; exports json/md/csv
- light/dark theme with proper heatmap ramp contrast (light mode fixed)
