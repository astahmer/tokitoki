# Plan: Linux menubar app (Electrobun)

Status: planned, not started. macOS app stays native Swift (menubar/).

## Decision

Electrobun, same call as the parked secretbar-linux evaluation (notes:
`~/dev/nixfiles/docs/secretbar-linux.md`). Rationale:

- **TS core reuse**: Electrobun apps are Bun/TS — the app imports tokitoki's
  real modules (`src/cache.ts`, `src/budget-status.ts`, `src/limits.ts`)
  directly instead of shelling out. The `tokitoki widget-payload --json`
  contract (already shipped for the Swift app) works as a fallback path and
  as the integration-test fixture.
- **Same toolchain as shiftshift** (hutch ↔ electrobun pinned in the nixfiles
  flake) — no new build system to learn.
- Rejected again by prior decision: GTK/Rust (user veto: too obscure),
  Electron (heavier fallback only if Electrobun's Linux target blocks).

## Known risks & mitigations

| Risk | Mitigation |
|---|---|
| No Linux machine for daily testing | CI xvfb smoke job (screenshot + tray-present assertion) + NixOS VM (UTM) for UX passes; same strategy secretbar landed on |
| Tray API fragmentation (GNOME AppIndicator vs KDE StatusNotifierItem; Wayland quirks) | Thin shell layer only; all logic in headless TS core with vitest coverage; shell swaps per desktop if needed |
| Electrobun Linux target immaturity | Timeboxed spike first (see below); Electron fallback pre-approved |
| Feature parity drift with Swift app | Both apps consume the same `widget-payload --json`; add a schema/version field so payload evolution is explicit |

## Scope (parity subset of the Swift app)

1. Status/tray icon: burn rate or busiest-account usage bar
2. Popover/window: limit cards (hero), donut, preview lines — mirror the
   v3 Swift overhaul layout
3. Poll `widget-payload` on the 5-min timer; budget banners → notifications
4. `menubar-state.json` dedupe semantics identical to Swift app
5. NOT in scope: provider status polling / incident badges (CodexBar
   territory, see competitive-analysis.md)

## Milestones

- [ ] **Spike (timebox ~1 day)**: electrobun linux target, tray icon visible
      under X11 xvfb + real GNOME under Wayland; produce screenshot in CI.
      Kill/pivot decision point.
- [ ] **Core**: TS view-model module fed by the widget-payload shape; vitest.
- [ ] **Shell**: tray + popover rendering the view-model.
- [ ] **Packaging**: nix package in nixfiles (same pattern as tokitoki CLI);
      `.desktop` autostart note in docs.
- [ ] **CI**: xvfb smoke job on every push to the app dir.

## Open questions

- Wayland layer-shell popovers vs plain always-on-top window? Spike decides.
- Single instance enforcement: DBus name claim vs lockfile.
