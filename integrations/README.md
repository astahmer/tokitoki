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

The Nix package installs these adapter files under
`<tokitoki-store-path>/share/tokitoki/integrations`; a Home Manager setup can
point its shell configuration at that store path instead of a checkout.

Adapters must not read `cache.db` or provider stores directly. Run `tokitoki
scan` separately, or use `tokitoki widget-payload --json` for a one-shot live
refresh. The web-based adapters need `tokitoki web` running as well.

## DMS first test

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

On Linux, start the complete widget without DMS:

```sh
nix run .#quickshell
```

Or use an installed Quickshell with the repository's integration tree:

```sh
tokitoki scan
qs -p "$PWD/integrations/quickshell/tokitoki"
```

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
| `waybar` | Waybar | `custom/*` JSON module |
| `gnome/tokitoki@local` | GNOME Shell 45+ | GJS extension |
| `cosmic/tokitoki-applet` | COSMIC | Rust/libcosmic applet scaffold |

The current Noctalia adapter is deliberately Luau: Noctalia v5 does not load
the legacy QML plugin API. The v4 adapter is retained only for users running
the legacy shell.
