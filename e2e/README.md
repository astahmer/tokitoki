# e2e: headless screenshot harness

Give an AI agent a **visual feedback loop for the DMS widget** without a
desktop: build one Docker image, boot it, get PNGs, assert on them. Runs on any
machine that has Docker, Linux, no GPU required.

## Why this shape

Quickshell has no headless/offscreen mode and the bar needs
zwlr_layer_shell_v1, so a real compositor is mandatory. We use **sway** with
wlroots' headless backend, rendered by mesa's llvmpipe, then screenshot with
grim. The image is built by Nix (dockerTools), so sway / DMS / quickshell /
fonts / the plugin all come from one pinned closure instead of a hand-written
Dockerfile that has to track the whole Wayland + Qt stack.

The widget reads its data by shelling out to tokitoki, so the harness puts a
stub named tokitoki first on PATH that replies from committed fixtures in
fixtures/. Deterministic, offline, instant, and no provider stores needed.

## Use it

~~~
./e2e/run.sh                 # overview tab -> e2e/out/popout-overview.png
E2E_TAB=quotas ./e2e/run.sh  # quotas tab   -> e2e/out/popout-quotas.png

node e2e/assert.mjs e2e/out/bar.png
node e2e/assert.mjs e2e/out/popout-overview.png --region "0,44 1600x956"
~~~

Env knobs: `E2E_TAB` (any of the 8 tabs), `E2E_PLUGIN_DIR` (default
`/plugin-src`, the mount point run.sh uses to test uncommitted QML).

Captures per run, into ./out (gitignored):

| file | content |
| --- | --- |
| bar.png | the 1600x44 top strip: bar display mode (logo, %, tokens, $) |
| popout-<tab>.png | full frame with the widget popout opened on that tab |
| index.txt | the tab that was rendered, and the file listing |

Tabs: overview, quotas, tokens, reports, sessions, sources, mcp, settings.

## How it works

container/entrypoint.sh does the boot sequence:

1. seed ~/.config/DankMaterialShell (bar holding only the tokitoki widget) and
   symlink the built plugin into plugins/tokitoki;
2. sway headless on llvmpipe, fixed 1600x1000 output;
3. dms run, wait for dms ipc to answer;
4. grim the bar strip, toggle the widget popout over IPC, grim the frame.

The plugin under test is the working-tree integrations/dms/tokitoki, bind-mounted
over the image copy, so the harness validates uncommitted QML too. Without the
mount it falls back to the built package's own copy.

Tabs other than overview/quotas/tokens are opened by writing
~/.local/state/DankMaterialShell/plugins/tokitoki_state.json before `dms run`,
which is why any of the 8 tabs is reachable in one boot.

## Fixtures

fixtures/payload.json and fixtures/sessions.json are real CLI output with emails
and private repo names rewritten. Regenerate after a payload schema change:

~~~
tokitoki widget-payload --cached --json > /tmp/payload.raw
tokitoki sessions --cached --last month --top 25 --json > /tmp/sessions.raw
python3 e2e/fixtures/anonymize.py /tmp/payload.raw e2e/fixtures/payload.json
python3 e2e/fixtures/anonymize.py /tmp/sessions.raw e2e/fixtures/sessions.json
~~~

## Known ceilings

- The shim ignores sub-command flags, so --search and drill-down always return
  the same fixture. Make it arg-aware if a test must assert filtered results.
- One tab per boot. A full sweep is a loop over E2E_TAB (four containers in
  parallel is fine).
- No golden-image diffing yet; assert.mjs only proves a capture is real (right
  size, non-blank ink). Add pixel-diff + masks when the layout stabilises.
- Timing is wall-clock sleeps. If CI gets flaky, wait on dms ipc widget status
  instead of sleeping.
