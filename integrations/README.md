# Tokitoki shell adapters

These are intentionally small proof-of-concept integrations. They all consume
the same versioned payload as the native apps and keep shell-specific
rendering at the edge.

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
dms ipc call plugins reload tokitoki
```

Then enable `Tokitoki Usage` in DMS Settings → Plugins and add it to DankBar.
The widget invokes `tokitoki` from `PATH`. When DMS was launched outside the
direnv shell, restart it from the active dev shell or install the Nix package
through Home Manager so DMS inherits the command; edit `TokitokiWidget.qml`
only when you intentionally want a different command path.

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
dms ipc call plugins reload tokitoki
```

## Other adapters

| Directory | Host | Status |
|---|---|---|
| `dms/tokitoki` | DankMaterialShell 1.5 | QML plugin |
| `noctalia-v5/tokitoki` | Current Noctalia | Luau widget |
| `noctalia-v4/tokitoki` | Legacy Noctalia v4 | QML bar widget |
| `quickshell/tokitoki` | Standalone Quickshell | QML panel |
| `kde-plasma/tokitoki/package` | KDE Plasma 6 | Plasmoid |
| `waybar` | Waybar | `custom/*` JSON module |
| `gnome/tokitoki@local` | GNOME Shell 45+ | GJS extension |
| `cosmic/tokitoki-applet` | COSMIC | Rust/libcosmic applet scaffold |

The current Noctalia adapter is deliberately Luau: Noctalia v5 does not load
the legacy QML plugin API. The v4 adapter is retained only for users running
the legacy shell.
