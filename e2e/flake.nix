{
  description = "Headless DMS + tokitoki screenshot environment for agent-driven visual checks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    dms = {
      url = "github:AvengeMedia/DankMaterialShell/stable";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # The plugin under test: always the current checkout, not a published tag.
    tokitoki.url = "path:..";
  };

  outputs =
    inputs:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = inputs.nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = import inputs.nixpkgs { inherit system; };
          dmsShell = inputs.dms.packages.${system}.dms-shell;
          # Qt needs a stable seat capability, not devices that disappear after each click.
          persistentWlrctl = pkgs.wlrctl.overrideAttrs (previous: {
            postPatch = (previous.postPatch or "") + ''
              substituteInPlace pointer.c --replace-fail \
                'state->running = false;' \
                'if (getenv("WLRCTL_HOLD")) { return; } state->running = false;'
            '';
          });

          runtime = pkgs.buildEnv {
            name = "tokitoki-e2e-runtime";
            paths = [
              pkgs.bashInteractive
              pkgs.coreutils
              pkgs.dbus
              pkgs.dejavu_fonts
              pkgs.findutils
              pkgs.fontconfig
              pkgs.gnugrep
              pkgs.gnused
              pkgs.grim
              pkgs.jq
              pkgs.libGL
              pkgs.mesa
              pkgs.nodejs
              pkgs.noto-fonts
              pkgs.noto-fonts-color-emoji
              pkgs.procps
              # `dms run` shells out to the `qs` binary; the DMS flake no longer
              # ships it, nixpkgs does.
              pkgs.quickshell
              pkgs.qt6.qtwayland
              pkgs.sway
              pkgs.wayland-utils
              pkgs.wl-clipboard
              persistentWlrctl
              pkgs.wtype
              dmsShell
            ];
          };
        in
        {
          image = pkgs.dockerTools.buildLayeredImage {
            name = "tokitoki-e2e";
            tag = "latest";

            contents = [
              runtime
              pkgs.dockerTools.binSh
              pkgs.dockerTools.caCertificates
              pkgs.dockerTools.usrBinEnv
            ];

            extraCommands = ''
              mkdir -p etc/fonts opt/e2e/bin out tmp var/cache
              chmod 1777 tmp
              cp -r ${./container}/. opt/e2e/
              mkdir -p opt/e2e/fixtures
              cp ${./fixtures}/payload.json opt/e2e/fixtures/payload.json
              cp ${./fixtures}/sessions.json opt/e2e/fixtures/sessions.json
              # Fixture CLI shim shadows the real binary on PATH.
              cp opt/e2e/fake-tokitoki opt/e2e/bin/tokitoki
              chmod +x opt/e2e/bin/tokitoki opt/e2e/entrypoint.sh
              # The runtime env merges dbus' empty /etc stub, which makes
              # dbus-run-session unusable; swap in a real session bus config.
              rm -rf etc/dbus-1
              mkdir -p etc/dbus-1
              cp opt/e2e/dbus/session.conf etc/dbus-1/session.conf
              # buildEnv does not merge fontconfig's etc, and its stock
              # fonts.conf only knows DejaVu; list the fonts we actually ship.
              ln -sfn ${pkgs.fontconfig}/etc/fonts/conf.d etc/fonts/conf.d
              cat > etc/fonts/fonts.conf <<'FONTCONF'
              <?xml version="1.0"?>
              <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
              <fontconfig>
                <dir>${pkgs.dejavu_fonts}</dir>
                <dir>${pkgs.noto-fonts}</dir>
                <dir>${pkgs.noto-fonts-color-emoji}</dir>
                <cachedir>/var/cache/fontconfig</cachedir>
                <include ignore_missing="yes">/etc/fonts/conf.d</include>
              </fontconfig>
              FONTCONF
              # run.sh overlays this source fallback with the working tree.
              ln -s ${inputs.tokitoki}/integrations/dms/tokitoki opt/e2e/plugin
              # quickshell refuses to run as root, so the harness drops to a
              # regular uid (1000 keeps it aligned with the CI/dev user). The
              # home lives in /tmp: chown is unreliable inside the image
              # builder, and Docker already makes /tmp world-writable.
              printf 'root:x:0:0:root:/root:/bin/sh\ne2e:x:1000:1000:e2e:/tmp/e2e-home:/bin/sh\n' > etc/passwd
              printf 'root:x:0:\ne2e:x:1000:\n' > etc/group
            '';

            config = {
              Env = [
                "HOME=/tmp/e2e-home"
                "PATH=/opt/e2e/bin:${runtime}/bin:/usr/bin:/bin"
                "XDG_CONFIG_HOME=/tmp/e2e-home/.config"
                "XDG_DATA_HOME=/tmp/e2e-home/.local/share"
              ];
              User = "1000:1000";
              WorkingDir = "/tmp";
              Cmd = [
                "${pkgs.dbus}/bin/dbus-run-session"
                "--"
                "/opt/e2e/entrypoint.sh"
              ];
            };
          };

        }
      );
    };
}
