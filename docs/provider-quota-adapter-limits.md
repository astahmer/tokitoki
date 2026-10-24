# Provider quota adapter limits

Verified 2026-10-24 without authenticated requests or token refreshes.

Cursor's supported `DashboardService/GetCurrentPeriodUsage` contract remains the
observed legacy response: `planUsage.autoPercentUsed`,
`planUsage.apiPercentUsed`, optional millisecond `billingCycleStart` and
`billingCycleEnd`, and optional `spendLimitUsage.pooledUsed`/`pooledLimit`.
Actual cycle boundaries are preserved; absent boundaries do not imply 30 days.
On-demand spend remains separate from the two included pools in the parser.

[Cursor's current usage documentation](https://cursor.com/help/models-and-usage/usage-limits)
confirms that The X Subscription uses a shared weekly pool and directs users to
`grok.com/dashboard`, while legacy plans retain monthly pools. It does not
document the weekly endpoint's wire schema or an authoritative response field
that distinguishes migrated accounts from legacy accounts. No first-party
weekly quota endpoint/schema was established during this pass. Weekly-only,
aggregate-only (including `planUsage.totalPercentUsed` alone), null, or otherwise
unrecognized responses return an explicit unsupported/unavailable result.
Marketing descriptions and third-party client guesses are not used to infer
weekly usage, resets, duration, or migration status. A legacy-shaped response
cannot by itself prove an account has not migrated.

[Microsoft's first-party Copilot parser](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/chat/common/chatEntitlementService.ts)
establishes UTC reset precedence, per-bucket Unix-second reset overrides,
`quota_remaining`, `token_based_billing`, and legacy Free quotas. Calendar-month
bounds are derived only when the authoritative reset is the first day at
00:00 UTC. Other reset timestamps are retained with unknown duration. Premium
interaction buckets are labeled AI Credits under token-based billing and
Premium requests otherwise.

Claude recognizes only the observed named five-hour, seven-day, Opus and Sonnet
fields. A documented Fable allowance does not establish a `seven_day_fable`
wire key. Missing resets stay unknown; the explicit five-hour/week durations
remain known.

OpenRouter key credit limits and prepaid balances remain distinct. A period name
does not supply a reset timestamp; a monthly period alone does not establish a
30-day duration. Command Code monthly credits likewise require both supplied
subscription period bounds to establish duration; an end alone remains useful
as a reset without inventing a start.
