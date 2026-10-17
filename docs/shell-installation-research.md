# Installing shell integrations in an existing setup

Checked: 2026-10-18.

## Recommended paths

For DMS, install the CLI and expose `integrations/dms/tokitoki` as a plugin
directory. DMS documents discovering plugins under
`~/.config/DankMaterialShell/plugins`, enabling them in Settings and adding
widget plugins to DankBar. Its Home Manager module also accepts a plugin
`src`, so a pinned Tokitoki flake input can supply that subdirectory directly
([installation overview](https://danklinux.com/docs/dankmaterialshell/plugins-overview/),
[Home Manager source installation](https://danklinux.com/docs/dankmaterialshell/nixos-flake/#plugins)).

The installed CLI's `dms plugins install --help` specifies a registry plugin
ID. Do not document a GitHub tree URL as an install argument. A directory
link or Home Manager source works without registering Tokitoki upstream.

For standalone Quickshell, use the existing Tokitoki flake app:
`nix run github:astahmer/tokitoki#quickshell`. The repository's `flake.nix`
wrapper supplies the CLI, runtime and integration files. The Home Manager
module now exposes `dms.enable` and `quickshell.enable` under
`programs.tokitoki`, while `enable` alone remains the CLI-only installation.

Quickshell supports selecting an independent config with `qs -p <path>`.
This permits launching Tokitoki alongside an existing shell
([configuration guide](https://quickshell.org/docs/v0.3.0/guide/introduction/)).
The installed `qs --help` also confirms `--no-duplicate` for session startup.
Tokitoki's `shell.qml` creates a top bar per screen; its controller loads the
shared DMS views. The package also prepares a portable component directory,
rewriting host-specific imports to relative imports. Embedded mode symlinks
that directory inside the selected Quickshell configuration and starts no
service. Quickshell's scanner requires the imported files to be inside the
configuration tree; the Docker test covers this using a symlink and a host
theme with a different API.

## User-facing instructions

The copyable installation, Home Manager, update and startup recipes are in
[`integrations/README.md`](../integrations/README.md#add-to-an-existing-setup).
Verification covers real Home Manager/DMS module evaluation, the package
build, and Docker UI scenarios. No install or restart was performed in the
user's desktop session. DMS layout insertion transforms merged declarative
settings; existing GUI-managed settings must be migrated or automatic
placement disabled.
