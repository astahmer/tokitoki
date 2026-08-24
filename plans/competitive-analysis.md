# Competitive analysis: tokitoki vs the field (2026-08)

Researched from GitHub stars (mine + popular), READMEs read 2026-08-25.
Purpose: find what we don't have and what's worth building. Feeds the
roadmap ordering in the other plans/*.md.

## The field

| Tool | What it is | Scale |
|---|---|---|
| **tokitoki** | local-first multi-harness usage analytics (CLI + web + menubar + sync) | personal |
| **ccusage** | `npx` reports over coding-agent local data; stateless-ish | 18.1k⭐ |
| **CodexBar** | macOS menubar app for *provider limits* (69 providers, live OAuth/API polling) + CLI | 20.5k⭐ |
| **claude-monitor** (`claude-monitor` PyPI) | Python live terminal monitor for Claude Code w/ forecasting | ~3k⭐ |
| **openusage** | subscription/usage tracking, broader than agents | 3.9k⭐ |
| **openmeter / flexprice / Lineman.io** | metering & team-spend platforms (paid/self-host B2B) | 2.2–4.4k⭐ |

## Feature matrix

Legend: ✅ yes · 🟨 partial/beta · ❌ no · ❓ unverified

| Feature | tokitopi→tokitoki | ccusage | CodexBar | claude-monitor |
|---|---|---|---|---|
| Harnesses ingested locally | ✅ 12+ (incl. pi, cursor, aider, amp, zed, t3code…) | ✅ 16 sources | ❌ (reads live APIs instead) | ❌ Claude only |
| Incremental scan w/ cursors (no full re-read) | ✅ | ❓ recomputes per run | n/a | ❓ |
| Persistent fast cache (SQLite) | ✅ | 🟨 optional cache | ✅ own store | 🟨 opt-in warehouse |
| Cost estimation | ✅ | ✅ + offline pricing + user overrides | ✅ cost scans | ✅ |
| **Provider quota/limit windows** (resets, credits) | 🟨 codex rate_limits embedded | ❌ | ✅ core feature, 69 providers | ✅ Claude plans |
| Budgets caps + push alerts (ntfy) | ✅ | ❌ | 🟨 threshold badges | 🟨 warnings |
| Menubar app macOS | ✅ native SwiftUI | ❌ | ✅ flagship | ❌ |
| **Linux menubar** | 🡒 planned (electrobun) | ❌ | ❌ app is macOS-only (CLI tarballs exist) | ❌ |
| Web dashboard (local) | ✅ | ❌ | ❌ | ❌ |
| Charts / calendar heatmap / pie | ✅ | 🟨 tables only | 🟨 bars in popover | 🟨 rich TUI sparkline |
| Sessions drill-down (per-request) | ✅ | ✅ session report | ❌ | ❌ |
| Tool-level spend attribution (mcp: rollup) | ✅ unique | ❌ | ❌ | ❌ |
| Repo efficiency ranking | ✅ unique | ❌ | ❌ | ❌ |
| Anomaly detection vs baseline | ✅ unique | ❌ | ❌ | 🟨 forecasting |
| Multi-machine sync (dir/git/atproto) | ✅ unique | ❌ | ❌ | ❌ |
| Public share page (sanitized, atproto) | ✅ | ❌ | ❌ | ❌ |
| Console CSV import (backfill) | ✅ | ❌ | ❌ | ❌ |
| Full-text session search | ✅ | ❌ | ❌ | ❌ |
| **MCP server for agents** | 🡒 planned | ❌ | ❌ | ❌ |
| Statusline integration | ❌ | 🟨 beta | ❌ | ✅ |
| Claude 5-hour billing-blocks view | ❌ (rolling windows only) | ✅ | ✅ resets countdown | ✅ |
| Install friction | clone+bun / compiled dist | `npx ccusage` zero-install | brew cask / AUR | pipx/uvx |

## Gaps worth closing (ranked)

1. **MCP server** (plans/mcp-server.md) — nobody in the field has an
   agent-facing API. Unique, cheap, compounds with everything else.
2. **Linux menubar** (plans/linux-menubar.md) — CodexBar proved demand
   (20.5k⭐) but abandoned Linux for the GUI; the field is empty there.
3. **Provider limit windows beyond codex** — our quota snapshots are the right
   architecture (embedded in events, not separate API polling); extend
   extraction to claude/gemini/grok/cursor plan limits so the menubar gets
   reset-countdown parity without CodexBar's OAuth machinery.
4. **5-hour billing-blocks report** — ccusage's most-referenced feature;
   we already store per-event ts so it's a windowing change, plus an
   "active block" gauge for menubar/web.
5. **Statusline integration** — tiny (emit one line from menubar-payload);
   free distribution inside every Claude Code session.
6. **Zero-install story** — `npx tokitoki`-style runner or brew tap; our
   compile step already produces a single binary, just needs packaging +
   a tap formula (nix package exists).
7. Not now / watch: team-multi-seat spend (Lineman/flexprice lane) — needs
   auth + hosting; revisit if share/atproto sync gets traction.

## Honest weaknesses vs field

- Install friction (no npm one-liner, no brew formula yet).
- No live/watch mode (claude-monitor's whole appeal); a `tokitoki watch`
  re-rendering the report every N s would cover 80% for 20 lines of code.
- Source count optics: ccusage lists 16 named harnesses; several of ours are
  skeleton providers. Finishing 3–4 real ones (copilot CLI, kimi, qwen,
  droid-class) beats marketing count parity later.
