# QML shell integration reuse research

Date checked: 2026-09-02

## Conclusion

One QML integration cannot be developed once and shipped unchanged across DMS,
current Noctalia, standalone Quickshell, KDE Plasma, GNOME Shell, COSMIC, and
Waybar. The useful reuse boundary is a headless data/command contract plus
small host adapters. QML source can be shared substantially within the
Quickshell family, especially for DMS and a standalone Quickshell config, but
the host lifecycle, imports, manifests, UI surfaces, and distribution formats
are not a common ABI.

Current Noctalia is the decisive incompatibility: v5 is a native runtime whose
plugin system is a directory with `plugin.toml` and Luau entry scripts running
in isolated VMs, not QML ([Noctalia v5 announcement](https://noctalia.dev/blog/announcing-noctalia-v5),
[Noctalia plugin development](https://docs.noctalia.dev/noctalia/plugins/development/)).
The older Quickshell/QML API is documented under an explicitly legacy v4 namespace
([legacy v4 plugin overview](https://docs.noctalia.dev/noctalia-shell-legacy/development/plugins/overview/)).

## Compatibility matrix

| Host | Actual extension entry point/API | Packaging/distribution | IPC or process integration | Reuse of one QML integration |
|---|---|---|---|---|
| DankMaterialShell 1.5 | `plugin.json`; QML `PluginComponent`, `PluginSettings`, `DesktopPluginComponent`; widget, launcher, daemon, desktop, and composite types ([DMS plugin overview](https://danklinux.com/docs/dankmaterialshell/plugins-overview/), [development guide](https://danklinux.com/docs/dankmaterialshell/plugin-development/)) | `~/.config/DankMaterialShell/plugins/`; GitHub clone, DMS registry, or Nix/Home Manager plugin registry ([overview](https://danklinux.com/docs/dankmaterialshell/plugins-overview/), [Nix plugin packaging](https://danklinux.com/docs/dankmaterialshell/nixos-flake/)) | `dms ipc call <target> <function> [parameters...]`; runtime plugin scan/reload is documented ([DMS IPC](https://danklinux.com/docs/dankmaterialshell/keybinds-ipc/), [development guide](https://danklinux.com/docs/dankmaterialshell/plugin-development/)) | **Native QML target.** Share only code that avoids DMS-only `qs.*`/`Theme`/plugin-service imports. |
| Noctalia v5 | `plugin.toml`; Luau entry scripts and host-injected APIs such as `noctalia.*`, `barWidget.*`, `panel.*`, `ui.*`; `onIpc` lifecycle callback ([plugin development](https://docs.noctalia.dev/noctalia/plugins/development/), [entry scripts](https://docs.noctalia.dev/noctalia/plugins/development/entries/)) | `$XDG_DATA_HOME/noctalia/plugins`; source repositories with `catalog.toml`, API-versioned revisions, official/community sources ([workflow & publishing](https://docs.noctalia.dev/noctalia/plugins/development/workflow/)) | `noctalia msg plugin <author/plugin:entry> <target> <event> [payload]`; targets include focused output, connector/bar, or all ([workflow & publishing](https://docs.noctalia.dev/noctalia/plugins/development/workflow/), [official plugins](https://docs.noctalia.dev/noctalia/plugins/official-plugins/)) | **No QML plugin reuse.** A separate Luau adapter is required. |
| Noctalia legacy v4 | QML `manifest.json` with entry points such as `Main.qml`, `BarWidget.qml`, `Panel.qml`, and injected `pluginApi` ([legacy manifest](https://docs.noctalia.dev/noctalia-shell-legacy/development/plugins/manifest/)) | Plugin directory plus central/custom repositories ([legacy registry](https://github.com/noctalia-dev/legacy-v4-plugins)) | Quickshell `IpcHandler`, routed under `plugin:<id>` ([legacy IPC](https://docs.noctalia.dev/noctalia-shell-legacy/development/plugins/ipc/)) | **Partial/historical only.** Do not make current support depend on this ABI. |
| Standalone Quickshell 0.3 | A config is a directory containing `shell.qml`, or a raw QML path; reusable `Component`/`Variants`, `PanelWindow`, `Process`, and `IpcHandler` are core building blocks ([configuration/introduction](https://quickshell.org/docs/v0.3.0/guide/introduction/), [IpcHandler](https://quickshell.org/docs/v0.3.0/types/Quickshell.Io/IpcHandler/)) | XDG config directories, `--config`, or `--path`; packaged by distro/Nix/AUR/COPR/etc. ([Quickshell setup](https://quickshell.org/docs/v0.3.0/guide/install-setup/)) | `qs ipc` invokes per-instance `IpcHandler`; `Process`/`startDetached` runs external commands ([IpcHandler](https://quickshell.org/docs/v0.3.0/types/Quickshell.Io/IpcHandler/), [Process](https://quickshell.org/docs/v0.3.0/types/Quickshell.Io/Process/)) | **Good QML reuse at the component level.** It is a toolkit/config host, not a universal plugin ABI. |
| KDE Plasma 6 | Plasma widget/Plasmoid package; `ui/main.qml` must root at `PlasmoidItem`, with Plasma imports and `plasmoid` context ([setup](https://develop.kde.org/docs/plasma/widget/setup/), [KF6 porting](https://develop.kde.org/docs/plasma/widget/porting_kf6/)) | `metadata.json`; user package under `~/.local/share/plasma/plasmoids/`, system package under `/usr/share/plasma/plasmoids/`; pure QML can be distributed as a package, compiled QML extensions need distro packaging ([Plasma packaging](https://develop.kde.org/docs/plasma/widget/setup/), [C++/QML extension packaging](https://develop.kde.org/docs/plasma/widget/c-api/)) | Plasma supports D-Bus activation for widgets and KDE documents Qt D-Bus method/signal access ([widget properties](https://develop.kde.org/docs/plasma/widget/properties/), [D-Bus access](https://develop.kde.org/docs/features/d-bus/accessing_dbus_interfaces/)) | **Separate Plasma adapter.** Plain QtQuick subcomponents may be shared; DMS/Quickshell host objects and imports cannot. |
| GNOME Shell | Extensions are GJS/JavaScript using GNOME platform APIs, not QML ([GNOME extensions](https://gjs.guide/extensions/)) | ZIP with required `metadata.json` and `extension.js`; user/system extension directories and GNOME Extensions website ([extension anatomy](https://gjs.guide/extensions/overview/anatomy.html)) | GJS/GNOME platform APIs; a portable integration can instead call a tokitoki CLI or use session D-Bus | **Incompatible native UI ABI.** Requires a GJS adapter or external app/indicator. GNOME 45 also made older extension imports incompatible ([GNOME 45 developer notes](https://release.gnome.org/45/developers/)). |
| COSMIC | Rust `libcosmic`/iced applet; upstream template starts `cosmic::applet::run` ([COSMIC applet template](https://github.com/pop-os/cosmic-applet-template), [libcosmic](https://github.com/pop-os/libcosmic)) | Cargo-built/installable applet; template includes release, install, and vendoring recipes ([template README](https://github.com/pop-os/cosmic-applet-template/blob/main/README.md)) | Best treated as a standalone process using the shared CLI/D-Bus contract | **Incompatible with QML.** Requires a Rust/libcosmic adapter. |
| Waybar (relevant alternate bar host) | No QML plugin API; `custom/*` executes a script and renders text/JSON | User Waybar configuration plus executable script | Polling, continuous stdout, click commands, and real-time signals; JSON fields include text, tooltip, class, and percentage ([upstream custom module contract](https://github.com/Alexays/Waybar/blob/master/man/waybar-custom.5.scd)) | **No QML reuse.** A JSON-producing tokitoki command is the appropriate adapter. |

## What can actually be shared

### QML and Quickshell family

DMS is built on Quickshell and exposes a first-class QML plugin system. Its
manifest and base components are DMS-specific, however: for example,
`PluginComponent` supplies bar/control-center behavior and DMS persistence,
while the documented widget examples import `qs.Common`, `qs.Widgets`, and
`qs.Modules.Plugins` ([DMS development guide](https://danklinux.com/docs/dankmaterialshell/plugin-development/)).

Quickshell itself supports ordinary reusable QML components and per-monitor
composition through `Component`/`Variants`, and supplies generic `Process` and
`IpcHandler` objects ([Quickshell reusable components](https://quickshell.org/docs/v0.3.0/guide/introduction/), [Quickshell I/O](https://quickshell.org/docs/v0.3.0/types/Quickshell.Io/)).
That makes a small, dependency-light QML view model or visual component
portable between a standalone Quickshell config and DMS. It does not make a
DMS plugin loadable by KDE Plasma or by current Noctalia.

Packaging also constrains reuse. Quickshell currently statically links its QML
modules and requires private Qt APIs; upstream says it must be rebuilt against
each Qt release to avoid ABI crashes ([Quickshell build instructions](https://github.com/quickshell-mirror/quickshell/blob/master/BUILD.md)).
Therefore a shared QML file should not import private or host-provided modules
unless the adapter owns that runtime and pins its compatible Quickshell/Qt
package.

### Cross-host process and IPC boundary

The most portable integration is not an embedded widget but a process contract:
each host can invoke a command, consume JSON, or communicate over the session
bus. DMS exposes a CLI IPC namespace, Noctalia v5 exposes `noctalia msg`,
Quickshell exposes `qs ipc` and `Process`, KDE documents D-Bus method/signal
access, and Waybar explicitly consumes executable stdout/JSON. The common
contract should carry versioned, host-neutral data such as usage totals,
limits, status text, tooltip text, and actions; host adapters translate those
fields into their own lifecycle and visual API.

## Hard incompatibilities and risks

1. **Current Noctalia is not QML-extensible.** Its supported plugin API is
   Luau, with `plugin.toml`, per-entry VMs, and declarative UI calls. Reusing a
   QML file would mean bypassing its plugin API and launching a separate
   Quickshell process, which is a different product surface.
2. **Host imports are not portable.** `PluginComponent`, DMS `PluginService`,
   DMS theme objects, Noctalia's injected APIs, Quickshell `PanelWindow`, and
   Plasma's `PlasmoidItem`/`plasmoid` are different types and lifecycles.
3. **Packaging is host-specific.** DMS and Noctalia use different manifests,
   source registries, and user-data roots; Plasma uses KPackage metadata and
   Plasma directories; GNOME uses extension ZIPs; COSMIC compiles a Rust
   applet. A single archive cannot be installed natively by all of them.
4. **Runtime/ABI drift is real.** Quickshell is pre-1.0, uses private Qt APIs,
   and statically links QML modules; DMS and Noctalia also evolve their host
   APIs. Pin host versions and declare minimum API/runtime versions.
5. **Security and lifecycle differ.** DMS documents that plugins run with full
   desktop-session permissions ([DMS plugin overview](https://danklinux.com/docs/dankmaterialshell/plugins-overview/)); Noctalia calls installed plugins trusted user-owned scripts ([Noctalia plugin development](https://docs.noctalia.dev/noctalia/plugins/development/)). External-process integration reduces embedding assumptions but does not remove the need to validate commands, paths, and untrusted data.

## Recommendation for tokitoki

1. Keep the canonical implementation in the existing headless TypeScript/Bun
   core. Define one versioned JSON payload and command surface around
   `tokitoki widget-payload --cached --json`; do not make QML the source of truth.
2. Ship native adapters only where they have clear user value:
   - DMS: a thin QML `PluginComponent` adapter.
   - Quickshell: optionally publish a dependency-light standalone QML config
     or component adapter, without DMS-private imports.
   - Noctalia v5: a separate Luau plugin using `noctalia.*`/`barWidget.*`.
   - KDE Plasma 6: a separate `PlasmoidItem` package.
   - GNOME, COSMIC, and Waybar: use a GJS, Rust/libcosmic, or JSON custom
     module adapter respectively, or expose the headless command only.
3. Prefer CLI/stdout JSON first, then add a session D-Bus service only if
   polling is insufficient. This lets DMS, Quickshell, Plasma, GNOME, COSMIC,
   Waybar, and the planned Electrobun menubar consume the same data without
   coupling their UI toolkits.
4. Treat “one QML integration everywhere” as a rejected architecture. The
   sustainable goal is one data/domain implementation plus thin, independently
   versioned shell integrations.
