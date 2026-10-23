{
  pkgs,
  home-manager,
  module,
}:
let
  inherit (pkgs) lib;
  dmsLock = (builtins.fromJSON (builtins.readFile ../e2e/flake.lock)).nodes.dms.locked;
  dmsSource = builtins.fetchTree dmsLock;
  evaluate =
    extra:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        module
        {
          home.username = "test";
          home.homeDirectory = "/home/test";
          home.stateVersion = "26.05";
        }
      ]
      ++ extra;
    };
  dmsModule = {
    imports = [
      (
        {
          config,
          lib,
          pkgs,
          ...
        }:
        import "${dmsSource}/distro/nix/home.nix" {
          inherit config lib pkgs;
          dmsPkgs.dms-shell = pkgs.hello;
        }
      )
    ];
    programs.dank-material-shell.enable = true;
    programs.dank-material-shell.package = pkgs.hello;
  };
  cli = (evaluate [ { programs.tokitoki.enable = true; } ]).config;
  standalone = (evaluate [ { programs.tokitoki.quickshell.enable = true; } ]).config;
  embedded =
    (evaluate [
      {
        programs.tokitoki.quickshell = {
          enable = true;
          mode = "embedded";
        };
      }
    ]).config;
  missingDms = builtins.tryEval (
    (evaluate [ { programs.tokitoki.dms.enable = true; } ]).config.programs.tokitoki.enable
  );
  dms =
    (evaluate [
      dmsModule
      {
        programs.tokitoki.dms.enable = true;
        programs.dank-material-shell.settings = {
          theme = "existing-theme";
          barConfigs = [
            {
              id = "main";
              leftWidgets = [ "clock" ];
              rightWidgets = [ "systemTray" ];
            }
            {
              id = "custom";
              centerWidgets = [
                {
                  id = "tokitoki";
                  enabled = true;
                }
              ];
            }
            {
              id = "off";
              enabled = false;
            }
          ];
        };
      }
    ]).config;
  oldDms = builtins.tryEval (
    (evaluate [
      dmsModule
      {
        programs.tokitoki.dms.enable = true;
        programs.dank-material-shell.package = lib.mkForce (
          pkgs.hello.overrideAttrs (_: {
            version = "1.6.0";
            __intentionallyOverridingVersion = true;
          })
        );
      }
    ]).config.programs.tokitoki.enable
  );
  defaultDms =
    (evaluate [
      dmsModule
      { programs.tokitoki.dms.enable = true; }
    ]).config;
  manualDms =
    (evaluate [
      dmsModule
      {
        programs.tokitoki.dms = {
          enable = true;
          addToBar = false;
        };
      }
    ]).config;
  served =
    (evaluate [
      {
        programs.tokitoki.serve = {
          enable = true;
          port = 7000;
        };
      }
    ]).config;
  timed =
    (evaluate [
      {
        programs.tokitoki.notify.enable = true;
        programs.tokitoki.poll = {
          enable = true;
          interval = "30min";
        };
      }
    ]).config;
  serveService = served.systemd.user.services.tokitoki-serve;
  service = standalone.systemd.user.services.tokitoki-quickshell;
  bars = dms.programs.dank-material-shell.settings.barConfigs;
  success = cfg: lib.all (entry: entry.assertion) cfg.assertions;
in
assert success cli;
assert success standalone;
assert success embedded;
assert success dms;
assert !oldDms.success;
assert success defaultDms;
assert success manualDms;
assert success served;
assert served.programs.tokitoki.enable;
assert lib.hasSuffix " serve --port 7000 --host 127.0.0.1" (
  builtins.head serveService.Service.ExecStart
);
assert serveService.Install.WantedBy == [ "default.target" ];
assert success timed;
assert timed.programs.tokitoki.enable;
assert lib.hasSuffix "/bin/tokitoki-notify" (
  builtins.head timed.systemd.user.services.tokitoki-notify.Service.ExecStart
);
assert timed.systemd.user.timers.tokitoki-notify.Timer.OnUnitActiveSec == "5min";
assert
  timed.systemd.user.timers.tokitoki-notify.Install.WantedBy == [ timed.wayland.systemd.target ];
assert lib.hasSuffix " poll" (
  builtins.head timed.systemd.user.services.tokitoki-poll.Service.ExecStart
);
assert timed.systemd.user.timers.tokitoki-poll.Timer.OnUnitActiveSec == "30min";
assert timed.systemd.user.timers.tokitoki-poll.Install.WantedBy == [ "timers.target" ];
assert cli.systemd.user.timers == { };
assert !(served.systemd.user.services ? tokitoki-quickshell);
assert !(standalone.systemd.user.services ? tokitoki-serve);
assert !missingDms.success;
assert cli.systemd.user.services == { };
assert standalone.programs.tokitoki.enable;
assert service.Unit.PartOf == [ standalone.wayland.systemd.target ];
assert service.Install.WantedBy == [ standalone.wayland.systemd.target ];
assert service.Service.Restart == "on-failure";
assert lib.hasSuffix " --no-duplicate" (builtins.head service.Service.ExecStart);
assert embedded.systemd.user.services == { };
assert embedded.xdg.configFile ? "quickshell/Tokitoki";
assert dms.programs.dank-material-shell.managePluginSettings;
assert dms.xdg.configFile ? "dms/plugins/tokitoki";
assert dms.xdg.configFile ? "dms/plugin_settings.json";
assert dms.xdg.configFile ? "dms/settings.json";
assert !(dms.xdg.configFile ? "DankMaterialShell/plugins/tokitoki");
assert
  dms.programs.dank-material-shell.plugins.tokitoki.settings.executablePath
  == lib.getExe dms.programs.tokitoki.package;
assert dms.programs.dank-material-shell.settings.theme == "existing-theme";
assert
  (builtins.elemAt bars 0).rightWidgets == [
    "systemTray"
    {
      id = "tokitoki";
      enabled = true;
    }
  ];
assert (builtins.elemAt bars 0).leftWidgets == [ "clock" ];
assert !(builtins.elemAt bars 1 ? rightWidgets);
assert !(builtins.elemAt bars 2 ? rightWidgets);
assert builtins.length defaultDms.programs.dank-material-shell.settings.barConfigs == 1;
assert manualDms.programs.dank-material-shell.settings == { };
pkgs.runCommand "tokitoki-home-manager-tests" { } ''
  touch "$out"
''
