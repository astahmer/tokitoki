# Web dashboard UI/UX review (2026-08-25)

Fresh-eyes product pass over every view (sessions, dashboard, tools,
anomalies, budgets, sources), benchmarked against openusage.ai's design
language: clean cards, one obvious period switcher per concern, prominent
quota bars with human reset countdowns, minimal color noise. Verified live at
1280×900 and 800×900 via playwright screenshots.

## (a) Quick wins

1. **dashboard · SummaryCards** — card labels hardcode windows that don't
   match the data ("WEEK COST" shown while the filter bar selects "day";
   `/api/summary` takes no window params at all). Either wire summary to the
   selected range (server: accept last/from/to) or relabel dynamically from
   `summary.window.label`.
2. **tools** — treemap tooltip/value renders the number twice:
   `$${i.value.toFixed(2)} · ${Math.round(i.value * 100) / 100}` → "$12.34 ·
   12.34". Show `$12.34 · 34% of provider`.
3. **anomalies / grid** — metric pills are hand-rolled `<button>`s with
   ad-hoc classes (`bg-kumo-info text-white`) while everywhere else uses the
   Kumo `Pill`. One pill style everywhere (also fixes hover/focus states).
4. **budgets** — alert lines are raw `⚠` divs; Kumo `Banner` (variant
   warning/danger) exists and matches the design system.
5. **all views** — export buttons (`↓json ↓md ↓csv`) sit inside the session
   filter row with no hint of scope. Add a title tooltip: "exports current
   window × dimension × filters".
6. **theme toggle** — sun/moon only. Offer `system` (3-state cycle); respects
   OS preference for first-time users.
7. **donut legend** — slices capped at 7 with no "other" bucket; merge tail
   into an "other" slice so share sums to 100%.

## (b) Layout / structure

8. **global** — app state lives in localStorage + component state; only
   `?spend=` is URL-backed (as of this change). Range/dimension/account/view
   should be URL search params too: deep links ("send me this exact view"),
   working back-button, and reproducible bug reports all depend on it.
   Suggest migrating the App shell to TanStack Router with validateSearch
   (router already in deps but unused).
9. **dashboard** — three separate period controls now coexist visually:
   filter-bar PERIOD presets, spend-distribution segments, activity-grid
   metrics. They're semantically distinct but read as competing "the"
   controls. Give each panel its control inline with its heading (grid
   already does this; spend now does too) and visually de-emphasize the
   global PERIOD row into the filter bar.
10. **dashboard** — information order buries the hero: summary cards (cost,
    burn, projection) render above the fold, but evolution/spend charts sit
    below a tall account-pills panel. openusage leads with spend + quota
    bars; consider: summary cards → spend distribution + evolution side by
    side → usage table → accounts → activity.
11. **sessions** — SessionsView is the landing tab yet the FilterBar above it
    exposes "BY model/provider/..." which does nothing for sessions (it feeds
    the dashboard table). Hide dimension/export controls while sessions is
    active, or make them relevant (dimension → grouping of results).
12. **dashboard** — account pills row renders between filters and table and
    can wrap to many rows (12+ providers × accounts); collapse behind a
    "accounts ▾" dropdown past ~6 entries, keep "all" + active visible.
13. **narrow width (800px)** — filter rows stack acceptably, but the usage
    table's 10 columns force heavy horizontal scroll; hide low-value columns
    (sess, avg/req) under a progressive-disclosure breakpoint.
14. **grid/activity** — always renders trailing 365d regardless of the
    selected range; either respect the range or label it explicitly
    "last 365 days" next to the metric pills (currently unlabeled surprise).

## (c) Information density / hierarchy

15. **UsageTable** — 10 numeric columns of equal weight. Bold the two that
    matter (cost, %cache or req) via font-weight/color; demote input/output/
    cacheRead raw token counts to a hover expansion or a single compact
    "tokens" column with breakdown tooltip.
16. **SummaryCards** — seven equal cards flatten priority. openusage puts
    money first, big. Promote cost + burn/day to larger cards; demote
    requests/sessions/%cache to secondary row or inline stats.
17. **TimeseriesChart** — hardcoded top-5 series with no way to see #6+
    except changing dimension; add clickable legend to toggle series, and a
    tokens/cost metric switcher (data already supports it server-side).
18. **SessionsView rows** — model(s) column duplicates provider info for
    single-model sessions; collapse to model only when provider is redundant.
19. **sources** — flat text table; `tracked/upToDate` would read far better
    as a tiny meter per provider (green fill = up-to-date fraction) matching
    the budget gauge language.
20. **empty states** — several panels render bare sentences; standardize on
    EmptyState with a next-action ("run tokitoki scan", "widen range") as a
    clickable action where possible.

## (d) Interaction gaps

21. **global** — no loading feedback on slow first paint beyond skeletons;
    stale-while-revalidate dims content but there's no refresh affordance
    (manual refresh button / auto-refresh toggle like the menubar's 5-min
    poll).
22. **sessions** — search query isn't URL-persisted (?q=), so searched views
    can't be shared; pagination state lost on tab switch.
23. **anomalies** — anomaly days aren't clickable into the sessions view for
    that day; that's the natural follow-up action.
24. **usage table** — sorting resets when filters change (sort state survives
    but re-sorts against new data — fine — though column-header hit targets
    are small; pad them).
25. **keyboard** — no "/" shortcut to jump to sessions search; cheap win for
    a keyboard-first audience.
26. **spend distribution** — periods mix semantics (calendar today/yesterday
    vs rolling week/month). Window label text mitigates; consider calendar
    week (Mon–Sun) + MTD to fully match openusage mental model, or label
    buttons "24h/7d/30d" instead.

## (e) Visual polish

27. **status/header** — "⏱ tokitoki" wordmark + tracking-widest reads dated;
    a small logo mark + tighter lockup would modernize (openusage uses a
    clean glyph + name).
28. **cards** — Panel backgrounds (.quaternary 28%) + nested Surfaces create
    visible double-borders in dark mode (account pills panel inside page);
    unify elevation levels.
29. **typography** — monospace numerals appear inconsistently (table yes,
    summary cards no); use tabular figures everywhere numbers update.
30. **color noise** — donut palette (7 hues) + gauge reds/greens + delta
    badges compete; adopt openusage restraint: one accent hue for data,
    semantic colors only for thresholds.
31. **delta badges** — ▲ red = cost increase is honest but reads alarming;
    consider neutral arrows with color only past a threshold (±10%).
32. **motion** — pill/donut transitions pop instantly; 150ms ease on
    segment switches + donut arc transitions would match modern feel.

## Shipped in the 2026-08-25 second pass

- **Sessions search perf** (critical): updateSessionIndex throttled to one run
  per 120s (meta-keyed; force via `tokitoki reindex` / explicit opts) + files
  >64MB skipped and counted → search 55s → 0.04–0.10s warm, ~1.8s cold-bounded
- Sortable tables: shared useSort hook; sessions default most-recent-first;
  UsageTable header hit-targets padded (also covers item 24)
- Header single-row lockup (item 27); "/" focuses session search (item 25)
- Filters collapsed behind a "filters ▾" toggle; provider/account pickers are
  now searchable multi-select comboboxes; dimension+export hidden on sessions
  (items 11, 12); account pills collapse past 6 with window label inline
- Search-all-conversations slimmed to a one-line input with ⌕ affordance +
  Escape-to-clear; skeleton rows for sessions/search loading states
- Table polish: hairline row separators, hover tint, tabular-nums, cost column
  emphasized (items 7, 15-partial, 29-partial)
- Note: reui.io's registry components are license-gated (401 without key) —
  the filter bar is a hand-rolled equivalent on Kumo primitives instead.

## Fixed during this review (Task A)

- Spend distribution panel: new Today/Yesterday/Week/Month segmented control
  (independent of global range), cost-sized donut slices, URL persistence via
  `?spend=`, verified across all four periods via DOM assertions +
  screenshots (/tmp/ui-card-{period}.png).
- DonutShare gained a `metric` prop (tokens|cost) with stable color domain;
  legacy tokens behavior unchanged.
