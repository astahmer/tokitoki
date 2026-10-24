# Noctalia v5 adapter sync research

Research snapshot: 2026-10-24. Context7 MCP was not available in this session, so the findings below use Noctalia’s official documentation and pinned upstream source, plus upstream Sway/wlroots/Mesa references. The host recipe was researched, not built or run; no desktop install or credentials were used.

## Actionable findings

- The latest stable host is [Noctalia v5.3.0](https://github.com/noctalia-dev/noctalia/releases/tag/v5.3.0), commit [`a33122c4208a385e19c9a252e65e2751b2c44fbb`](https://github.com/noctalia-dev/noctalia/commit/a33122c4208a385e19c9a252e65e2751b2c44fbb). Its shipped plugin API ends at 34; the live API table labels 35–42 unreleased. Pin v5.3.0 for host E2E and do not depend on APIs above 34.
- The request described API 3 and the old imperative text/tooltip widget. The dirty checkout currently reads `plugin_api = 32`, with a `display_mode` select, a bar widget, a `details` panel, module files, and a state channel. I left this in-progress code untouched.
- A concrete incompatibility is present in the inspected `widget.luau`: `noctalia.runAsync({ command = ..., args = ... }, callback)` is not a Noctalia v5.3 call form. The pinned host accepts a command string or a positional argv array. The object table has no positional argv, so `processArgsFromLua` rejects it. Use `local executable = noctalia.getConfig("executable")` followed by `noctalia.runAsync({ executable, "widget-payload", "--cached", "--json" }, callback)`; API 24 introduced this shell-free argv form. [Runtime API](https://docs.noctalia.dev/noctalia/plugins/development/runtime-api/) · [v5.3.0 implementation](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/src/scripting/luau_host.cpp#L266-L292)
- The requested modes fit Noctalia’s typed plugin settings: a shared `[[setting]]` `select` can offer `shortest`, `quotas`, `total`, and `icon`; use a root plugin setting when both widget and panel consume it. `barWidget.setTooltip` supports structured text key/value rows. A `[[panel]]` with a fixed size and a declarative `ui.scroll` tree can show quota, local budget pace, and activity sections. [Manifest and settings](https://docs.noctalia.dev/noctalia/plugins/development/manifest/) · [Entry scripts and tooltips](https://docs.noctalia.dev/noctalia/plugins/development/entries/) · [Declarative UI](https://docs.noctalia.dev/noctalia/plugins/development/declarative-ui/)
- For real host screenshots without touching the user profile, build the pinned Noctalia flake into a temporary output link, set temporary `HOME`/XDG/Noctalia paths, and launch it as a Sway `exec` under wlroots’ headless backend. Use GLES2 plus software-renderer flags and Mesa software rendering; a Sway pixman-only run does not exercise Noctalia’s own EGL/GLES renderer. [Noctalia flake](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/flake.nix) · [wlroots environment variables](https://raw.githubusercontent.com/swaywm/wlroots/master/docs/env_vars.md) · [Mesa software rendering](https://docs.mesa3d.org/envvars.html)
- `noctalia msg plugin …` dispatches `onIpc(event, payload)`, not the widget’s physical `onClick()`. For clicks, inject pointer input through Sway (or a virtual-pointer client); for a deterministic panel screenshot, `noctalia msg panel-toggle tokitoki/usage:details` is sufficient. [Plugin IPC](https://docs.noctalia.dev/noctalia/ipc/plugins/) · [Sway input commands](https://raw.githubusercontent.com/swaywm/sway/master/sway/sway-input.5.scd)

## API and adapter mapping

The v5 [Plugin API Versions](https://docs.noctalia.dev/noctalia/plugins/development/plugin-api/) page says API levels are cumulative and a manifest’s `plugin_api` is its minimum required level. It lists API 32 container `tooltip` props as v5.2.0, APIs 33–34 as v5.3.0, and 35+ as unreleased. The pinned [v5.3.0 API table](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/docs/plugin-api.json) and [`plugin_api.h`](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/src/scripting/plugin_api.h) agree that the shipped ceiling is 34.

The adapter appears to intend these non-baseline features: `require("./lib/model.luau")` (API 22), direct argv `runAsync` (API 24), and closure callbacks in the panel/state watcher (API 9). API 32 is safe on v5.3.0 and is needed if the UI uses `tooltip` on `ui.box`, `ui.row`, `ui.column`, or `ui.image`; the current files use `barWidget.setTooltip` instead. If lowering the declared level for older Noctalia, verify all props actually used first. [Version table](https://docs.noctalia.dev/noctalia/plugins/development/plugin-api/) · [entry modules](https://docs.noctalia.dev/noctalia/plugins/development/entries/) · [runtime subprocess API](https://docs.noctalia.dev/noctalia/plugins/development/runtime-api/)

`runAsync` returns a boolean for whether the process started; the callback receives a result table including `exitCode`, `stdout`, `stderr`, and timeout/truncation flags. A string executes through `/bin/sh -c`; an argv array runs directly. `noctalia.json.decode` returns the parsed value, or `nil, error` for invalid JSON. This makes a direct argv array the safest way to pass the configurable executable and fixed CLI arguments.

### Settings, widget hover, and panel

Noctalia exposes three setting scopes: root `[[setting]]` is shared across plugin entries, `[[widget.setting]]` is specific to one bar widget, and `[[panel.setting]]` is panel-specific. `noctalia.getConfig(key)` reads declared settings; unknown keys warn and return `nil`. `select` options require `{ value, label_key }`, and all setting labels are translation keys resolved from `translations/<lang>.json`. The current root `display_mode` select is the right scope for one choice shared by the bar and details panel. Its mode semantics (`shortest` choosing a shortest-reset quota, `quotas` displaying every quota, `total` displaying totals, `icon` displaying only the glyph) are Tokitoki adapter behavior; Noctalia only stores the selected value. [Settings schema](https://docs.noctalia.dev/noctalia/plugins/development/manifest/#settings-schema)

`barWidget.setTooltip` accepts plain text, one key/value row, or an array of `{ key, value }` rows (also positional rows). It is a structured text tooltip, not a nested declarative surface; put one quota/window per row for scanability. `barWidget.render(uiTree)` replaces the built-in glyph/text row, and after it is used `barWidget.setText` no longer changes visible content. `setTooltip` still works alongside `render`. UI-node `tooltip` strings on box/row/column/image require API 32. [Tooltip and bar-widget methods](https://docs.noctalia.dev/noctalia/plugins/development/entries/#barwidget---widget-presentation) · [bar widget rendering](https://docs.noctalia.dev/noctalia/plugins/development/declarative-ui/#barwidgetrender---declarative-bar-widget-ui)

The manifest’s `[[panel]]` entry provides a fixed `width` and `height`; scripts render a `ui.*` tree through `panel.render`, normally from `onOpen` and again after async data/state updates. A scrollable column can group Quota, Local budget/pace, and Activity cards. The full entry id for this adapter is `tokitoki/usage:details`; `noctalia.togglePanel(id)` or the `panel-toggle` IPC opens/closes it. The current `height = 720` is compatible with v5.3.0. Avoid `height = "content"`: API 42 is marked unreleased. [Panel UI and sizing](https://docs.noctalia.dev/noctalia/plugins/development/declarative-ui/#panel---declarative-panel-ui) · [panel manifest options](https://docs.noctalia.dev/noctalia/plugins/development/manifest/#panel-entry)

Widget and panel entries run in separate Luau VMs; local Lua variables/modules do not cross entries. `noctalia.state.set/get/watch` is the in-memory per-plugin channel for plain strings, numbers, booleans, and tables, so the widget can publish `payload`/`error` for the panel to render. It is cleared when the plugin stops. Current lifecycle rules: `.luau` edits hot-reload; manifest edits are picked up on `noctalia msg config-reload`; widgets and panels rebuild on setting edits and re-read `getConfig`; long-lived services get `onConfigChanged()` or restart if they omit it. [Shared state](https://docs.noctalia.dev/noctalia/plugins/development/runtime-api/#sharing-state-across-entries) · [entry lifecycle and settings changes](https://docs.noctalia.dev/noctalia/plugins/development/entries/#reacting-to-settings-changes-in-a-service) · [local workflow](https://docs.noctalia.dev/noctalia/plugins/development/workflow/#local-development)

Two click details matter for the present widget: a user’s `[widget.<name>.actions]` binding overrides the matching script callback, and every widget’s default middle action opens its settings. Thus the current `onMiddleClick() refresh()` needs a `middle = "none"` widget action default (API 14) or an explicit user config binding before it can fire. The right-click callback can still open settings if that gesture is unbound. [Entry pointer callbacks](https://docs.noctalia.dev/noctalia/plugins/development/entries/#pointer-callbacks-are-overridable) · [widget action defaults](https://docs.noctalia.dev/noctalia/plugins/development/manifest/#widget-gesture-defaults)

## Reproducible Noctalia v5.3.0 headless host run

The source [flake](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/flake.nix) exposes `packages.<system>.default` (plus deprecated `.cuda` alias), `apps.<system>.default`, `devShells.<system>.default`, `overlays.default`, `homeModules.default`, `hjemModules.default`, and `nixosModules.default` for `x86_64-linux` and `aarch64-linux`. The default package contains `$out/bin/noctalia` and the runtime assets ([package derivation](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/nix/package.nix)). A temporary output link builds without adding Noctalia to the user’s profile:

```sh
E2E_DIR=$(mktemp -d)
export E2E_DIR
nix build 'github:noctalia-dev/noctalia/v5.3.0#default' --out-link "$E2E_DIR/noctalia"
export PATH="$E2E_DIR/noctalia/bin:$PATH"
"$E2E_DIR/noctalia/bin/noctalia" --version
```

Create isolated roots before starting the compositor. `NOCTALIA_CONFIG_HOME` and the other Noctalia-specific homes are home-shaped roots: Noctalia uses `<root>/noctalia/` inside each one. `XDG_RUNTIME_DIR` must be owned by the test user and mode `0700`.

```sh
mkdir -p "$E2E_DIR/home" "$E2E_DIR/config/noctalia" \
  "$E2E_DIR/data/noctalia/plugins/usage" "$E2E_DIR/state" \
  "$E2E_DIR/cache" "$E2E_DIR/runtime" "$E2E_DIR/shots" \
  "$E2E_DIR/xdg/config" "$E2E_DIR/xdg/data" "$E2E_DIR/xdg/state"
chmod 700 "$E2E_DIR/runtime"
export HOME="$E2E_DIR/home"
export NOCTALIA_CONFIG_HOME="$E2E_DIR/config"
export NOCTALIA_DATA_HOME="$E2E_DIR/data"
export NOCTALIA_STATE_HOME="$E2E_DIR/state"
export XDG_CONFIG_HOME="$E2E_DIR/xdg/config"
export XDG_DATA_HOME="$E2E_DIR/xdg/data"
export XDG_STATE_HOME="$E2E_DIR/xdg/state"
export XDG_CACHE_HOME="$E2E_DIR/cache"
export XDG_RUNTIME_DIR="$E2E_DIR/runtime"
export NOCTALIA_LOG_LEVEL=debug

cp -a /home/vincent/lab/tokitoki/integrations/noctalia-v5/tokitoki/. \
  "$NOCTALIA_DATA_HOME/noctalia/plugins/usage/"
```

The plugin id is `tokitoki/usage`, and Noctalia’s local plugin directory uses the id suffix, `usage`; the checked-in directory’s name `tokitoki` is not the install folder name. The source repository layout follows the same suffix convention. [Noctalia local plugin workflow](https://docs.noctalia.dev/noctalia/plugins/development/workflow/#local-development) · [plugin id path helper](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/src/scripting/plugin_id.h#L37-L50) · [local source root](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/src/scripting/plugin_source_paths.cpp#L22-L40)

Use a temporary `config/noctalia/config.toml` like this, adding any plugin values you want to pin:

```toml
[shell]
setup_wizard_enabled = false
offline_mode = true
telemetry_enabled = false

[plugins]
enabled = ["tokitoki/usage"]
auto_update = "none"

[bar.main]
position = "top"
start = ["tokitoki"]
center = []
end = []

[widget.tokitoki]
type = "tokitoki/usage:usage"

[plugin_settings."tokitoki/usage"]
display_mode = "shortest"
accounts = []
hide_identities = false
executable = "tokitoki"
```

`[plugins].enabled` takes the fully qualified plugin id. The widget name (`tokitoki`) is a user-configured instance name; its `type` is the full `author/plugin:entry` id. Local plugins still need enabling. `offline_mode` disables Noctalia outgoing HTTP, `auto_update = "none"` prevents plugin source background updates, and disabling telemetry prevents the startup ping. Set `executable` to the absolute Tokitoki binary under test (or put that binary on `PATH`) before Sway starts. The temporary `HOME` and XDG homes isolate Tokitoki’s own config/cache too; `widget-payload --cached --json` reads its cached SQLite projection without syncing/scanning harness stores, so seed only this disposable cache with fixtures if populated rows are needed. [Plugin configuration](https://docs.noctalia.dev/noctalia/plugins/) · [bar widget configuration](https://docs.noctalia.dev/noctalia/bar/widgets/#configure-widgets) · [Noctalia config locations](https://docs.noctalia.dev/noctalia/configuration/) · [Tokitoki cached payload path](../src/cli.ts#L2388-L2410)

Create a small driver that Sway launches after Noctalia. Sway sets `SWAYSOCK` and `WAYLAND_DISPLAY` for child processes; keeping the validation commands in this helper avoids depending on the shell that launched Sway inheriting those session values.

```sh
cat > "$E2E_DIR/drive.sh" <<'SH'
#!/bin/sh
set -eu
exec >> "$E2E_DIR/host-e2e.log" 2>&1
attempt=0
until noctalia msg status >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 80 ] || exit 1
  sleep 0.25
done
noctalia config validate
noctalia msg status
noctalia msg plugins list
swaymsg -t get_outputs > "$E2E_DIR/outputs.json"
noctalia msg panel-toggle tokitoki/usage:details
sleep 1
grim "$E2E_DIR/shots/details.png"
swaymsg exit
SH
chmod +x "$E2E_DIR/drive.sh"

cat > "$E2E_DIR/sway.conf" <<EOF
output * mode 1280x720
exec "$E2E_DIR/noctalia/bin/noctalia"
exec "$E2E_DIR/drive.sh"
EOF
```

Launch Sway with:

```sh
export WLR_BACKENDS=headless
export WLR_HEADLESS_OUTPUTS=1
export WLR_LIBINPUT_NO_DEVICES=1
export WLR_RENDERER=gles2
export WLR_RENDERER_ALLOW_SOFTWARE=1
export WLR_RENDERER_FORCE_SOFTWARE=1  # current wlroots; ignored by older wlroots
export LIBGL_ALWAYS_SOFTWARE=true     # Mesa software rendering for Noctalia's EGL client
unset DISPLAY WAYLAND_DISPLAY SWAYSOCK
sway -d -c "$E2E_DIR/sway.conf"
```

wlroots documents the headless backend, output count, GLES2 renderer, no-input-device mode, and the software-renderer allow flag. `WLR_RENDERER_FORCE_SOFTWARE` was added upstream to explicitly force a software GLES2/Vulkan renderer. Mesa’s `LIBGL_ALWAYS_SOFTWARE` forces software GL. v5.3.0’s native renderer creates an EGL/OpenGL ES context, so `QT_QUICK_BACKEND=software` is not a renderer control for this host. This is an inference from the Noctalia EGL/GLES implementation and Mesa/wlroots flags; verify the Sway and Noctalia logs actually select the expected software drivers. [wlroots env vars](https://raw.githubusercontent.com/swaywm/wlroots/master/docs/env_vars.md) · [wlroots force-software change](https://github.com/swaywm/wlroots/commit/cfcf06b8b0) · [Mesa env vars](https://docs.mesa3d.org/envvars.html) · [Noctalia EGL context](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/src/render/gl_shared_context.cpp) · [Noctalia GLES backend](https://github.com/noctalia-dev/noctalia/blob/a33122c4208a385e19c9a252e65e2751b2c44fbb/src/render/backend/gles_render_backend.cpp)

### Drive, inspect, and capture

The helper writes status, plugin-list, and output evidence under the temp root and captures the panel. It uses `grim` to capture all outputs; this single-output test does not need to assume the headless connector’s name. If `grim` is unavailable, use the documented Noctalia screenshot IPC instead. [Sway process environment](https://github.com/swaywm/sway/blob/master/sway/sway.1.scd)

```sh
noctalia config validate
noctalia msg config-reload
noctalia msg status
noctalia msg plugins list
noctalia msg config-get plugins.enabled
noctalia msg config-get bar.main.start
noctalia msg config-get widget.tokitoki.type
tail -F "$XDG_CACHE_HOME/noctalia/noctalia.log"
```

`config-reload` reloads TOML/manifest state; `.luau` edits hot-reload automatically. `status` reports basic shell state, `plugins list` reports enabled plugin state, `config-get` reports effective values, and logs explain manifest/runtime failures. `NOCTALIA_LOG_LEVEL=debug` selects startup console verbosity; the file log is not filtered. The main log is `$XDG_CACHE_HOME/noctalia/noctalia.log`. [Shell IPC](https://docs.noctalia.dev/noctalia/ipc/shell/) · [plugin IPC](https://docs.noctalia.dev/noctalia/ipc/plugins/) · [running and logs](https://docs.noctalia.dev/noctalia/getting-started/running-the-shell/#logs)

For an interactive run, commands below run from a child process in the Sway session. Open the actual plugin panel and capture the Wayland output after a short settle:

```sh
noctalia msg panel-toggle tokitoki/usage:details
swaymsg -t get_outputs
grim "$E2E_DIR/shots/details.png"
```

`grim` captures all outputs when no connector is named. Noctalia’s own `noctalia msg screenshot-fullscreen --save-to-file --no-copy-to-clipboard --no-annotate --directory "$E2E_DIR/shots" --format png <connector>` is another supported capture path; its screenshot commands require compositor `wlr-screencopy-unstable-v1` support. [Sway output inspection](https://github.com/swaywm/sway/blob/master/sway/sway-output.5.scd) · [grim usage](https://github.com/emersion/grim/blob/master/README.md) · [Noctalia screenshot IPC](https://docs.noctalia.dev/noctalia/ipc/media-and-ui/#screenshots)

To test the plugin’s IPC reload hook, add an `onIpc(event, payload)` branch that calls the same refresh/render function, then invoke `noctalia msg plugin tokitoki/usage:usage focused refresh`. This proves IPC dispatch to `onIpc`, not a mouse click. To test the widget’s actual `onClick`, place the pointer over the widget and send a left button through Sway:

```sh
swaymsg 'seat - cursor set X Y'
swaymsg 'seat - cursor press button1'
swaymsg 'seat - cursor release button1'
```

Sway marks these simulated cursor commands deprecated in favor of the virtual-pointer Wayland protocol; they are useful in a disposable harness. For the tooltip screenshot, move to the widget and wait for the host hover delay before capture. [Sway input commands](https://raw.githubusercontent.com/swaywm/sway/master/sway/sway-input.5.scd#L197-L229) · [Noctalia plugin event routing](https://docs.noctalia.dev/noctalia/ipc/plugins/#send-an-event)

### What this E2E does and does not prove

A genuine host validation means the pinned Noctalia binary is running under real Sway/wlroots, loads the real Luau adapter from its plugin directory, executes the real Noctalia IPC/runtime and native UI path, and yields a compositor screenshot. A fake `noctalia` Lua table or a mock API unit test does not establish host compatibility. A fixture executable standing in for `tokitoki` can still produce a genuine Noctalia host screenshot, but only validates the host/UI half; call it fixture-backed host UI validation, not full Tokitoki integration. For full adapter E2E, run the real Tokitoki executable against a disposable preseeded cache/fixture dataset with `--cached` and the temporary `HOME`/XDG roots above; do not point it at the user’s stores or credentials. This checkout’s CLI documents `widget-payload --cached --json` as the local cached projection path ([Tokitoki CLI](../src/cli.ts)).

The separate [Noctalia Shell legacy v4 plugin docs](https://docs.noctalia.dev/noctalia-shell-legacy/development/plugins/) describe the older Quickshell/QML plugin system; treat it as a separate adapter target. Noctalia v5 is the native C++/Luau path researched here.
