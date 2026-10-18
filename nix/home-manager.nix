{ packages }:
{
  config,
  lib,
  pkgs,
  options,
  ...
}:
let
  cfg = config.programs.tokitoki;
  hasDms = options ? programs.dank-material-shell.enable;
  linux = pkgs.stdenv.hostPlatform.isLinux;
  launcher = pkgs.writeShellApplication {
    name = "tokitoki-quickshell";
    runtimeInputs = [
      cfg.package
      cfg.quickshell.package
      pkgs.coreutils
    ];
    text = ''
      exec qs -p ${cfg.package}/share/tokitoki/integrations/quickshell/tokitoki "$@"
    '';
  };
  addWidget =
    bar:
    let
      sections = [
        "leftWidgets"
        "centerWidgets"
        "rightWidgets"
      ];
      contains = lib.any (
        section:
        lib.any (widget: (if builtins.isString widget then widget else widget.id or "") == "tokitoki") (
          bar.${section} or [ ]
        )
      ) sections;
    in
    if contains || !(bar.enabled or true) then
      bar
    else
      bar
      // {
        ${cfg.dms.barSection} = (bar.${cfg.dms.barSection} or [ ]) ++ [
          {
            id = "tokitoki";
            enabled = true;
          }
        ];
      };
  defaultBar = {
    id = "default";
    name = "Main Bar";
    enabled = true;
    position = 0;
    screenPreferences = [ "all" ];
    leftWidgets = [
      "launcherButton"
      "workspaceSwitcher"
      "focusedWindow"
    ];
    centerWidgets = [ "clock" ];
    rightWidgets = [
      "systemTray"
      "notificationButton"
      "battery"
      "controlCenterButton"
    ];
  };
in
{
  options.programs.tokitoki = {
    enable = lib.mkEnableOption "Tokitoki";
    package = lib.mkOption {
      type = lib.types.package;
      default = packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Tokitoki CLI and integration assets.";
    };
    dms = {
      enable = lib.mkEnableOption "the Tokitoki DankMaterialShell plugin";
      addToBar = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Add Tokitoki to enabled declarative DankBar layouts. Makes DMS settings managed by Home Manager.";
      };
      barSection = lib.mkOption {
        type = lib.types.enum [
          "leftWidgets"
          "centerWidgets"
          "rightWidgets"
        ];
        default = "rightWidgets";
        description = "DankBar section receiving the widget when it is absent from the bar.";
      };
    };
    serve = {
      enable = lib.mkEnableOption "the read-only Tokitoki HTTP API (`tokitoki serve`) as a user service";
      port = lib.mkOption {
        type = lib.types.port;
        default = 6736;
        description = "Port for /v1/limits, /v1/usage and /v1/status.";
      };
      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Bind address. Anything other than loopback exposes your usage data to the network.";
      };
    };
    quickshell = {
      enable = lib.mkEnableOption "the Tokitoki Quickshell widget";
      package = lib.mkOption {
        type = lib.types.package;
        default = pkgs.quickshell;
        description = "Quickshell runtime for the standalone launcher.";
      };
      mode = lib.mkOption {
        type = lib.types.enum [
          "standalone"
          "embedded"
        ];
        default = "standalone";
        description = "Start a separate bar, or expose components for an existing Quickshell configuration.";
      };
      configName = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Existing Quickshell configuration receiving the Tokitoki component directory. Empty means the default config root.";
      };
      systemd = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = cfg.quickshell.mode == "standalone";
          description = "Start the standalone widget with the graphical session.";
        };
        target = lib.mkOption {
          type = lib.types.str;
          default = config.wayland.systemd.target;
          defaultText = lib.literalExpression "config.wayland.systemd.target";
          description = "Graphical session target that starts and stops the widget.";
        };
      };
    };
  };

  # Transform the merged DMS settings so existing bars and widgets survive.
  options.programs.dank-material-shell = {
    settings = lib.mkOption {
      apply =
        settings:
        if cfg.enable && cfg.dms.enable && cfg.dms.addToBar then
          settings
          // {
            barConfigsVersion = settings.barConfigsVersion or 1;
            barConfigs = map addWidget (settings.barConfigs or [ defaultBar ]);
          }
        else
          settings;
    };
  };

  config = lib.mkMerge [
    {
      programs.tokitoki.enable = lib.mkDefault (cfg.dms.enable || cfg.quickshell.enable || cfg.serve.enable);
    }
    (lib.mkIf cfg.enable {
      home.packages = [ cfg.package ] ++ lib.optional (linux && cfg.quickshell.enable) launcher;
      assertions = [
        {
          assertion = !(cfg.dms.enable || cfg.quickshell.enable) || linux;
          message = "Tokitoki shell integrations require Linux/Wayland.";
        }
        {
          assertion = !cfg.dms.enable || hasDms;
          message = "Import the DMS Home Manager module before enabling programs.tokitoki.dms.enable.";
        }
        {
          assertion =
            !cfg.quickshell.enable || cfg.quickshell.mode != "embedded" || !cfg.quickshell.systemd.enable;
          message = "Tokitoki embedded mode uses your existing shell; disable quickshell.systemd.enable.";
        }
      ];
      xdg.configFile."quickshell/${
        lib.optionalString (cfg.quickshell.configName != "") "${cfg.quickshell.configName}/"
      }Tokitoki" =
        lib.mkIf (cfg.quickshell.enable && cfg.quickshell.mode == "embedded") {
          source = "${cfg.package}/share/tokitoki/qml/Tokitoki";
        };
      systemd.user.services.tokitoki-quickshell =
        lib.mkIf (linux && cfg.quickshell.enable && cfg.quickshell.systemd.enable)
          {
            Unit = {
              Description = "Tokitoki usage widget";
              PartOf = [ cfg.quickshell.systemd.target ];
              After = [ cfg.quickshell.systemd.target ];
              ConditionEnvironment = "WAYLAND_DISPLAY";
            };
            Service = {
              ExecStart = "${lib.getExe launcher} --no-duplicate";
              Restart = "on-failure";
              RestartSec = 2;
            };
            Install.WantedBy = [ cfg.quickshell.systemd.target ];
          };
      systemd.user.services.tokitoki-serve = lib.mkIf (linux && cfg.serve.enable) {
        Unit.Description = "Tokitoki read-only usage API";
        Service = {
          ExecStart = "${lib.getExe cfg.package} serve --port ${toString cfg.serve.port} --host ${cfg.serve.host}";
          Restart = "on-failure";
          RestartSec = 5;
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
    (lib.optionalAttrs hasDms {
      programs.dank-material-shell = lib.mkIf (cfg.enable && cfg.dms.enable) {
        plugins.tokitoki = {
          enable = true;
          src = "${cfg.package}/share/tokitoki/integrations/dms/tokitoki";
          settings.executablePath = lib.getExe cfg.package;
        };
      };
      assertions = lib.optional (cfg.enable && cfg.dms.enable) {
        assertion = config.programs.dank-material-shell.enable;
        message = "Enable your existing programs.dank-material-shell setup to host Tokitoki.";
      };
    })
  ];
}
