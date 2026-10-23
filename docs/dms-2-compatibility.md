# DMS 2.0 compatibility audit

Audited the DMS `v2.0.0` tag on 2026-10-23. The tag resolves to commit
`9b413296`, the same commit as `stable` at audit time. The release is a new
upstream repository, `duxlabs-dev/dux-shell`; its [release notes](https://github.com/duxlabs-dev/dux-shell/releases/tag/v2.0.0)
and [migration announcement](https://duxlabs.dev/blog/v2-0-release) are the
primary upgrade references.

## Tokitoki QML plugin

The pre-migration plugin used `PluginComponent`, `qs.Modules.Plugins`,
`qs.Common`, `qs.Widgets`, and the old `Dank*` controls. DMS 2 still provides
`PluginComponent`, `PluginSettings`, `SelectionSetting`, `StringSetting`,
`ToggleSetting`, `PopoutComponent`, and the `Theme` singleton. Its
`PluginComponent` still exposes reactive `pluginData` and `pluginService`;
`savePluginData`/`loadPluginData` and state methods remain available. Keep
`qs.Modules.Plugins` and `qs.Common` for those APIs and the `Theme.*` helpers.
[The v2 plugin component](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/quickshell/Modules/Plugins/PluginComponent.qml#L78-L120)
and [settings implementation](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/quickshell/Modules/Plugins/PluginSettings.qml#L131-L161)
confirm this contract.

The shared widget import and names changed. For the controls used by Tokitoki,
use:

| Before | DMS 2 |
| --- | --- |
| `qs.Widgets` / `DankButton` | `qs.DCommon.Widgets` / `DButton` |
| `qs.Widgets` / `DankActionButton` | `qs.DCommon.Widgets` / `DActionButton` |
| `qs.Widgets` / `DankIcon` | `qs.DCommon.Widgets` / `DIcon` |
| `qs.Widgets` / `DankToggle` | `qs.DCommon.Widgets` / `DToggle` |
| `qs.Widgets` / `DankFlickable` | `qs.DCommon.Widgets` / `DFlickable` |
| `qs.Widgets` / `StyledText` | `qs.DCommon.Widgets` / `StyledText` |

The [release migration guide](https://duxlabs.dev/blog/v2-0-release) documents
these mappings. In v2.0, old `qs.Widgets` common-control wrappers delegate to
the new `D*` controls and log deprecation warnings; `StyledText` is a
same-name re-export. Keep `qs.Widgets` only where a plugin still uses a
shell-specific widget. The current [plugin development guide](https://duxlabs.dev/docs/dms/plugin-development)
has migration examples.

This import change sets the minimum host version. DMS 1.6 and its pinned
`dank-qml-common` commit expose `qs.DankCommon.Widgets` and `Dank*` types;
they do not provide `qs.DCommon.Widgets`. The direct v2 imports therefore
fail on 1.6. The local 1.6 container check reproduced the missing-module
error. The plugin manifest must declare `"requires_dms": ">=2.0.0"` when it
uses the new imports; the `widget` type, `dankbar-widget` capability,
component/settings fields, and permissions remain valid. The v2
[manifest reference](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/.agents/skills/dms-plugin-dev/references/plugin-manifest-reference.md)
still defines `requires_dms` as an optional minimum-version field.

The common controls have a Material 3 Expressive redesign, so replacing names
is not a pixel-identical rendering change. Tokitoki's used properties map
across (`text`, icon name/size/color, button height/padding/click, toggle
checked/text/description, and flickable content sizing), but defaults and
sizing are now style-driven. For example, old `DankButton` used a fixed 40 px
default height and 64 px minimum width; `DButton` uses `Style.buttonHeightS`
and `Style.buttonMinWidth` ([v1.6](https://github.com/AvengeMedia/dank-qml-common/blob/26396ce432d6c71c3f5367438f96f4a8d667e160/DankCommon/Widgets/DankButton.qml#L8-L24),
[v2.0](https://github.com/duxlabs-dev/dux-qml-common/blob/ebf5e6c002da1bdaa4aaa2f319fea7b8507abc42/DCommon/Widgets/DButton.qml#L7-L31)).
Review compact layouts where the plugin sets explicit dimensions. One concrete
behavioral break is the popout close button: DMS 1.6 rendered
`showCloseButton`, while DMS 2.0 retains the property only for API
compatibility and no longer draws it. Tokitoki now needs an explicit close
action in `headerActions`. See the [v1.6 implementation](https://github.com/duxlabs-dev/dux-shell/blob/v1.6.0/quickshell/Modules/Plugins/PopoutComponent.qml#L57-L86)
and [v2.0 implementation](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/quickshell/Modules/Plugins/PopoutComponent.qml#L8-L14).

For Tokitoki's standalone Quickshell host, shared-source compatibility widgets
must resolve under `DCommon/Widgets`; DMS supplies this module from its
`dux-qml-common` submodule. The migration moves the local widgets there, uses
the new imports, raises `requires_dms` to `>=2.0.0`, and adds the popout close
action explicitly.

Validation completed against the pinned DMS 2.0.0 image:

- All 493 Bun tests pass.
- Home Manager checks pass, including canonical plugin paths and rejection
  of a DMS 1.6 package with an upgrade message.
- DMS 2.0 E2E passes all eight tabs, eight UI interactions and seven session
  CLI requests (search, detail, pagination and settings persistence).
- Embedded Quickshell E2E passes all eight tabs and fourteen interactions,
  including restart persistence and multiple screens; standalone smoke also
  passes. The standalone host resolves its own `DCommon/Widgets` compatibility
  controls and bundled icon font.
- The hover regression check advances the countdown clock while the pointer
  stays inside the card and verifies that it remains open. Daily budget
  windows resolve their duration from calendar bounds and participate in
  shortest-window selection.
- The DMS harness queries control geometry and layer-surface margins for
  clicks affected by the new padding and control sizes. Production plugins
  expose no testing IPC.

The DMS 1.6 container reproduced the new import's missing-module error, as
expected from the version floor. No live desktop installation or restart
was performed.

## Configuration paths, Home Manager, and packaging

The program-option namespace did not move. The v2 flake still exports
`homeModules.dank-material-shell` and `homeModules.default`, and its
Home Manager module still uses `programs.dank-material-shell`. It writes
settings, plugin settings, and plugins under `dms/` in the XDG config tree.
The DMS package outputs remain `packages.${system}.dms-shell` and `default`.
The `homeModules.dankMaterialShell.default` camel-case alias now warns in
favor of the hyphenated output. These names match Tokitoki's current
`options ? programs.dank-material-shell.enable` check and its
`programs.dank-material-shell.plugins.tokitoki` integration in
[`nix/home-manager.nix`](../nix/home-manager.nix); no Nix option or module
output rename is needed. See the tagged [flake outputs](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/flake.nix#L201-L219),
[option definition](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/distro/nix/options.nix#L9-L29),
and [Home Manager module](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/distro/nix/home.nix#L50-L67).

Filesystem paths did change. DMS 2 uses `~/.config/dms` for configuration,
`~/.local/state/dms` for state, and `~/.cache/dms` for cache. Home Manager
installs a plugin at `~/.config/dms/plugins/<id>` and writes plugin settings
to `~/.config/dms/plugin_settings.json`. On first run DMS migrates the old
`DankMaterialShell` directories and leaves symlinks at the old paths, so
users retain data; new installation instructions and test fixtures should
use the canonical `dms` paths. This is confirmed by the
[v2 path singleton](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/quickshell/Common/Paths.qml#L18-L23),
[plugin manager](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/core/internal/plugins/manager.go#L37-L50),
[Home Manager module](https://github.com/duxlabs-dev/dux-shell/blob/v2.0.0/distro/nix/home.nix#L50-L127),
and the release notes. The new [plugin overview](https://duxlabs.dev/docs/dms/plugins-overview)
and [Home Manager/Nix guide](https://duxlabs.dev/docs/dms/nixos) are the
current documentation URLs. The current [development guide](https://duxlabs.dev/docs/dms/plugin-development)
has DMS 2 migration guidance but also retains old examples for the config path
and `showCloseButton`; use tagged source for those details.

Tokitoki's own Nix package still ships its integration directory under
`share/tokitoki/integrations/dms/tokitoki`; it does not build DMS, so no DMS
repository, desktop-file, or Go-toolchain changes are needed in Tokitoki's
package. The headless test flake does package DMS: its input URL and lock now
point to `duxlabs-dev/dux-shell` at the audited 2.0.0 commit. Our package and
Home Manager checks retain the supported `dms-shell` output. The `dms`
binary and systemd units retain their names, while desktop/icon assets use
`dev.duxlabs.shell.*` ([package-maintainer migration notes](https://duxlabs.dev/blog/v2-0-release)).

## Optional DMS 2 surfaces

The existing bar widget remains a normal `type: "widget"` plugin, and DMS 2's
OmegaDock hosts the same widget surface; no new manifest capability or QML
component is needed for that use. Adding a dock-specific inline panel with
`attachedContent` is optional extra UI. Dash tabs and overview cards are also
optional: they require `dash`/`dashCard` components (or a composite manifest)
and their own UI work. Neither dock panels nor Dash surfaces are required to
keep Tokitoki's existing bar plugin working. See the [release announcement](https://duxlabs.dev/blog/v2-0-release),
[plugin overview](https://duxlabs.dev/docs/dms/plugins-overview), and [development guide](https://duxlabs.dev/docs/dms/plugin-development).
