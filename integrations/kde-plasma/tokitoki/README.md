# Tokitoki for KDE Plasma 6

Install the complete package from a checkout:

```sh
kpackagetool6 --type Plasma/Applet --install integrations/kde-plasma/tokitoki/package
# For an existing install:
kpackagetool6 --type Plasma/Applet --upgrade integrations/kde-plasma/tokitoki/package
```

Start `tokitoki serve` (read-only loopback API, port 6736), then add **Tokitoki Usage** through Plasma's widget picker. In widget settings, change the service URL to `http://127.0.0.1:7788` if you already run `tokitoki web`. The plasmoid reads `/v1/status?last=day` and `/v1/limits`; it never executes shell commands.

The compact panel view supports shortest window per account (default), all windows, today's usage totals, and icon only. Click to expand the complete quota view. A desktop placement shows the complete view directly. The tooltip retains all quota windows regardless of compact mode.

Use the settings' account IDs field to select profiles, for example `codex@work,cursor@personal`; empty means all. IDs come from `tokitoki limits --json` (`accounts[].id`). Multiple profiles for a vendor get uppercase initials in the bar. Shared Tokitoki account visibility and identity privacy settings are respected in addition to local settings.

Percentages mean remaining capacity. Expired, stale and unknown observations never show fabricated remaining capacity. Unknown durations show `?`, monthly windows use `1mo`, and countdowns omit a “reset” prefix. Dollar amounts take precedence for on-demand usage. Budgets and T3 Code activity appear separately from provider quotas and usage totals.

Refreshes occur every 30 seconds, with a ten second request timeout. If the backend fails, the widget reports the error and retains its last successful snapshot; time-dependent quota expiry still applies. Run scans/polls and notifications independently (for example with the Home Manager timers).

Development in the native host:

```sh
plasmoidviewer -a "$PWD/integrations/kde-plasma/tokitoki/package" -l floating -f planar -s 520x780
```

The reproducible fixture-backed native-host scenarios for both adapters are documented in [the E2E guide](../../../e2e/README.md).
