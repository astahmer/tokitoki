# tokitoki

> Local-first usage analytics for coding agents.

Tokitoki scans local harness stores, normalizes usage into one deduplicated
event log, and gives you the same picture in a CLI, web dashboard, native
macOS menu bar, shell widgets, and MCP. It is designed for people who use
multiple agents, accounts, machines, or all three.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Tokitoki web dashboard showing usage totals, an evolution chart, and a provider breakdown" width="920" />
</p>

<p align="center">
  <img src="docs/screenshots/menubar-home.png" alt="Tokitoki native menu-bar popover with quota cards" width="49%" />
  <img src="docs/screenshots/menubar-tokens.png" alt="Tokitoki native menu-bar popover with token distribution charts" width="49%" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-get">What you get</a> ·
  <a href="#supported-harnesses">Supported harnesses</a> ·
  <a href="#privacy-and-data">Privacy and data</a>
</p>

## What you get

- **One local history** across Claude Code, Codex CLI, pi, OpenCode, Gemini
  CLI, Grok CLI, and other indexed harnesses.
- **Useful dimensions**: model, provider, account, project, repository,
  machine, tool, and time window.
- **Honest cost and quota views**: native provider costs when available,
  pricing-based estimates where needed, and clearly labelled plan gauges.
- **Multiple surfaces**: composable CLI reports, a local browser dashboard, a
  macOS menu-bar app, host-neutral shell widgets, and an MCP server for agents.
- **Multi-machine deduplication**: sync append-only event files without
  counting the same session twice.
- **Explicit sharing**: usage stays local unless you configure sync or opt in
  to publishing an aggregate report.

## Quick start

For a packaged run with Nix:

```sh
nix run github:astahmer/tokitoki -- --version
nix run github:astahmer/tokitoki -- scan
```

For a checkout:

```sh
git clone https://github.com/astahmer/tokitoki.git
cd tokitoki
bun install

bun src/cli.ts scan
bun src/cli.ts report --last week --by provider
bun src/cli.ts web                 # local dashboard at http://localhost:7788
```

The first scan reads the provider stores already present on your machine. A
new install with no supported harness data simply reports an empty window.
Nothing needs to be uploaded to use the CLI or local dashboard.

## Privacy and data

Tokitoki is local-first: the normalized log and cache live under
`~/.local/share/tokitoki` by default, and the browser server binds locally.
Provider account emails are hidden unless you explicitly enable the
`--show-email`/dashboard toggle. Sync backends, public aggregate sharing, and
optional pricing refreshes are opt-in configuration choices.

To inspect exactly which local stores were discovered:

```sh
bun src/cli.ts sources
```

## Architecture sketch

- Each machine: local scanner writes normalized JSONL append-log
  (`~/.local/share/tokitoki/events.jsonl`) + sqlite cache
- Sync layer: pluggable — Syncthing dir first (zero infra), restic/R2 as backup
- Aggregation: merge all synced logs, dedupe on identity key, aggregate in
  sqlite; totals are pure functions of the merged log
- Store format: append-only, conflict-friendly (Syncthing-safe: last-writer
  wins per line, no mutable DB as sync unit)

## Design principles

- Prefer provider-reported cost and token data; make pricing-based estimates
  visible when a harness only exposes cumulative usage.
- Treat subscription limits as configured gauges, not invented provider truth.
- Keep ingestion incremental and append-only so scans are cheap and sync is
  conflict-friendly.
- Make every surface consume the same normalized event and widget contracts.

## Development setup

The repository includes a Nix dev shell and direnv entrypoint. With
[Nix](https://nixos.org/) and [direnv](https://direnv.net/) installed:

```sh
direnv allow
# entering the directory installs dependencies from bun.lock automatically
# and puts the source `tokitoki` shim on PATH

# run ad hoc:
bun src/cli.ts scan
tokitoki scan
```

The shell provides Bun, pnpm, Git, jq, ripgrep, and (on Darwin) Swift for the
native menu-bar target. Set `TOKITOKI_SKIP_INSTALL=1` to enter without running
the dependency install hook. The `bin/tokitoki.js` source shim is available as
`tokitoki` while the directory is active; no global install is needed for CLI
development.

## Installation

### Nix

The root flake provides a source-built `tokitoki` package for Linux and macOS
(Intel and Apple Silicon). It can be used directly without direnv:

```sh
nix run github:astahmer/tokitoki -- --version
nix build github:astahmer/tokitoki#tokitoki
```

To install it through Home Manager, add the repository to your flake inputs:

```nix
inputs.tokitoki.url = "github:astahmer/tokitoki";
```

Then either install the package directly:

```nix
home.packages = [ inputs.tokitoki.packages.${pkgs.system}.default ];
```

Or use the provided Home Manager module:

```nix
imports = [ inputs.tokitoki.homeManagerModules.default ];
programs.tokitoki.enable = true;
```

The Nix package builds the CLI and web assets ahead of time and includes its
Bun runtime. The installed command does not need `node_modules`, Bun, or
network access at runtime. It also installs the shell adapter files under
`<tokitoki-store-path>/share/tokitoki/integrations`. direnv remains available
separately for repository development through the `devShells` output.

### Shell integrations

Shell integrations consume the same versioned JSON payload as the native
apps instead of reimplementing provider parsing:

```sh
tokitoki scan
tokitoki widget-payload --cached --json
```

For the complete standalone Quickshell widget on Linux/Wayland, with its
runtime and CLI included and no checkout required:

```sh
nix run github:astahmer/tokitoki#quickshell
```

For Home Manager, add `inputs.tokitoki.url = "github:astahmer/tokitoki"`,
import `inputs.tokitoki.homeManagerModules.default`, then choose one host:

```nix
programs.tokitoki.dms.enable = true; # existing DMS: plugin + DankBar placement
# Or:
programs.tokitoki.quickshell.enable = true; # standalone bar + session service
```

To insert a button into an existing Quickshell bar, select
`quickshell.mode = "embedded"` and add the provided QML component.
See [Home Manager installation](integrations/README.md#home-manager-one-input-one-host-option)
for complete recipes, layout migration and embedded mode. CLI-only setups
continue to use `programs.tokitoki.enable = true`.

The standalone widget shares the DMS views, including Sessions, charts, quota
visibility and settings. Its setup and IPC commands are documented in
[`integrations/README.md`](integrations/README.md#standalone-quickshell).
Docker screenshot and interaction tests for both shells live in
[`e2e/README.md`](e2e/README.md).

The remaining experimental adapters and their host-specific installation notes
are documented in [`integrations/README.md`](integrations/README.md). The
adapter source is intentionally kept separate from the host-neutral contract,
so the same data can be reused by DMS, Noctalia, Quickshell, Plasma, Waybar,
GNOME, and COSMIC.

## Publishing

```sh
pnpm pack            # runs prepack: tests + typecheck + build (SPA + bundled CLI)
npm publish          # ships bin/ shim + dist/cli.js + dist/web assets
```

The package is bun-only (`engines.bun`): `dist/cli.js` is a `bun build
--target=bun` bundle, and the SPA is baked into the tarball so installed
copies never need node_modules or a web build. The `bin/tokitoki.js` shim
prefers the built CLI and falls back to `src/cli.ts` in unbuilt checkouts.
Verify a tarball before publishing:

```sh
tar -xzf tokitoki-*.tgz -C /tmp && bun /tmp/package/bin/tokitoki.js --version
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

# Claude 5-hour billing blocks (ccusage semantics) + active-block gauge
# ▸ marks the active block; gauge = elapsed fraction, countdown to reset
tokitoki blocks [--last day] [--account <key>]

# One-line statusline for editor hooks (reads Claude Code stdin JSON):
#   <model> · $<sess> sess · $<today> today · $<MTD> MTD · block <n>% (<m> left)
# register: {"statusLine":{"command":"bun /path/to/tokitoki/src/cli.ts statusline"}}

# sort by any column, filter by provider (repeatable), toggle Δ vs previous period
tokitoki report --last week --by model --sort cost        # default order: cost desc
tokitoki report --last week --sort %cache --asc
tokitoki report --last week --provider pi --provider codex
tokitoki report --last week --no-delta                   # Δ on by default

# ASCII visuals + evolution over time
tokitoki chart --last month                 # daily token bars
 tokitoki chart --last week --spark          # compact sparkline
tokitoki chart --last month --by harness --spark    # one sparkline per harness
tokitoki report --last week --by vendor             # anthropic / openai / google …
tokitoki pie --by model                     # share-of-tokens legend with cost bars

tokitoki budgets                            # [budgets] gauge state (day/week/month caps)
tokitoki budgets --json                     # menubar/web contract: [{scope,label,cap,used,unit,ratio,state,daysLeft}]
tokitoki widget-payload --cached --json     # shared native-app/shell payload
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

Dimensions: `model | vendor | harness | project | repo | account | machine | tool`.
Periods: `day` = local calendar day; `week`/`month` = rolling 7/30 days.

### Harness vs vendor

Two different axes answer "where did this usage go?":

- **harness** — the tool that recorded the event: `claude-code`, `codex`,
  `pi`, `opencode`, `t3code`, `cursor`, … This is the `provider` field on
  every stored event. `--by provider` keeps working as a legacy alias of
  `--by harness` (and `/api/*`, MCP `dimension` accept both); JSON output
  now reports `"groupBy": "harness"`.
- **vendor** — the upstream model maker the tokens were billed against:
  `anthropic`, `openai`, `google`, `xai`, `moonshot`, `cursor`, `github`, …
  An explicit model prefix wins first: `anthropic/…`, or a gateway prefix
  such as `opencode-go/deepseek-v4.1-flash` (→ deepseek, even under codex).
  Otherwise direct harnesses map straight to their vendor (claude-code →
  anthropic, codex → openai, gemini-cli → google). Routed harnesses (pi,
  opencode, t3code, commandcode, …) use the model's vendor, looking through
  gateway prefixes (`openrouter/anthropic/claude-sonnet-4` → anthropic);
  unknown models fall back to the routing account (`openrouter`, `opencode`),
  your `accountAliases`, then `other`. Harness and quota-source vendors come
  from one registry (`src/provider-registry.ts`), which also feeds display
  names, icons, and status pages to every surface.

Vendor is derived at query time from (harness, account, model), so stored
events and their dedupe ids never change and no migration runs.

Multi-machine merge: sync `~/.local/share/tokitoki/events.jsonl` between Macs
(e.g. Syncthing) and list the other machines' files in
`~/.config/tokitoki/config.json`:

```json
{
  "extraEventFiles": ["~/syncthing/tokitoki-other-mac/events.jsonl"],
  "providers": { "pi": { "paths": ["/custom/pi/sessions"] } },
  "plans": {
    "work-gateway": { "kind": "subscription", "monthlyRequestCap": 30000 },
    "opencode-*": { "kind": "subscription", "monthlyCostCap": 200 }
  },
  "accountAliases": { "work-gateway": "openai" }
}
```

`accountAliases` maps custom account keys or model prefixes (`work-gateway/gpt-5`)
to an upstream provider when tokitoki cannot infer it from the name.

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

The same backend works with iCloud Drive when both Macs share one iCloud
account. Use a per-user folder such as
`~/Library/Mobile Documents/com~apple~CloudDocs/tokitoki`; Tokitoki expands the
leading `~`, gives each machine its own JSONL file, and only transfers new
bytes after the first push. Never place `cache.db` or its WAL files in the
shared folder.

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

### Provider quotas (`tokitoki poll`)

`tokitoki poll` reuses local logins to read the quota windows providers report
themselves. A provider is polled only when its credentials are present. If
they are missing, the provider is skipped without an error. tokitoki never
stores secrets of its own; refreshed OAuth tokens are written back only to
the CLI's own credential file.

#### Supported providers / quotas

| Provider (card id) | Vendor | Quota source | What you get | Credential used |
| --- | --- | --- | --- | --- |
| Claude (`claude-code`) | anthropic | `api.anthropic.com/api/oauth/usage` (+ `/profile`) | 5h session, weekly, weekly Opus/Sonnet, extra usage, plan | Claude Code OAuth: `~/.claude/.credentials.json` or macOS Keychain |
| Codex / ChatGPT (`codex`) | openai | `chatgpt.com/backend-api/wham/usage` (+ reset credits) | 5h + weekly windows, banked resets, plan | `~/.codex/auth.json`; opencodex pool `~/.opencodex/codex-accounts.json` |
| Gemini (`gemini-cli`) | google | `cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` + `:retrieveUserQuota` | daily Pro / Flash / Flash Lite model buckets, plan | Gemini CLI OAuth: `~/.gemini/oauth_creds.json`. Expired tokens are refreshed with the client id from the installed Gemini CLI, or `GEMINI_OAUTH_CLIENT_ID`/`_SECRET` |
| GitHub Copilot (`copilot`) | github | `api.github.com/copilot_internal/user` | monthly premium-request meter | `~/.config/github-copilot/{apps,hosts}.json` or `gh` Keychain entry |
| Cursor (`cursor`) | cursor | `api2.cursor.sh` `GetCurrentPeriodUsage` | Cursor / other models, on-demand spend | `~/.cursor/cli-auth.json` or the Cursor IDE `state.vscdb` login |
| z.ai / GLM (`zai`) | zhipu | `api.z.ai/api/monitor/usage/quota/limit` (`open.bigmodel.cn` with `poll.zaiRegion = "bigmodel-cn"`) | Coding Plan token/credit windows, MCP quota, plan | `Z_AI_API_KEY` / `ZAI_API_KEY` (BigModel: `BIGMODEL_API_KEY`, `ZHIPU_API_KEY`, `GLM_API_KEY`) or `poll.extraKeys` with `provider = "zai"` |
| Kimi Code (`kimi`) | moonshot | `api.kimi.com/coding/v1/usages` | 5h, weekly, monthly pools, membership plan | `KIMI_CODE_API_KEY`, `poll.extraKeys` with `provider = "kimi"`, or the Kimi CLI token in `~/.kimi-code/credentials/kimi-code.json` or `~/.kimi/credentials/kimi-code.json` (read only, never refreshed) |
| DeepSeek (`deepseek`) | deepseek | `api.deepseek.com/user/balance` | prepaid balance (paid / granted) | `DEEPSEEK_API_KEY` / `DEEPSEEK_KEY` or `poll.extraKeys` with `provider = "deepseek"` |
| OpenRouter (`pi@openrouter`, extra keys) | openrouter | `openrouter.ai/api/v1/key` + `/api/v1/credits` | key spend-limit window, credit balance | pi auth store `~/.pi/agent/auth.json` or `poll.extraKeys` |
| OpenCode Go (`opencode`) | opencode | `opencode.ai/zen/go/v1/usage` | rolling 5h, weekly, monthly | pi or opencode auth store, or `poll.extraKeys` |
| Command Code (`commandcode`) | commandcode | `api.commandcode.ai` billing API | 5h, weekly, monthly credits | `~/.commandcode/auth.json` |

Vendor status pages are checked too, with results cached for 5 minutes in
the cache meta table. The sources are Statuspage summaries for Anthropic,
OpenAI, Cursor, and GitHub, and Google's Workspace incidents feed for Gemini.
`widget-payload` exposes them as `statusIncidents`. The statusline adds a
short segment such as `Claude partial outage: …` while a vendor is degraded.
Disable the checks with `statusIncidents.enabled = false`.

In `widget-payload`, each provider-reported window carries provider-neutral
fields next to the legacy `kind`:

| field | meaning |
| --- | --- |
| `id` / `label` | id unique per account (`session`, `weekly`, `weekly:opus`; a repeat gets `:2`) and display name |
| `scope` | `session` \| `daily` \| `weekly` \| `monthly` \| `model` \| `other` (provider did not report a duration; `windowMinutes` is then omitted) |
| `usedPercent` / `resetsAt` / `windowMinutes` | provider usage and reset |
| `pace` | `expectedPercent` at an even burn, `status` (`under`/`on`/`over`), and `runsOutAt` when the current rate exhausts the window before it resets |

Account entries add `plan`, `vendor`, `balance` for prepaid accounts, and, for Claude, `extraUsage`. Legacy `kind`
values are unchanged ("day" still names the 5h session window), so existing
clients keep working.

Polling backs off: after an HTTP 429 a provider is held for at least five
minutes (or the server's `Retry-After`), and Claude is never polled more than
once every 300 seconds. Held providers answer from their last stored
snapshot.

### Plan gauges (honest approximation)

Rows whose accountKey matches a `plans` pattern (exact or trailing `*`) show
a month-to-date usage gauge instead of a cost cell — most useful with
`--by account`. Use them for accounts without provider-reported quotas (API
keys, gateways): caps are user-configured estimates, and the gauge is only as
honest as the cap you set.

- Tests + runner are Bun-native (`bun test`, imports from `bun:test`); sqlite is `bun:sqlite`
## Web dashboard

```sh
bun run web:build       # vite build → dist/web/  (required once)
tokitoki web            # → http://localhost:7788  (--port to change)
bun run web:dev         # vite dev server :5177, /api proxied to :7788
```

React + TypeScript SPA built with Vite, styled with Cloudflare Kumo and
Tailwind CSS v4, with charts via **TanStack Charts** (line timeseries + polar
donut).

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
- **limits** tab: vendor → account → plan cards with per-window bars, a
  pace marker (even-burn position), reset countdown, runs-out ETA, extra
  usage, and freshness — sourced from `/api/limits` (same builder as
  `limits --json`).
- Parity with the CLI: period + group-by tabs (incl. vendor, harness, repo),
  harness filter chips, multi-account tabs, click-to-sort table (%share, %cache, Δ vs
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
- [Packaging](docs/packaging.md) — source-first run model (compiled-binary flow removed 2026-08-25),
  historical cross-compile/release notes, nix packaging recipe
- [Menu-bar app](menubar/tokitoki-menubar/) — native SwiftUI MenuBarExtra
  (macOS 13+), `swift build`, refreshes every 5 min from the compiled CLI

## Limits JSON (`tokitoki limits --json`)

Every account's quota windows as one stable, versioned document — the same
data the menubar and web **limits** tab render, grouped vendor → account →
plan → windows. Account emails are omitted unless you pass `--show-email`
(`?showEmail=1` over HTTP, `showEmail: true` in MCP):

```jsonc
{
  "version": 1,                       // bumped only on breaking changes
  "generatedAt": "2026-10-18T12:00:00.000Z",
  "accounts": [{
    "id": "claude-code@default",      // harness@accountKey, stable
    "vendor": "anthropic",
    "vendorName": "Anthropic",        // registry display name
    "harness": "claude-code",
    "alsoOn": [],                     // other harnesses sharing this login/key
    "accountKey": "default",
    "email": "me@example.com",        // optional: label, email, plan, credential (redacted)
    "plan": "Max 20x",
    "freshness": "fresh",             // fresh | stale | unknown (provider-reported data)
    "observedAt": "2026-10-18T11:58:00.000Z",
    "extraUsage": { "enabled": true, "usedUsd": 12, "limitUsd": 50 },
    // prepaid accounts (DeepSeek, OpenRouter) add "balance": { "currency": "USD", "remaining": 12.5, … }
    "windows": [{
      "id": "session",                // session | weekly | weekly:opus | monthly:<bucket> | day/week/month (derived)
      "label": "Session",
      "scope": "session",             // session | daily | weekly | monthly | model | other
      "source": "provider",           // provider-reported quota, or "derived" from local events
      "usedPercent": 42,              // null when there is no denominator
      "windowMinutes": 300,
      "resetsAt": "2026-10-18T14:00:00.000Z",
      "pace": { "expectedPercent": 60, "deltaPercent": -18, "status": "under", "runsOutAt": "…" },
      "tokens": 1234567, "costUsd": 4.2, "requests": 37
    }]
  }]
}
```

The command is read-only (it never scans or polls); run `tokitoki poll` to
refresh provider-reported windows. Optional fields are omitted, never `null`,
except `usedPercent`.

## Local HTTP API (`tokitoki serve`)

```sh
tokitoki serve                      # http://127.0.0.1:6736 (loopback only)
tokitoki serve --port 7000
tokitoki serve --host 0.0.0.0       # explicit opt-in to listen beyond loopback
```

Read-only (GET/HEAD), JSON, versioned (`"version": 1` in every body):

| Endpoint | Returns |
|---|---|
| `GET /v1/health` | health: `{version, ok, app, appVersion, generatedAt, events}` |
| `GET /v1/status[?last=day\|week]` | compact widget summary, same as `tokitoki web`'s `/v1/status` |
| `GET /v1/limits[?showEmail=1]` | the `limits --json` document (emails hidden by default) |
| `GET /v1/usage?period=today\|week\|month&by=vendor\|harness\|model` | `{version, period, by, window, total, rows:[{key, requests, sessions, …tokens, tokens, costUsd}]}` (defaults: `today`, `vendor`; `by=provider` = harness) |

Invalid query params return `400` with zod details. The server sends no CORS
headers, and while bound to loopback it rejects requests whose `Host` is not
loopback (DNS-rebinding guard). `today` is the local calendar day;
`week`/`month` are rolling 7/30 days like `report`.

```sh
curl -s localhost:6736/v1/limits | jq '.accounts[] | {vendor, plan, w: [.windows[] | {label, usedPercent, resetsAt}]}'
curl -s 'localhost:6736/v1/usage?period=week&by=vendor' | jq '.rows[] | "\(.key) $\(.costUsd)"'
```

Waybar custom module (session window of the first Anthropic account, today's
spend in the tooltip):

```jsonc
"custom/tokitoki": {
  "exec": "curl -sf localhost:6736/v1/limits | jq -c '[.accounts[] | select(.vendor == \"anthropic\")][0].windows[0] as $w | {text: \"✦ \\($w.usedPercent // 0 | floor)%\", tooltip: \"\\($w.label // \"no quota\") resets \\($w.resetsAt // \"?\")\", percentage: ($w.usedPercent // 0 | floor)}'",
  "return-type": "json",
  "interval": 60,
  "on-click": "xdg-open http://localhost:7788/?view=limits"
}
```

With Home Manager, run it as a user service:

```nix
programs.tokitoki.serve = {
  enable = true;   # systemd user unit `tokitoki-serve`
  port = 6736;     # host defaults to 127.0.0.1
};
```

`tokitoki web` exposes the same document at `/api/limits` and `/v1/limits`.

## MCP server

`tokitoki mcp` (stdio, local-only — no port, no daemon) exposes the CLI's
reporting surface as MCP tools: `usage_report`, `usage_totals`,
`sessions_top`, `session_detail`, `tool_spend`, `repo_efficiency`,
`budgets_status`, `quota_snapshot`, `get_limits`, `anomalies`, `sources`,
`scan_now`, `export_report`. Window flags map 1:1 to CLI semantics (`last`:
day|week|month or durations like `24h`); `dimension` accepts `vendor` and
`harness` (`provider` is the legacy alias). `get_limits` returns the
`limits --json` document, optionally filtered by `vendor`. Register it in
your client:

```jsonc
// claude / codex / generic mcp config
{
  "mcpServers": {
    "tokitoki": {
      "command": "bun",
      "args": ["/path/to/tokitoki/src/cli.ts", "mcp"]
      // or the compiled binary: { "command": "/path/to/dist/tokitoki", "args": ["mcp"] }
    }
  }
}
```

## Menu-bar app

Start/stop the native app from the CLI (macOS Swift app today; Electrobun
port tracked in plans/linux-menubar.md):

```sh
tokitoki menubar            # start (idempotent; launchctl-aware on macOS)
bun run menubar             # rebuild Swift + restart the launchd app from this checkout
bun run menubar:restart     # explicit alias for the same source-first flow
tokitoki menubar --status   # pid + running state
tokitoki menubar --stop     # stop (launchctl bootout when plist present)
tokitoki menubar --foreground   # attached, logs to stdout
```

Binary resolution mirrors the app's own CLI lookup in reverse:
`$TOKITOKI_MENUBAR_BIN` → repo build → `~/bin/tokitoki-menubar`.

The Settings tab's **Open config file** button opens the active configuration
source. By default this is `~/.config/tokitoki/config.json`; if JSON is absent
and `config.toml` exists, TOML remains the writable source so UI changes do
not create a drifting JSON sidecar. UI setters also accept an explicit
`TOKITOKI_CONFIG=/path/to/config.toml` override. `tokitoki config --json` is a
read-only machine-readable view of the effective file.

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
  one), deduped per period in `<data-dir>/menubar-state.json` so a restart
  never re-notifies; bare LaunchAgent builds use macOS's local notification
  bridge when a bundle identifier is unavailable
- **critical quota alerts** when a provider reports a configured amount of
  remaining capacity, plus a reset notification when an exhausted window
  becomes available again; observations survive restarts in
  `<data-dir>/menubar-quota-state.json`
- **spend guard** in Settings: month-to-date spend, daily burn rate, projected
  month-end spend, and warning/exceeded state against `[budgets].monthly`
- **actionable usage side-notch**: the edge rail can run in Quota, Activity,
  or Runway mode. Hovering a provider shows its remaining windows plus compact
  actions to refresh, fix login/API-key access, open the provider console, or
  jump to its latest indexed session. Activity is intentionally labelled as
  indexed/recent activity rather than pretending to be a live provider hook.
- **attention state on the rail**: providers that need login or an API key get
  an orange badge and an explicit recovery action; right-clicking a provider
  exposes the same actions without opening the popover.

Menubar notification preferences are stored in a top-level `[notifications]`
section:

```toml
[notifications]
enabled = true
resetAware = true
quotaCriticalPercent = 10
burnWarnings = true
burnWarningRatio = 0.8
# disabled = ["quotaPace"]     # opt out per category
```

Categories: `quotaCritical`, `quotaReset`, `quotaPace` (the current burn
rate exhausts a window before it resets, CodexBar-style), `burnRate` and
`budget`.

### Desktop alerts on Linux (`tokitoki notify`)

The same `[notifications]` settings drive desktop alerts on Linux. The DMS,
Quickshell, Noctalia (v4 and v5), Waybar, GNOME and COSMIC integrations call
`tokitoki widget-payload --notify` on every refresh, so enabling
notifications in the widget settings is enough; alerts go through
`notify-send` (libnotify). Each alert fires once per window reset or
calendar period, stale scanned quotas never alert, and several bars on
several monitors share one lock so nothing fires twice. History lives in
`<data-dir>/notify-state.json` and shows up in the web dashboard next to
menubar alerts.

```sh
tokitoki notify --dry-run    # what would fire now, without sending or recording
tokitoki notify              # send pending alerts (e.g. from a cron/systemd timer)
```

KDE Plasma reads `tokitoki web` and never runs the CLI, so use the Home
Manager timers there, or wherever alerts should not depend on a bar:

```nix
programs.tokitoki.notify.enable = true; # `tokitoki notify` every 5 min while the graphical session runs
programs.tokitoki.poll.enable = true;   # optional: `tokitoki poll` every 15 min for live provider quotas
```

Both take an `interval` (systemd time span). The notify timer stops with the
session, so an alert is never recorded without a notification daemon to show it.

The side-notch is configured independently from the menubar preview:

```toml
[ui]
sideNotchEnabled = true
sideNotchMode = "runway"       # quota | activity | runway
sideNotchMetric = "smart"      # percent | tokens | smart
sideNotchWindow = "smart"      # smart | day | week | month
sideNotchPlacement = "right"   # any of the 12 perimeter anchors
# showHarnessVariants = true    # optional: split cards by harness (default false)
```

`sideNotchSyncPreview = true` mirrors the preview's enabled state, provider
visibility, and metric when that is more convenient. The notch's mode and
placement remain independent so the two surfaces can serve different jobs.

Usage cards default to one card per inferred upstream account key, so the same
OpenAI or OpenCode account is not repeated once for every harness that uses it.
This only changes the menubar/widget card projection; scans, reports, and raw
quota observations stay detailed. Set `ui.showHarnessVariants` to `true` (or
use Preferences → Detailed harness cards) when per-harness cards are useful.

## Pricing data

Model prices auto-sync from [Models.dev](https://models.dev), falling back to
LiteLLM's community pricing JSON, into `<data-dir>/pricing.json` (7-day TTL, 1h retry throttle when offline). The
embedded snapshot is the offline fallback. Unknown models estimate as $0 with
a one-time stderr note.

## Supported harnesses

| Provider | id | Status | Store | Notes |
|---|---|---|---|---|
| Claude Code | `claude-code` | ✅ working | `~/.claude/projects` JSONL | tokens + tools + emails |
| pi | `pi` | ✅ working | `$PI_DIR/agent/sessions` JSONL | tokens, cost reported by harness |
| Codex CLI | `codex` | ✅ working | `~/.codex/sessions` JSONL | delta-usage rollouts, best effort on unknown shapes |
| opencode | `opencode` | ✅ working | `$XDG_DATA_HOME/opencode/opencode*.db` SQLite | request-level tokens+cost from assistant messages; watermark cursor on `message.time_updated`; legacy WAL stores opened via immutable fallback; sessions searchable (title + text parts) |
| T3 Code | `t3code` | ◐ indexed only | `~/Library/Application Support/t3code/IndexedDB/*.leveldb` | threads searchable (titles/prompts); store exposes **no token usage** |
| Antigravity CLI | `antigravity-cli` | ◐ provenance only | `~/.gemini/antigravity-cli/conversations/*.db` | protobuf blobs; no usage exposed |
| Cursor | `cursor` | ◐ indexed only | `state.vscdb` + `ai-tracking/ai-code-tracking.db` | transcripts/summaries searchable; **no token counts in any inspected store** (199k activity-hash rows verified) |
| Grok CLI | `grok` | ✅ working | `$GROK_HOME/sessions/**/*.jsonl` | tolerant codex-family parser (`last_token_usage` deltas preferred, flat `usage` spellings accepted) |
| Command Code | `commandcode` | ✅ working | `~/.commandcode/sessions/*.jsonl` | pi-like JSONL; usage on the entry, model on `model_change` |
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

## Roadmap

The core ingestion and reporting loop is usable today. The next improvements
are deliberately incremental:

- richer provider quota coverage and reset-aware polling
- a more visual request timeline in session details
- keyboard-first and narrow-viewport polish for the dashboard
- additional harness adapters and deeper indexed-session support
- a Linux-native menubar target alongside the existing macOS app

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
