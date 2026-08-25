# Quota windows beyond codex — extraction feasibility findings (2026-08-25)

Question: can we extend embedded provider-quota extraction (the codex
`rate_limits` pattern — `UsageEvent.quota { primary?, secondary? }` parsed
from local harness files) to claude-code, gemini-cli, grok, cursor?

Method: exhaustive JSON-key scans (`*quota*`, `*limit*`, `*reset*`,
`*percent*`, `*credit*`, `five_hour`, `plan_type`, …) over the real local
stores on this machine, plus sqlite schema inspection. Evidence paths cited
per provider. Honesty over coverage: **all four came back negative**.

## Verdict table

| Provider | Verdict | Local store inspected | Embedded quota found |
|---|---|---|---|
| claude-code | ❌ SKIP | `~/.claude/projects/**/*.jsonl` (~all sessions), `~/.claude/history.jsonl`, `~/.claude/sessions/` | none |
| gemini-cli | ❌ SKIP | `~/.gemini/tmp` (absent), `~/.gemini/antigravity-cli/conversations/*.db` | none queryable |
| grok | ❌ SKIP | `~/.grok` does not exist; t3code cache reports CLI "not installed or not on PATH" | no store to inspect |
| cursor | ❌ SKIP | `~/.cursor/ai-tracking/ai-code-tracking.db` | tables are code-tracking only |

## Per-provider evidence

### claude-code — SKIP
- Zero JSON keys matching any quota/rate-limit/reset/percentage pattern across
  every transcript in `~/.claude/projects`.
- The only grep hits for "rate_limit" were **user project source code embedded
  in transcript file contents** (e.g.
  `~/.claude/projects/-Users-astahmer-dev-welii-bite/*.jsonl` contains an
  app's own `PUBLIC_API_ORG_RATE_LIMIT_PER_MINUTE` constant) — false positives,
  not harness data.
- `~/.claude/statsig.json` mentions `usage_limit_notifications_enabled` /
  `tengu_rate_limit_promo_notices` — feature-flag *names*, not usage state.
- Conclusion: Claude Code keeps limit state server-side (consistent with why
  CodexBar resorts to OAuth/API polling for Claude). Nothing to extract
  without network calls, which this architecture forbids by design.
- Re-check trigger: if a future build starts writing keys like
  `used_percentage` / `resets_at` into assistant/system lines, the codex
  pattern drops straight in.

### gemini-cli — SKIP
- `~/.gemini/tmp` (the provider's default root) does not exist on this
  machine — gemini-cli has never run here, so there is no session data to
  verify payload shapes against.
- The gemini-family sibling that DOES have data (antigravity-cli) stores
  conversations as opaque BLOBs in per-conversation sqlite
  (`gen_metadata.data`, `trajectory_metadata_blob.data`) with no structured
  quota columns — see also the note in `src/providers/antigravity-cli.ts`.
- Re-check trigger: install/run gemini-cli once, dump `~/.gemini/tmp/**`
  and look for model-usage entries carrying quota fields.

### grok — SKIP
- `~/.grok/sessions` (provider default root) absent; `~/.grok` entirely absent.
- `~/.t3/caches/grok.json` (t3code's driver cache) explicitly reports:
  `"status": "error" … "Grok CLI (grok) is not installed or not on PATH."`
- No store exists on this machine to reverse-engineer; upstream Grok Build
  CLI may embed rate-limit info in its session JSONL (unknown). Re-check when
  the CLI is actually installed and has produced sessions.

### cursor — SKIP
- `~/.cursor/ai-tracking/ai-code-tracking.db` tables:
  `ai_code_hashes, ai_deleted_files, conversation_summaries, scored_commits,
  tracking_state, tracked_file_content` — all code-tracking, zero
  usage/limit/balance tables.
- Cursor computes usage/limits server-side (dashboard + API); the local DB is
  not a source for it. Same conclusion class as claude-code.

## Consequence

- `EXTRACTION_VERSION` stays **3** — a bump would force a full replay for
  nothing. Bump to 4 only if/when one of these providers gains real embedded
  quota payloads (comment already documents the convention).
- `src/types.ts` unchanged: `QuotaWindow`/`QuotaSnapshot` already cover every
  shape we'd need (windowMinutes/usedPct/resetsAtEpoch/credits).
- The menubar/web "limit cards" surface remains codex-only until either
  (a) a provider starts embedding limits locally, or (b) we deliberately add
  an opt-in API-polling provider (out of scope for this architecture; that's
  CodexBar's lane).
