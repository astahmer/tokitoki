# Electrobun panel, DMS parity

Status: home opens on activity today, the week distribution, and harness rows, then the account cards.
Local usage reads as dollars, tokens, and requests. Empty cards stay hidden.
Quota percents stay absent while the cached windows are not current.

Shell-only DMS pieces are adapted: the bar summary becomes the tray title, and the
shell theme stays the menubar palette. Login stays in each harness.

## Cards that were already drawn

- [x] Home, Quotas, Tokens, Reports, Sessions, Sources, MCP, Settings
- [x] Week and today donuts, top tools, quota rows with status and local spend
- [x] Token pulse, harness donut, models, activity grid
- [x] Tray icon, popup anchored bottom-right, close, refresh and scan

## Cards to draw from payload fields the panel ignored

- [x] History chart, last 28 days and last year
- [x] Repository activity chart, plus the month list past the first six rows
- [x] Token composition for the selected period
- [x] Tracking quality
- [x] Upstream provider breakdown
- [x] T3 Code activity
- [x] Billing blocks
- [x] Statusline preview
- [x] Service alerts, including the empty state
- [x] Other machines, including the empty state
- [x] Spend pace with month-to-date, daily rate, and projection
- [x] Session rows with model, repo, cache share, and the full page of 50
- [x] Quota pace line when a window carries one

## Interactions

- [x] Search across accounts, sessions, repos, and tools
- [x] Cost / token metric on the distribution cards
- [x] Collapse an account
- [x] Hide a card and reorder cards
- [x] Tray title summarizes the week
- [x] Copy a markdown summary
- [x] Open the local dashboard
- [x] Auto refresh on the configured poll interval
- [x] Settings lists poll, notifications, privacy, and preview

## Explicitly adapted or left out

- [x] DMS menu-bar strip: the tray title carries the week total
- [x] Follow the shell theme: the popup keeps the menubar palette
- [x] Per-account sign-in opens the provider page; the harness still completes login
- [x] Settings toggles write notifications, privacy, and quota polling
- [x] Per-account quota refresh runs `tokitoki poll --provider`
