# Local usage-tracking benchmarks

Research date: **2026-10-26**. Recommendation: fix accounting semantics and preserve uncertainty before adding more dashboards or forecast heuristics.

## Scope and reproducibility

Public internet documentation and source only; no tracker was run against local sessions, credentials, or provider endpoints. Tokitoki's broad `src/` snapshot was read, with accounting paths inspected in detail. Local baseline: `62c8b069384a4e38744b44ce8b6ee4507fe0c41d` **plus the existing dirty working copy**; local links below describe that working copy and may change during parallel implementation. This is a source comparison, not a runtime accuracy or performance benchmark.

Read ancestor `AGENTS.md` and `reference-repos.md` first. The listed `~/.references/codeburn` clone was absent on this machine; public CodeBurn and CodexBar snapshots were fetched into temporary directories instead. Existing working files were preserved.

Pinned public references:

- **CodeBurn**, the likely intended “Codeburner”: [documentation](https://codeburn.app/docs), [getagentseal/codeburn, `de08cee8e1ac82985b33d5aab096737f90ce7ea2`](https://github.com/getagentseal/codeburn/tree/de08cee8e1ac82985b33d5aab096737f90ce7ea2).
- **ccusage**: [official documentation](https://ccusage.ryoppippi.com/), [`e351d846191a0176520e8b3d8151dd80a60bc7e4`](https://github.com/ccusage/ccusage/tree/e351d846191a0176520e8b3d8151dd80a60bc7e4). The requested `ryoppippi/ccusage` URL now redirects to `ccusage/ccusage`.
- **CodexBar**: [steipete/CodexBar, `d34fbb47afe73f81dd591bae28a60f72c39a9fe4`](https://github.com/steipete/CodexBar/tree/d34fbb47afe73f81dd591bae28a60f72c39a9fe4).
- **Claude Code Usage Monitor**: [Maciek-roboblog/Claude-Code-Usage-Monitor, `c59a83bf943f329f0e61f1a29c760353ee1860a5`](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/tree/c59a83bf943f329f0e61f1a29c760353ee1860a5).

## How they work; what to borrow

### CodeBurn: normalize each harness before aggregating

Its adapters read tool-specific local stores and produce shared call records for project/model/task reports. The useful pattern is explicit source-specific accounting, rather than one formula over raw counters. Its Codex adapter subtracts cached input from inclusive input; cache-write accounting is conditional on an explicit price. See [`src/providers/codex.ts:918–945`][burn-cache].

For Codex, it rejects unchanged cumulative snapshots, uses last-request counters when available, derives differences otherwise, and advances cumulative baselines on both paths. It also considers parent replay when generating dedupe keys. This is a stronger model than “every token_count line is a request,” though its own comments acknowledge ambiguity without cumulative identity. See [`src/providers/codex.ts:1423–1508`][burn-events].

Its documentation describes per-harness dedupe and excludes gateway aggregates from combined totals by default because local records may already include that spend. Borrow that explicit coverage boundary; do not blindly copy heuristic task categories or claim gateway and local costs are additive. See [`docs/how-it-works.md`, per-tool parsing][burn-how].

### ccusage: inspectable reports with defensive ingestion

ccusage provides local JSONL usage reports and structured output; its current Codex implementation is under `rust/adapters/codex/`. It prefers active/plain session files over archived/compressed copies and deduplicates overlapping root discovery. See [`src/paths.rs:88–115,228–234`][cc-paths].

The parser gates last-request usage on cumulative advancement, supports cumulative differences, and constrains overlapping cache classes. Its report exposes uncached input by subtracting cache reads and creation. See [`src/parser.rs:479–507,1284–1315`][cc-parser] and [`src/report.rs:123–144`][cc-report]. Parent-prefix replay handling is separate from file discovery: [`src/replay.rs:154–178`][cc-replay]. Borrow layered defenses and small fixture-driven parser rules.

### CodexBar: independent quota and cost coverage; honest pricing

CodexBar documents account quota and local estimated API cost as separate datasets with different coverage: a remote quota percentage cannot recover missing local tokens or imply dollars. See [`docs/codex.md`, “Cost usage (local log scan)”][bar-codex].

Its pricing contract distinguishes an explicit zero rate from a missing rate, keeps exact provider/model routing boundaries, supports custom prices, and invalidates cached estimates when pricing changes. Borrow those contracts, especially unpriced-day display and preserving authoritative recorded costs. See [`docs/model-pricing.md`][bar-prices]. Request/response identity and mirrored-record reconciliation also deserve inspection: [`CostUsageScanner+RequestIdentity.swift`][bar-identity].

### Claude Code Usage Monitor: provenance and freshness for forecasts

The monitor can capture official Claude statusline `rate_limits`, including observation metadata; this provides percentages/reset times, not an inferred token allowance. See [`src/claude_monitor/output/official.py:39–112`][monitor-official]. Snapshot selection prefers fresh official data, then opt-in experimental API data, then labeled local estimates: [`output/snapshots.py:367–403`][monitor-snapshot].

Borrow the explicit trust hierarchy. Do **not** import its hardcoded plan allowances or historical P90 inference as provider truth; its plan definitions include an explicitly unverified Team estimate. See [`core/plans.py:30–87`][monitor-plans]. It is also not a universal pricing reference: unknown/non-Anthropic models receive zero rates in [`core/pricing.py:58–65,240–257`][monitor-prices].

## What Tokitoki already does

- **Local ingestion and durable history:** [src/scan.ts](../src/scan.ts) keeps byte cursors and parser state, waits for complete JSONL lines, streams chunks, and replays after extraction-version changes. [src/store.ts](../src/store.ts) appends normalized events; [src/cache.ts](../src/cache.ts) uses event primary keys and `INSERT OR IGNORE` to make repeated IDs idempotent. Retain this foundation.
- **Useful dimensions:** [src/types.ts](../src/types.ts) already carries provider, account label, machine, model, project, session, and optional tool. [src/report.ts](../src/report.ts) aggregates reports; a new dimension system is unnecessary for the immediate fixes.
- **Separated quota observations:** [src/providers/codex.ts](../src/providers/codex.ts) emits quota through `onQuota` even without billable token usage. [src/limits-document.ts](../src/limits-document.ts) retains freshness and observation timestamps; [src/quota-windows.ts](../src/quota-windows.ts) preserves unknown duration and suppresses pace without usable timing. Preserve these distinctions.
- **Offline pricing fallback:** [src/pricing.ts](../src/pricing.ts) caches Models.dev prices, falls back to LiteLLM and embedded rates, and throttles retries. However, event cost provenance is lost and incomplete/missing pricing can become zero.

## Prioritized implementable gaps

1. **P0 — Make token classes disjoint at adapter boundaries.** Codex currently copies inclusive `input_tokens` and separately copies `cached_input_tokens`; `estimateCost`, `report.totalTokens`, and `format.cachePct` treat the classes as additive. Normalize to uncached input plus separate cache buckets, document the invariant in `UsageEvent`, and audit Gemini/T3 adapters against their actual source contracts. Do not subtract cache again from Claude's already separate input. Example fixture: inclusive input 1,000, cached 800, output 100 becomes uncached 200, cached 800, output 100; total 1,100, cache hit 80%, cost `200×input_rate + 800×cache_rate + 100×output_rate`. Update extraction versions and rebuild derived aggregates. Evidence: [Tokitoki pricing](../src/pricing.ts), [Codex parser](../src/providers/codex.ts), [totals](../src/report.ts), [formatting](../src/format.ts), [CodeBurn normalization][burn-cache].

2. **P0 — Preserve unknown cost and pricing provenance end to end.** `priceForModel` falls back to `ZERO`; catalog builders default missing price classes to zero; SQLite defines `cost_usd NOT NULL DEFAULT 0` and insertion uses `e.costUsd ?? 0`. Introduce cost status/source, nullable unknown cost, and aggregate priced/unpriced request and token counts. Show a known subtotal plus incomplete coverage; only a confirmed free rate should display as free. Distinguish harness-recorded cost from estimated API value and persist provider/model, pricing source/version, and applicable rate metadata so estimates can be repriced without changing recorded costs. Acceptance: an unknown model retains tokens and shows unknown cost; an explicit free model shows $0; mixed reports disclose partial coverage. Evidence: [pricing](../src/pricing.ts), [cache](../src/cache.ts), [event type](../src/types.ts), [CodexBar pricing contract][bar-prices].

3. **P1 — Reconcile Codex cumulative snapshots before emitting usage.** Tokitoki ignores `total_token_usage`, emits every nonempty `last_token_usage`, and skips totals-only events. Persist a per-session cumulative baseline; reject unchanged snapshots; use valid last-request counts or derive differences when absent. Always advance the baseline. Handle reset/decrease explicitly rather than negative usage or summing the entire new total. Keep quota-only observations flowing. Acceptance fixtures: repeated snapshot; mixed last/totals-only events; reset; restart at saved cursor; two legitimate requests with equal token counts. Evidence: [current adapter](../src/providers/codex.ts), [CodeBurn guards and baselines][burn-events], [ccusage parser][cc-parser].

4. **P1 — Extend dedupe beyond physical line identity.** Tokitoki's Codex IDs use session/account plus line index: replaying the same file is stable, but copied parent history inside a new fork has a different session namespace. Prefer provider request/response IDs, canonicalize discovered files, and add parent-prefix reconciliation when explicit lineage exists. Scope fallback fingerprints by source/session; identical token amounts alone are insufficient identity. Audit duplicate roots, archived copies, partial/final assistant records, and T3/native mirrors before combining sources; choose an owner or expose overlap instead of counting both. Acceptance: archive and fork fixtures count each real request once; separate requests with identical counts both survive. Evidence: [event IDs](../src/machine.ts), [Codex adapter](../src/providers/codex.ts), [T3 ingestion](../src/providers/t3code.ts), [ccusage file discovery][cc-paths], [fork replay][cc-replay], [CodexBar mirror reconciliation][bar-identity].

5. **P2 — Expose measurement quality and coverage consistently.** Add token provenance (`reported`/`estimated`/`unavailable`) to events and aggregates: Cursor and the legacy T3 path estimate from characters, but the normalized event has no quality field. Retain source/freshness/account scope on quota displays and exports. Name local cost “estimated API cost”; name configured caps “budget”; reserve “provider quota” for observed provider data. Acceptance: an estimated-token row is visibly labeled, stale quota retains its observation age, unknown windows have no invented duration/reset/pace, and local spend never implies subscription remaining. Evidence: [Cursor](../src/providers/cursor.ts), [T3](../src/providers/t3code.ts), [types](../src/types.ts), [quota document](../src/limits-document.ts), [monitor trust hierarchy][monitor-snapshot].

## Pitfalls to keep explicit

Implementation follow-through in this working copy: explicit cost provenance
and incomplete-price handling; strict model-variant matching; disjoint Codex
input/cache counters; cumulative snapshot guards and saved deltas; provenance
and corrected-counter enrichment of legacy IDs; period-aware tracking quality
in QML, Swift and web. A subsequent pass adds independent token provenance,
reported Cursor/T3 sources, and native lineage-verified fork prefix dedupe.
Replay decisions are durable log records; raw historical events are preserved.
Full pricing-revision histories remain a separate follow-up. The findings
above describe the inspected baseline, rather than claiming those defects
remain in the updated implementation.

- **Unknown cost ≠ zero.** Missing a consumed cache class's rate also makes the estimate incomplete.
- **Cache counters can overlap input.** Likewise, inspect reasoning-output semantics before adding reasoning to output; never derive the convention from a total alone.
- **Cumulative events are snapshots, not additive requests.** File-level dedupe and semantic request dedupe solve different problems.
- **Estimated API cost ≠ subscription bill.** Public list prices value observed usage; they do not reveal subscription charges, credits consumed, taxes, discounts, or unseen remote work. [CodexBar coverage boundary][bar-codex].
- **Observed quota ≠ inferred reporting block.** Never create quota windows from local timestamps, plan names, historical maxima, or fixed report periods. Only show provider-reported windows and resets as quota; label optional forecasts as estimates and suppress them when timing is unknown. [Monitor official capture][monitor-official], [Tokitoki window handling](../src/quota-windows.ts).

[burn-cache]: https://github.com/getagentseal/codeburn/blob/de08cee8e1ac82985b33d5aab096737f90ce7ea2/src/providers/codex.ts#L918-L945
[burn-events]: https://github.com/getagentseal/codeburn/blob/de08cee8e1ac82985b33d5aab096737f90ce7ea2/src/providers/codex.ts#L1423-L1508
[burn-how]: https://github.com/getagentseal/codeburn/blob/de08cee8e1ac82985b33d5aab096737f90ce7ea2/docs/how-it-works.md
[cc-paths]: https://github.com/ccusage/ccusage/blob/e351d846191a0176520e8b3d8151dd80a60bc7e4/rust/adapters/codex/src/paths.rs#L88-L115
[cc-parser]: https://github.com/ccusage/ccusage/blob/e351d846191a0176520e8b3d8151dd80a60bc7e4/rust/adapters/codex/src/parser.rs#L479-L507
[cc-report]: https://github.com/ccusage/ccusage/blob/e351d846191a0176520e8b3d8151dd80a60bc7e4/rust/adapters/codex/src/report.rs#L123-L144
[cc-replay]: https://github.com/ccusage/ccusage/blob/e351d846191a0176520e8b3d8151dd80a60bc7e4/rust/adapters/codex/src/replay.rs#L154-L178
[bar-codex]: https://github.com/steipete/CodexBar/blob/d34fbb47afe73f81dd591bae28a60f72c39a9fe4/docs/codex.md#cost-usage-local-log-scan
[bar-prices]: https://github.com/steipete/CodexBar/blob/d34fbb47afe73f81dd591bae28a60f72c39a9fe4/docs/model-pricing.md
[bar-identity]: https://github.com/steipete/CodexBar/blob/d34fbb47afe73f81dd591bae28a60f72c39a9fe4/Sources/CodexBarCore/Vendored/CostUsage/CostUsageScanner%2BRequestIdentity.swift
[monitor-official]: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/blob/c59a83bf943f329f0e61f1a29c760353ee1860a5/src/claude_monitor/output/official.py#L39-L112
[monitor-snapshot]: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/blob/c59a83bf943f329f0e61f1a29c760353ee1860a5/src/claude_monitor/output/snapshots.py#L367-L403
[monitor-plans]: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/blob/c59a83bf943f329f0e61f1a29c760353ee1860a5/src/claude_monitor/core/plans.py#L30-L87
[monitor-prices]: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/blob/c59a83bf943f329f0e61f1a29c760353ee1860a5/src/claude_monitor/core/pricing.py#L58-L65
