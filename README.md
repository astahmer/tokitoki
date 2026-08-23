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

```sh
pnpm install
pnpm link --global   # optional, exposes `tokitoki`
# or run ad hoc:
npx tsx src/cli.ts scan
```

## Usage

```sh
tokitoki scan                       # incremental scan of all providers
tokitoki scan --provider pi         # one provider (pi | claude-code | codex)
tokitoki today                      # today's usage grouped by model
tokitoki report --last week --by account
tokitoki report --last month --json # machine-readable
```

Dimensions: `model | project | account | machine | provider`.
Periods: `day` = local calendar day; `week`/`month` = rolling 7/30 days.

Multi-machine merge: sync `~/.local/share/tokitoki/events.jsonl` between Macs
(e.g. Syncthing) and list the other machines' files in
`~/.config/tokitoki/config.json`:

```json
{
  "extraEventFiles": ["~/syncthing/tokitoki-other-mac/events.jsonl"],
  "providers": { "pi": { "paths": ["/custom/pi/sessions"] } }
}
```

Events dedupe on a stable id `(provider, accountKey, sessionId, entryId)` —
the same session synced to two machines counts once.

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
