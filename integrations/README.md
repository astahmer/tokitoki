# Tokitoki shell adapters

The DMS and standalone Quickshell widgets share their full views. The other
adapters are smaller experimental integrations. They consume the same
versioned payload as the native apps and keep shell-specific rendering at the
edge.

## Shared contract

Refresh the local cache first, then inspect the contract:

```sh
tokitoki scan
tokitoki widget-payload --cached --json
```

The same payload is available from the local web server at:

```text
GET http://127.0.0.1:7788/v1/status?last=day
```

The payload is versioned with `schema: 1` and contains:

- `window`: the requested aggregation window;
- `stats`: cost, tokens, requests, sessions, and cache percentage;
- `providers`: the largest provider slices;
- `budgets`: configured budget gauges, when present.

`widget-payload` adds a few fields that the DMS and Quickshell views use:

- `providerRegistry`: provider, harness, and vendor ids mapped to
  `{displayName, shortName, vendor, icon, logo, statusPage, aliases}`.
  Adapters look up names and logos here and fall back to the raw id.
- `vendor` on every `limits` entry and every `today.rows` bucket, so adapters
  group cards by vendor instead of parsing account keys.
- `statusIncidents`: `{vendor: {indicator, description, url}}` for vendors
  you have an account with that publish a status page. These are Anthropic,
  OpenAI, Cursor, and GitHub (Statuspage), plus Gemini (Google's Workspace
  incidents feed). `indicator` is `none`, `minor`, `major`, or `critical`.
  Live payloads refresh it at most every 5 minutes; `--cached` reads only the
  stored copy. A failed fetch keeps the last answer, and that answer is
  dropped after an hour. The DMS quota card shows a badge for degraded
  vendors, and the bar pill shows a warning icon. Turn the checks off with
  `statusIncidents.enabled = false`.
- `balance` on prepaid accounts (DeepSeek, OpenRouter credits):
  `{currency, remaining, total?, used?, granted?, paid?, available?}`.

Provider logos under `dms/tokitoki/assets/provider-logos/` for DeepSeek,
Kimi, and OpenRouter come from [Simple Icons](https://simpleicons.org)
(CC0-1.0).

The Nix package installs these adapter files under
`<tokitoki-store-path>/share/tokitoki/integrations`; a Home Manager setup can
point its shell configuration at that store path instead of a checkout.

Adapters must not read `cache.db` or provider stores directly. Run `tokitoki
scan` separately, or use `tokitoki widget-payload --json` for a one-shot live
refresh. The web-based adapters need `tokitoki web` running as well.

## Add to an existing setup

On Linux/Wayland, choose the host you already use:

- **DMS installed:** install the Tokitoki CLI and link the plugin directory,
  then enable it in Settings → Plugins and add it to DankBar.
- **Home Manager:** import the module and enable `programs.tokitoki.dms.enable`
  or `programs.tokitoki.quickshell.enable` (examples below).
- **Standalone Quickshell:** run `nix run github:astahmer/tokitoki#quickshell`.
  This includes the CLI, Quickshell runtime and shared QML files.

The standalone version creates its own top bar on each screen. For an existing
Quickshell bar, choose the embedded mode below and insert its button component.

## DMS installation

### Existing DMS, without Home Manager

Install `tokitoki` on the desktop session's `PATH` first; for example with
`nix profile install github:astahmer/tokitoki`. Then keep a source checkout at
a stable location and link just its plugin subdirectory:

```sh
mkdir -p "$HOME/.local/share"
git clone --depth 1 https://github.com/astahmer/tokitoki.git \
  "$HOME/.local/share/tokitoki-source"
mkdir -p "$HOME/.config/DankMaterialShell/plugins"
ln -s "$HOME/.local/share/tokitoki-source/integrations/dms/tokitoki" \
  "$HOME/.config/DankMaterialShell/plugins/tokitoki"
tokitoki scan
dms ipc call plugin-scan rescan tokitoki
```

These are first-install commands: if the destination exists, use the existing
installation or the development instructions below. With a custom
`XDG_CONFIG_HOME`, replace `$HOME/.config` with that directory.

Enable **Tokitoki Usage** in Settings → Plugins, then add it to your DankBar
layout. If DMS does not discover it, use Settings → Plugins → Scan for Plugins,
or restart DMS with `dms restart`.

To update the checkout, run:

```sh
git -C "$HOME/.local/share/tokitoki-source" pull --ff-only
dms ipc call plugin-scan rescan tokitoki
```

Update the separately installed CLI as well. DMS's
`dms plugins install <plugin-id>` installs from configured registries; it is
not an arbitrary GitHub URL/subdirectory installer. The manual path above
works with Tokitoki's monorepo layout without a registry entry. See the
[official plugin installation guide](https://danklinux.com/docs/dankmaterialshell/plugins-overview/).

### Home Manager: one input, one host option

Add Tokitoki to your configuration flake:

```nix
inputs.tokitoki.url = "github:astahmer/tokitoki";
```

Import its Home Manager module, with `inputs` passed through
`extraSpecialArgs` or captured from the flake:

```nix
imports = [ inputs.tokitoki.homeManagerModules.default ];
```

For an **existing, enabled DMS Home Manager setup**, add only:

```nix
programs.tokitoki.dms.enable = true;
```

This installs the CLI, registers and enables the plugin, pins its executable
path, and adds Tokitoki to the right side of each enabled DankBar. Existing
Home Manager bar layouts, other widgets and DMS settings are preserved;
Tokitoki is not added twice when it already appears in any section. With no
declared layout, a starter bar is provided.

Automatic placement makes DMS settings declarative (read-only in its GUI).
If your existing layout/settings are managed through the GUI, first capture
`dms ipc call settings dump` and import the desired values into your existing
`programs.dank-material-shell.settings`. Home Manager refuses to overwrite
unmanaged settings files; migrate or back them up using your usual Home
Manager workflow. Existing GUI plugin preferences likewise belong under
`programs.dank-material-shell.plugins.<id>.settings` when migrating them.

To keep the DankBar layout managed in the GUI instead:

```nix
programs.tokitoki.dms = {
  enable = true;
  addToBar = false;
};
```

Then add Tokitoki through the DankBar editor. To select a different section
for automatic placement, set `programs.tokitoki.dms.barSection` to
`"leftWidgets"`, `"centerWidgets"` or `"rightWidgets"`.

For a **standalone Quickshell bar**, use this instead of the DMS option:

```nix
programs.tokitoki.quickshell.enable = true;
```

This installs the CLI/runtime and starts `tokitoki-quickshell` with the
Wayland graphical session. The user service restarts on failure and stops
with the session. Niri needs no Tokitoki-specific configuration when its
systemd session integration is enabled. Other compositors must also start
the graphical session target and import their Wayland environment.

The target defaults to Home Manager's `wayland.systemd.target`; override
`programs.tokitoki.quickshell.systemd.target` if your session uses another
one. For compositor-managed startup instead, disable
`programs.tokitoki.quickshell.systemd.enable` and launch
`tokitoki-quickshell --no-duplicate` from your existing startup configuration.

Run your usual Home Manager/NixOS rebuild. Restart your existing DMS session
after the first install so it discovers the plugin. After updates that add or
remove QML files, restart DMS or run `dms ipc call plugin-scan rescan tokitoki`.
Update the `tokitoki` flake input and rebuild to update the CLI and widget
together. These options configure the existing host; the DMS option requires
its Home Manager module to be imported and DMS to be enabled already.

On a fresh Tokitoki installation, run `tokitoki scan` once to index the local
provider stores. Enable source scanning in the widget's refresh settings if
you want subsequent widget refreshes to scan too.

### Embed in an existing Quickshell bar

Use the same input and module import, then select the existing configuration:

```nix
programs.tokitoki.quickshell = {
  enable = true;
  mode = "embedded";
  configName = "mybar";
};
```

For `~/.config/quickshell/mybar/shell.qml`, this installs a `Tokitoki/`
component directory alongside your shell. Leave `configName = ""` for a
shell at `~/.config/quickshell/shell.qml`. Embedded mode starts no separate
bar or service. Add this import to the existing `shell.qml`:

```qml
import "Tokitoki" as Tokitoki
```

Inside your bar's existing `RowLayout` or equivalent container:

```qml
Tokitoki.TokitokiWidget {
    screen: bar.screen // bar is your existing PanelWindow's id
    popupY: bar.height + 4
}
```

The button opens the full dashboard and owns its data/persistence controller.
It has no dependency on the host's `qs.Common`, theme, plugin API or IPC target.
For `RowLayout`, use `Layout.preferredWidth: implicitWidth` and
`Layout.preferredHeight: implicitHeight` if your layout controls sizing.
The popup opens at the top-left of the selected screen by default; `popupX`
and `popupY` are screen coordinates and can be set for your bar's placement.

For one shared dashboard across multiple bar instances, create one
`Tokitoki.TokitokiController { id: usage }` under your `ShellRoot` and pass
`controller: usage` to each button. The selected screen follows the clicked
button. A host can call `usage.openDashboard("tokens")`,
`usage.closeDashboard()` or `usage.toggle(screen)` in its own IPC handlers.
See the [embedded test shell](../e2e/container/embedded/shell.qml) for a
complete example. Packaged components live under
`<tokitoki-store-path>/share/tokitoki/qml/Tokitoki`; keep that directory intact.

### Development checkout

From this repository, symlink the complete development plugin so its files stay
editable:

```sh
mkdir -p ~/.config/DankMaterialShell/plugins
ln -sfn "$PWD/integrations/dms/tokitoki" \
  ~/.config/DankMaterialShell/plugins/tokitoki
dms ipc call plugin-scan rescan tokitoki
```

Use `plugin-scan rescan <id>` (not `plugins reload <id>`) whenever a `.qml`
file was **added or removed**: `reload` reuses the cached component list, so a
new `TokitokiFoo.qml` reports `<Type> is not a type` and leaves the plugin
disabled. A failed reload is undone with `dms ipc call plugins enable tokitoki`.
This also applies when Home Manager installs a version with new QML components.

Then enable `Tokitoki Usage` in DMS Settings → Plugins and add it to DankBar.
The widget invokes `tokitoki` from `PATH`. When DMS was launched outside the
direnv shell, restart it from the active dev shell or install the Nix package
through Home Manager so DMS inherits the command. For a different command path,
use the executable override in DMS Settings → Plugins → Tokitoki.

If DMS is managed by `systemd --user` (the usual Home Manager setup), direnv
cannot change its environment. Add the local flake to the Home Manager
configuration and enable the module:

```nix
inputs.tokitoki.url = "path:/home/vincent/lab/tokitoki";

imports = [ inputs.tokitoki.homeManagerModules.default ];
programs.tokitoki.enable = true;
```

Run your normal `home-manager switch`, then restart DMS:

```sh
systemctl --user restart dms.service
dms ipc call plugins status tokitoki
```

The DMS widget includes Sessions (conversation search, pagination, reindexing,
request timeline and cache estimates), provider/model breakdowns, repository
activity and a daily token sparkline. Search filters usage cards without
changing chart totals; private repository names are also masked in chart legends.
The Settings tab exposes notification preferences shared with the native app;
DMS does not deliver those desktop alerts itself. These views use the existing
`widget-payload`, `sessions`, `reindex`, `config set` and `ui` CLI commands.

For screenshots and interaction checks in an isolated Docker desktop, see
[`e2e/README.md`](../e2e/README.md).

## Standalone Quickshell

On Linux/Wayland, start the complete widget without a checkout or DMS:

```sh
nix run github:astahmer/tokitoki#quickshell
```

From this checkout, use `nix run .#quickshell` instead. For a permanent
installation and session startup, use the Home Manager option above.
The installed wrapper forwards Quickshell arguments, so
`tokitoki-quickshell ipc call tokitoki toggle` can be used in a keybinding.

Or use an installed Quickshell with the repository's integration tree:

```sh
tokitoki scan
qs -p "$PWD/integrations/quickshell/tokitoki"
```

Quickshell supports selecting a separate configuration with `--path`/`-p`;
see the [official configuration guide](https://quickshell.org/docs/v0.3.0/guide/introduction/).
Keep `integrations/dms/tokitoki` alongside `integrations/quickshell/tokitoki`:
the standalone host loads the shared views and provider logos from that sibling
directory. It does not load DMS services or require DMS to be installed. The
Tokitoki Nix package installs the complete integration tree.

Click the bar item to open the widget. The header menu opens display, refresh,
privacy and account visibility settings. Notification preferences use the same
Tokitoki config as the native app; the widget does not deliver desktop alerts.

The `tokitoki` IPC target also opens a specific tab:

```sh
qs -p "$PWD/integrations/quickshell/tokitoki" ipc call tokitoki open tokens
qs -p "$PWD/integrations/quickshell/tokitoki" ipc call tokitoki toggle
qs -p "$PWD/integrations/quickshell/tokitoki" ipc call tokitoki close
qs -p "$PWD/integrations/quickshell/tokitoki" ipc call tokitoki status
```

Standalone display preferences are stored in
`$XDG_CONFIG_HOME/tokitoki/quickshell.json` (default
`~/.config/tokitoki/quickshell.json`), and navigation state in
`$XDG_STATE_HOME/tokitoki/quickshell-state.json` (default
`~/.local/state/tokitoki/quickshell-state.json`). These do not change DMS plugin
preferences.

Run its isolated screenshot/interaction scenario with:

```sh
E2E_SHELL=quickshell ./e2e/run.sh
```

## Other adapters

| Directory | Host | Status |
|---|---|---|
| `dms/tokitoki` | DankMaterialShell | Full QML widget |
| `noctalia-v5/tokitoki` | Current Noctalia | Luau widget |
| `noctalia-v4/tokitoki` | Legacy Noctalia v4 | QML bar widget |
| `quickshell/tokitoki` | Standalone Quickshell | Full shared widget, no DMS runtime |
| `kde-plasma/tokitoki/package` | KDE Plasma 6 | Plasmoid |
| `waybar` | Waybar | `custom/*` JSON module; vendor incidents add a ⚠, tooltip lines, and an `incident` CSS class |
| `gnome/tokitoki@local` | GNOME Shell 45+ | GJS extension |
| `cosmic/tokitoki-applet` | COSMIC | Rust/libcosmic applet scaffold |

The current Noctalia adapter is deliberately Luau: Noctalia v5 does not load
the legacy QML plugin API. The v4 adapter is retained only for users running
the legacy shell.
