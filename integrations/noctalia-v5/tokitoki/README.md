# Tokitoki for Noctalia 5

Requires Noctalia plugin API 32+ and `tokitoki` on the shell's PATH. This is the native Luau plugin; the separate `noctalia-v4` directory targets the historical QML shell.

From a checkout, install the complete plugin directory:

```sh
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/noctalia/plugins"
cp -R integrations/noctalia-v5/tokitoki "${XDG_DATA_HOME:-$HOME/.local/share}/noctalia/plugins/"
```

Merge these entries into your Noctalia configuration (retain your existing bar placement):

```toml
[plugins]
enabled = ["tokitoki/usage"] # append to existing enabled plugins

[widget.tokitoki]
type = "tokitoki/usage:usage"

[bar.main]
start = ["tokitoki"] # append to the existing list

[plugin_settings."tokitoki/usage"]
display_mode = "shortest"
accounts = []
hide_identities = false
executable = "tokitoki"
```

Run `noctalia msg config-reload`. Left click opens the quota panel, right click opens plugin settings, middle click refreshes. Noctalia binds middle click to settings by default; to use manual refresh, add `middle = "none"` under `[widget.tokitoki.actions]`.

Settings offer `shortest` (default), `quotas`, `total` and `icon`. Shortest selects the shortest known current window **within each account**. The hover and panel always retain every quota window. Two profiles for the same vendor get uppercase initials such as `EV:` and `WO:`. Percentages show remaining capacity. Timers show only the time left.

`accounts` accepts complete IDs such as `["codex@work", "cursor@personal"]`; empty means all. Get IDs from `tokitoki limits --json` (`accounts[].id`). Shared Tokitoki visibility and identity privacy settings are also respected. Settings apply to the plugin's panel and bar together.

Expired, stale or unknown observations remain labeled as such. Unknown durations show `?`; no billing interval or capacity is invented. On-demand dollar amounts take precedence over percentage placeholders. Local budget usage is separate from provider quotas. The “Via T3 Code” activity card is separate from usage totals.

The plugin reads `tokitoki widget-payload --cached --json` every 30 seconds; it does not scan credentials or poll providers. Run `tokitoki scan` and, for live quotas, `tokitoki poll`, or enable the corresponding Home Manager timers. This adapter does not send desktop notifications; use `programs.tokitoki.notify.enable` for notifications independently of the shell.

For Nix-managed installs, make the entire directory available as an immutable plugin path source, enable `tokitoki/usage`, and place the widget as above. All required Luau modules, translations and icons live inside this directory.
