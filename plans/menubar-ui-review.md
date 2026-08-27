# Menubar app UI/UX review

Fresh-eyes review of the native macOS menubar app: the status-item preview,
the 340×520 popover, its account cards, the context menu, and the handoff to
the local web dashboard. The existing dashboard review in `plans/ui-review.md`
covers the browser surface; this note focuses on the native surface and the
boundary between the two.

## Current experience

- The status item shows provider marks and quota percentages when data is
  available. Hover mode intentionally leaves the item as `tokitoki` until the
  pointer is over it.
- Clicking opens a fixed-size, scrollable popover with a search field, ordered
  cards, per-account quota bars, and a sticky footer.
- Account cards support drag ordering, a per-card refresh action, provider
  console links, collapsible provenance details, budget rows, and reset
  countdowns.
- The footer opens the browser dashboard, refreshes the payload, shares a
  screenshot/markdown summary, and opens customization.
- Right-click exposes provider consoles, dashboard actions, maintenance
  actions, provider visibility, login behavior, and quit.
- Sources and Reports are browser routes, not native popover views. Reports is
  currently the dashboard pre-filtered to the month window.

## Highest-value improvements

| Priority | Area | Finding | Suggested direction |
| --- | --- | --- | --- |
| P0 | Navigation | Sources and Reports are discoverable only through a secondary right-click Actions submenu. | Keep the context-menu shortcuts, but add a visible web-dashboard row in the popover with Reports and Sources. Make the browser handoff explicit. |
| P0 | Server lifecycle | Dashboard starts the local web server when needed; Sources and Reports open the URL directly and can show connection refused when the server is stopped. | Route all local dashboard links through one launcher that starts `tokitoki web` when necessary, waits briefly for the bind, then opens the requested route. |
| P1 | Freshness | There is no visible “last updated” time or distinction between loading, stale data, and a completed refresh. | Add a compact last-updated label near Refresh; show a short success/failure state after manual refresh. |
| P1 | Quota meaning | Scan-derived relative bars look like provider quotas until the user expands Details. | Add an inline `estimated`/`relative` marker to derived rows and reserve the traffic colors for provider-reported percentages. |
| P1 | Account identity | Email, account key, “via …”, plan badge, refresh, console, and drag controls compete in one narrow header. Long identities truncate before the user learns what was hidden. | Put the identity on its own line, move secondary controls to a trailing action group, and expose the full identity through a reliable tooltip/accessibility value. |
| P1 | Feedback | A card refresh only exposes a small spinner. Errors are logged to stderr and disappear from the user surface. | Show a transient inline status (“updated”, “couldn’t refresh”) and keep the last good values visible. |
| P1 | Density | The popover is fixed at 340×520, while multiple accounts, long emails, budgets, and stacked windows can require substantially more horizontal and vertical space. | Test a 360–380pt width and a slightly taller adaptive window; preserve the compact default but avoid truncating primary identity and status. |

## Status-item preview

### What works

- The preview is compact and uses a monochrome template image, so it follows
  the macOS light/dark menubar instead of introducing a second color system.
- Provider grouping is honest: real provider-reported percentages are shown;
  token-based estimates are marked with `~` in tokens mode.
- Hover mode labels session, weekly, and monthly values, solving the ambiguity
  of a stack of unlabeled percentages.

### Improve next

1. Inline values remain unlabeled, so `94% 43%` is only understandable after
   learning the product. Keep the compact mode, but expose a richer tooltip
   with account identity, window names, source, and “updated N min ago”.
2. Hover mode becomes visually blank at rest. Consider keeping one compact
   status signal visible (for example the worst remaining quota or a neutral
   `tokitoki` mark with a quota badge) so the mode does not look disabled.
3. A long provider/account set can make the status item consume too much
   menubar width. Define a maximum width and collapse the tail into `+N`, with
   the full list in the tooltip/popover.
4. Warning/exceeded state is carried partly by emoji/color. Pair it with a
   stable accessible title and a shape/icon treatment that remains clear in
   grayscale and for color-impaired users.
5. The preview has no freshness signal. A stale-but-plausible quota is more
   dangerous than an obvious error; make stale data explicit after a known
   threshold.
6. The hover interaction depends on global mouse movement. Verify that it
   remains reliable across multiple displays, Spaces, and reduced-motion
   settings, and that it does not cause title/image churn while the pointer
   rests over the item.

## Popover layout and hierarchy

### What works

- The sticky footer keeps Dashboard, Refresh, sharing, and customization
  available while the card list scrolls.
- Search filters accounts, harnesses, repositories, tools, and spend rows in
  one place, which is a good power-user affordance.
- The account cards put the primary value first: remaining quota, reset
  countdown, and then optional details/provenance.
- Card order and visibility are persistent, and the customization sheet is a
  reasonable home for advanced controls.

### Improve next

1. Add a visible “web dashboard” navigation row near the search field. The
   native popover is the overview; Reports and Sources are the two detailed
   follow-ups users most naturally seek.
2. Make the browser handoff unambiguous in copy and help text: “Reports — open
   monthly details in browser” and “Sources — inspect tracked files and
   machines”.
3. The fixed 340pt width forces the account header to carry too much. The
   drag handle, logo, identity, refresh, external-link, and plan badge all
   compete on one line. Give identity and actions clearer grouping.
4. There are several nested translucent surfaces: the popover material, card
   backgrounds, and inner controls. This creates double borders and weakens
   the distinction between a card and its rows, especially in dark mode.
5. Card titles mix visual registers (`ACTIVITY TODAY`, sentence-case titles,
   tiny lowercase labels). Choose one hierarchy: short sentence-case labels,
   tabular numbers, and one accent for the primary value.
6. “Details” is a small, low-contrast text disclosure at the bottom of each
   card. Increase the hit target and make the collapsed row communicate what
   it contains: “Details · source and reset dates”.
7. “Consoles” appears below cards while each card also has an external-link
   button and the context menu has console entries. Pick one primary location
   and make the other a secondary shortcut to reduce repetition.
8. Unmatched/global budget rows appear without a heading or an obvious route
   to the Budgets view. Give them a small “Other budgets” label and a link.
9. Empty states are inconsistent: some cards disappear entirely, some say
   “no usage recorded”, and errors appear as a red sentence at the top. Keep
   the popover compact, but provide one actionable empty/error treatment.
10. Hidden scroll indicators make the list look shorter than it is. Retain a
    quiet scrollbar or add a subtle fade/scroll cue at the bottom when more
    cards are below the fold.
11. Drag-and-drop ordering is powerful but not obvious. Add a one-time hint in
    Customize and avoid making the whole card feel draggable during ordinary
    inspection if accidental drags are observed.

## Account-card content and data clarity

1. A scan-derived bar is a relative comparison against the busiest same-kind
   account, not a provider limit. That distinction should be visible next to
   the bar, not only in the expanded source explanation.
2. A card refresh for a polled account runs the provider polling command and
   can refresh more than the one visible card. The label/help should describe
   the actual scope, or the command should gain a truly account-scoped path.
3. The account header can show personal/work accounts from the same provider.
   Keep the email/account key visible enough that “work” and “personal” are
   never inferred only from ordering.
4. Reset countdowns need a stable completed/unknown state. “—” is safe but
   does not explain whether the provider omitted the reset or the data is
   stale.
5. Budget values, remaining quota, token estimates, and provider percentages
   use different semantics but similar compact typography. Add small semantic
   labels or provenance styling so they are not mentally conflated.
6. “Banked resets” is valuable but currently visually secondary. If it is
   actionable or time-sensitive, surface the expiry more strongly; otherwise
   keep it as a detail row with a tooltip.

## Menus and interaction model

1. Right-click is a poor discovery mechanism for the most important routes.
   The visible popover row addresses this without removing power-user menu
   shortcuts.
2. The context menu is doing several jobs: navigation, maintenance, provider
   visibility, login, and quit. Separate “Open”, “Refresh”, “Settings”, and
   lifecycle groups with consistent verbs and fewer nested levels.
3. “Actions” currently contains both destructive-ish maintenance operations
   and navigation. Move navigation out of Actions and keep Actions for scan,
   poll, and configuration operations.
4. Maintenance actions have no in-menu or popover progress state. Disable or
   annotate the action while a scan/poll is running and report completion.
5. The footer Refresh and the per-card refresh buttons need clear scope. A
   global refresh should say “Refresh all”; a card refresh should say “Refresh
   this quota” or “Re-scan this provider”.
6. Share and Customize are icon-only. They have help text, but visible labels
   or a single “More” menu would improve first-use discoverability without
   adding much width.
7. Browser routes currently assume port 7788. If custom web ports become
   supported, the menubar needs one source of truth for the configured base
   URL rather than constructing literals in multiple actions.

## Accessibility and visual polish

1. Keep visible text alongside color for quota and budget state; add explicit
   accessibility labels for every icon-only control, including external links,
   share, customize, and card refresh.
2. Verify keyboard focus order: search → web views → cards → footer. Focus
   should remain visible on the material background, and Escape should close
   the popover without losing the search query.
3. Tiny `caption2` labels and mini controls are appropriate for density, but
   some are below comfortable reading/hit-target sizes. Prefer fewer controls
   over shrinking every control.
4. Use tabular numerals consistently for percentages, costs, counts, and reset
   countdowns so values do not visually jump during refresh.
5. Reduce competing accent colors. Provider marks can stay recognizable, but
   status colors should be reserved for warning/exceeded states and the main
   data accent should be consistent.
6. Respect reduced motion for disclosure, drag reordering, and any future
   refresh animation. The current short animations should have a no-motion
   path.
7. Test light/dark mode with the material, nested surfaces, progress tracks,
   and monochrome status item. The visual hierarchy should survive without
   relying on transparency differences alone.

## Recommended sequence

1. Ship the visible Reports/Sources row and shared on-demand web-server
   launcher (this pass).
2. Add freshness/progress feedback and make refresh scope truthful.
3. Clarify derived-vs-provider quota semantics inline.
4. Rework the account header and reduce nested surfaces at a slightly wider
   default popover size.
5. Simplify the context menu and consolidate console/navigation shortcuts.
6. Do a dedicated keyboard, VoiceOver, reduced-motion, light/dark, and
   multi-display pass.

