# e2e: headless UI verification harness

Give an AI agent a **visual feedback loop for the DMS widget** without a
desktop: build one Docker image, boot it, drive the native QML UI, and assert on
screenshots and CLI calls. Runs on Linux with Docker, no GPU or host Node install
required.

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
E2E_IMAGE=tokitoki-e2e:latest ./e2e/run.sh # reuse an already-built image
~~~

Setting `E2E_TAB` selects the one-tab mode. `E2E_MODE=all` runs the full
scenario explicitly. `E2E_PLUGIN_DIR` defaults to `/plugin-src`, the mount
point used to test working-tree QML.

The image keeps a virtual pointer alive throughout the run so Qt sees stable
seat capabilities. The pinned `wlrctl` package has a small harness-only keepalive
patch; individual clicks and scrolls still use its normal commands.

The full run saves captures and logs under `e2e/out/autonomous/` (gitignored):

| file | content |
| --- | --- |
| `bar.png` | top strip with the widget's status |
| `tab-<tab>.png` | full frame after selecting each tab in the UI |
| `tokens-lower.png` | Tokens after scrolling to Pulse, provider, and model cards |
| `reports-lower.png` | Reports after scrolling to repository and activity cards |
| `sessions-search.png` | session list after entering the fixture search term |
| `sessions-detail.png` / `sessions-back.png` | detail view and return to the list |
| `sessions-pagination.png` / `sessions-page-2.png` / `sessions-page-1-return.png` | next and previous page flow |
| `settings-tab.png` / `settings-config.png` | Settings tab and its settings menu |
| `settings-notifications.png` | lower notification settings after enabling notifications |
| `index.json` / `cli-invocations.jsonl` | visited tabs, interactions, and fixture CLI arguments |
| `dms.log` / `dms.out` / `sway.log` | runtime logs, including QML error checks |
| `previews/*.png` | native captures of the bar/popover region for sharing in chat |

Tabs: overview, quotas, tokens, reports, sessions, sources, mcp, settings.

## How it works

`container/entrypoint.sh`:

1. seeds `~/.config/DankMaterialShell` with a bar holding the tokitoki widget;
2. starts headless sway and DMS on a fixed 1600x1000 output;
3. opens the widget and uses a wlroots virtual pointer plus a Wayland virtual
   keyboard to select all tabs, search, paginate, open and close a session, and
   change a notification setting;
4. saves screenshots and logs, then fails on detected QML runtime errors.

The plugin under test is the working-tree `integrations/dms/tokitoki`,
bind-mounted into the image. The initial tab comes from the plugin state
file; the full run then selects each tab through the visible UI and checks the
saved tab state after each click.

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
