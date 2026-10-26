# e2e: headless UI verification harness

Give an AI agent a **visual feedback loop for the DMS widget and standalone Quickshell host** without a
desktop: build one Docker image, boot it, drive the native QML UI, and assert on
screenshots and CLI calls. Runs on Linux with Docker, no GPU or host Node install
required.

The DMS flake is pinned to **Dux Shell 2.0.0** from
`duxlabs-dev/dux-shell`; the fixture uses the 2.0 config/state paths under
`dms`. The plugin's shared widgets use `qs.DCommon.Widgets`.

## Why this shape

Quickshell has no headless/offscreen mode and the bar needs
zwlr_layer_shell_v1, so a real compositor is mandatory. We use **sway** with
wlroots' headless backend, rendered by mesa's llvmpipe, then screenshot with
grim. The image is built by Nix (dockerTools), so sway / DMS / quickshell /
fonts and the Wayland input tools come from one pinned closure instead of a
hand-written Dockerfile that has to track the whole Wayland + Qt stack. The QML
plugin is bind-mounted from the working tree.

The widget reads data by shelling out to tokitoki. The harness puts an
argument-aware stub first on PATH so the UI stays deterministic, offline, and
independent of provider stores.

## Run it

~~~
./e2e/run.sh                 # all 8 tabs and the search/session/settings flow
E2E_TAB=quotas ./e2e/run.sh  # one tab for a quick visual check
E2E_OUT_DIR=/tmp/tokitoki-e2e ./e2e/run.sh
E2E_IMAGE=tokitoki-e2e:latest ./e2e/run.sh # DMS with an already-built image
E2E_SHELL=quickshell E2E_IMAGE=tokitoki-e2e:latest ./e2e/run.sh # standalone, no DMS
E2E_SHELL=quickshell E2E_QUICKSHELL_MODE=embedded E2E_OUT_DIR=/tmp/tokitoki-embedded E2E_IMAGE=tokitoki-e2e:latest ./e2e/run.sh
E2E_SHELL=quickshell E2E_TAB=tokens E2E_IMAGE=tokitoki-e2e:latest ./e2e/run.sh
~~~

Setting `E2E_TAB` selects the one-tab mode. `E2E_MODE=all` runs the full
scenario explicitly. `E2E_PLUGIN_DIR` defaults to `/plugin-src`, the mount
point used to test working-tree QML.

The image keeps a virtual pointer alive throughout the run so Qt sees stable
seat capabilities. The pinned `wlrctl` package has a small harness-only keepalive
patch; individual clicks and scrolls still use its normal commands.

The DMS full run saves captures and logs under `e2e/out/autonomous/`; standalone Quickshell uses `e2e/out/quickshell/autonomous/` (both gitignored). Each run has an isolated container home and headless desktop. Set `E2E_IMAGE` to reuse a loaded Docker image without invoking Nix; omitting it preserves the pinned Nix build/load path.

Standalone runs mount the complete `integrations/` tree so the host can import the shared QML UI. They invoke `qs -p /integrations-src/quickshell/tokitoki` directly, never start DMS, and assert that no DMS configuration exists.

`E2E_QUICKSHELL_MODE=embedded` runs the same interactions against a separate
host shell with an incompatible `qs.Common.Theme`. It prepares the portable
component tree using the package's build script and symlinks it into the host
configuration, as Home Manager does. Use a separate absolute `E2E_OUT_DIR` to
keep its artifacts alongside the standalone run.

Artifacts:

| file | content |
| --- | --- |
| `bar.png` | top strip with the widget's status |
| `tab-<tab>.png` | full frame after selecting each tab in the UI |
| `quotas-lower.png` | expired/unknown provider quota examples; local budgets stay in Reports → Budget status |
| `tokens-lower.png` / `tokens-models.png` | Tokens after scrolling through Pulse, provider, and model cards |
| `reports-lower.png` | Reports after scrolling to repository and activity cards |
| `sessions-search.png` | session list after entering the fixture search term |
| `sessions-detail.png` / `sessions-back.png` | detail view and return to the list |
| `sessions-pagination.png` / `sessions-page-2.png` / `sessions-page-1-return.png` | next and previous page flow |
| `settings-tab.png` / `settings-config.png` | Settings tab and its settings menu |
| `settings-notifications.png` | lower notification settings after enabling notifications |
| `index.json` / `interactions.jsonl` / `cli-invocations.jsonl` | shell, observed tabs, completed interactions, and fixture CLI arguments |
| `state-interactions.jsonl` / `quickshell-ipc.jsonl` | tab readback and native host IPC evidence |
| `config-*-restart.json` / `state-*-restart.json` / `status-after-restart.json` / `restart.json` | standalone config/state persistence across distinct processes |
| `widget-config-before.png` / `after-restart.png` | standalone widget settings and restored Tokens view |
| `short-screen.png` / `status-short-screen.json` | popup transferred by pointer to a second, 960×540 logical output, with bounds checked |
| `dms.log` / `dms.out` / `quickshell.log` / `quickshell-before-restart.log` / `sway.log` | runtime logs, including QML error checks |
| `previews/*.png` | native captures of the bar/popover region for sharing in chat |

Tabs: overview, quotas, tokens, reports, sessions, sources, mcp, settings.

Standalone runs also create a second short output, click its bar to transfer an open popup, check that its fixed footer remains within the output, and exercise same-bar toggle, Escape and outside-click dismissal.

## How it works

`container/entrypoint.sh`:

1. seeds `~/.config/dms` with a bar holding the tokitoki widget;
2. starts headless sway and DMS on a fixed 1600x1000 output;
3. opens the widget and uses a wlroots virtual pointer plus a Wayland virtual
   keyboard to select all tabs, search, paginate, open and close a session, and
   change a notification setting;
4. saves screenshots and logs, then fails on detected QML runtime errors.

The plugin under test is the working-tree `integrations/dms/tokitoki`,
bind-mounted into the image. The initial tab comes from the plugin state
file; the full run then selects each tab through the visible UI and checks the
saved tab state after each click. Standalone runs read the selected tab through the public `tokitoki status` IPC method. They also exercise `open`, `close`, and `toggle`, change `autoRefreshEnabled` through the visible widget settings, check the JSON write, restart Quickshell, and verify that the host loads both the setting and selected tab. Config lives at `$XDG_CONFIG_HOME/tokitoki/quickshell.json`; state lives at `$XDG_STATE_HOME/tokitoki/quickshell-state.json`. Fatal standalone QML errors fail immediately with a diagnostic capture.

## Fixtures

`payload.json` and the first sessions page retain the real CLI JSON shape.
`anonymize.py` removes email addresses, repository names, session IDs, titles,
snippets, and conversation bodies. The session case builder replaces the first
row's text with a safe search term and writes deterministic page-two and detail
responses. Regenerate after a payload schema change:

~~~
tokitoki widget-payload --cached --json > /tmp/payload.raw
tokitoki sessions --cached --last month --top 25 --json > /tmp/sessions.raw
python3 e2e/fixtures/anonymize.py /tmp/payload.raw e2e/fixtures/payload.json
python3 e2e/fixtures/anonymize.py /tmp/sessions.raw e2e/fixtures/sessions.json
node e2e/fixtures/prepare-sessions.mjs
~~~

The shim handles `--search`, `--page`, `--session`, `--provider`, and event
limit/offset flags used by the QML component. It returns a distinct detail object
for `--session`, and page two and detail responses follow the CLI JSON contract.
At runtime, date fields in payload and session responses shift together so the
history and monthly cards stay aligned with the run date.

## Known ceilings

- Screenshot checks verify dimensions and visible ink; there is no golden-image
  comparison or OCR.
- Input coordinates assume the fixed output size and current widget layout.
  The run also checks saved tab state and the CLI calls caused by interactions.

## Native Noctalia 5 and KDE Plasma 6

These adapters have a separate fixture-backed host UI scenario. It uses the
real Noctalia C++/Luau runtime and KDE's `plasmoidviewer` under headless Sway,
with isolated HOME/XDG directories. The CLI and HTTP responses are synthetic;
this validates host compatibility and UI behavior, not provider authentication.
The complete adapter directories are loaded, including modules, configuration,
translations and icons. Production adapters contain no test hooks.

Prerequisites: Nix, Docker, and the `tokitoki-e2e:latest` image built by the
main harness. Noctalia is pinned to revision
`42c5d09a10f5642fd30fbdb0ded503c0098e6f22` (5.3.0); the Plasma SDK and desktop
containment use `e2e/flake.lock` (6.7.5 when validated).

```sh
./e2e/native/run.sh
# Output defaults to /tmp/tokitoki-native-e2e; override E2E_OUT_DIR at startup.
```

`run.sh` removes its container on exit. For an interactive debugging session,
use `start.sh`, then `docker exec tokitoki-native-e2e sh /repo/e2e/native/scenario.sh`,
and finally `docker rm -f tokitoki-native-e2e`.

The scenario checks shortest window **per selected account**, multiple profiles,
all-window tooltips, local account selection, expired/unknown quota states,
amount precedence, backend failure and recovery, and native runtime errors.
Budgets and T3 Code activity are exercised in the detail view. It writes
`result.json`, native runtime logs, state probes and PNG screenshots. Plasma
`*-widget.png` captures crop the actual compositor output using the live
plasmoid's measured bounds; full output captures are retained too.

The test shim is only available inside this disposable container. It reads no
personal accounts, changes no live desktop configuration, and sends no desktop
notifications. To repeat, remove the previous test container and use a fresh
output directory so stale probes cannot satisfy readiness checks.
