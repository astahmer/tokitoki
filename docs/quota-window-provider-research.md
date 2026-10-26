# Native provider quota semantics

Updated **2026-10-26**. This note replaces the historical 2026-10-24
implementation audit. It describes the native integration contract and its
remaining boundaries; the earlier audit's local observations and line numbers
are not evidence about the current implementation. No authenticated requests or
live account inspection were performed for this replacement.

## Codex

Use the installed stock `codex app-server` for each configured native home.
`account/read` supplies the signed-in account and optional email/plan;
`account/rateLimits/read` supplies quota observations. Authentication and renewal
belong to that home’s Codex CLI, including its configured credential store.
Tokitoki does not own a second account pool or copy credentials into a default
home. See the [official app-server contract](https://learn.chatgpt.com/docs/app-server)
and [native account setup](native-harness-migration.md).

The multi-bucket response is `rateLimitsByLimitId`; the legacy `rateLimits`
field is a single-bucket view. A metered bucket ID is not an account ID. Keep
account, bucket and window-slot identity separate, retaining every returned
bucket and its optional windows. Do not infer identity from a plan name, or
assume every account has a five-hour and a weekly window. Returned durations
and reset timestamps determine the presentation; missing metadata stays unknown.

Earned resets are separate from usage percentages and workspace credit
balances. `rateLimitResetCredits.availableCount` is the authoritative inventory
when returned; missing inventory is unknown. A successful reset requires a new
quota read before displaying updated usage. See the
[rate-limit and reset contract](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

## Shared observation rules

- A complete account observation replaces that account’s current topology;
  historical durations must not accumulate into extra current windows.
- Partial observations update only their identified bucket/slot. A metered ID
  shared by different accounts must never merge those accounts.
- Preserve observation time per window. Cache reads are not new observations.
  An elapsed reset does not establish zero usage in the next cycle.
- Distinguish current, stale, expired, unknown and unavailable states. Only a
  current observed percentage can establish remaining capacity or pace.
- Keep local calendar usage and configured budgets in `budgetWindows`, separate
  from provider-reported quotas. Paid usage and balances are separate again.
- Preserve provider labels, calendar/cycle boundaries and optional model scope.
  Missing duration or reset information must not acquire a guessed default.

## Other provider boundaries

Claude subscription windows, Anthropic API rate limits, Cursor subscription
pools and Copilot allowances describe different products. Do not infer one
provider’s reset schedule or quota topology from another provider’s duration.
Provider adapters must preserve the fields they actually receive; consumer
pricing descriptions do not establish undocumented wire keys.

Copilot calendar allowances use actual calendar boundaries rather than a fixed
30-day approximation. Cursor’s supplied billing boundaries remain authoritative;
unrecognized current-plan wire shapes must not be represented as a fabricated
weekly pool. Claude extra usage remains distinct from included quota windows.
See [adapter support limits](provider-quota-adapter-limits.md) for the scope and
uncertainty of those integrations.

T3 Code remains a session/activity harness. Its usage can contribute to reports
without creating an independent subscription quota account. Native account
emails, multiple profiles, presentation preferences, refresh/login actions and
banked reset inventory are tracked in the
[migration feature mapping](native-harness-migration.md).
