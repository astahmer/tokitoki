{
  description = "Tokitoki coding-agent usage analytics";

  inputs = {
    # 26.05 is the last nixpkgs release that supports Intel macOS.
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forEachSystem = nixpkgs.lib.genAttrs systems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      version = packageJson.version;

      sourceFor =
        pkgs:
        pkgs.lib.cleanSourceWith {
          src = ./.;
          filter =
            path: _type:
            !builtins.elem (baseNameOf path) [
              ".build"
              ".direnv"
              ".git"
              "dist"
              "node_modules"
            ];
        };

      mkTokitoki =
        pkgs:
        let
          lib = pkgs.lib;
          source = sourceFor pkgs;

          nodeModules = pkgs.stdenvNoCC.mkDerivation {
            pname = "tokitoki-node-modules";
            inherit version;
            src = source;

            __structuredAttrs = true;
            strictDeps = true;

            # Fixed-output derivations may access the registry to materialize
            # the content addressed by the hash below.
            impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [
              "GIT_PROXY_COMMAND"
              "SOCKS_SERVER"
            ];

            nativeBuildInputs = [
              pkgs.bun
              pkgs.writableTmpDirAsHomeHook
            ];

            dontConfigure = true;

            buildPhase = ''
              runHook preBuild

              export BUN_INSTALL_CACHE_DIR=$(mktemp -d)
              bun install \
                --cpu="*" \
                --os="*" \
                --frozen-lockfile \
                --ignore-scripts \
                --no-progress

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out"
              cp -R node_modules "$out/"

              runHook postInstall
            '';

            # Store paths and timestamps must not be rewritten inside this FOD.
            dontFixup = true;

            # Regenerate with `nix build .#tokitoki` if the lockfile changes.
            outputHash = "sha256-T7W2lbLp1i6XZQ8nqZJz8u6dL4cRAhdMpsUQmHcepWE=";
            outputHashAlgo = "sha256";
            outputHashMode = "recursive";
          };
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "tokitoki";
          inherit version;
          src = source;

          __structuredAttrs = true;
          strictDeps = true;

          nativeBuildInputs = [
            pkgs.bun
            pkgs.makeWrapper
            pkgs.nodejs
            pkgs.writableTmpDirAsHomeHook
          ];

          configurePhase = ''
            runHook preConfigure

            cp -R ${nodeModules}/node_modules ./node_modules
            chmod -R u+w ./node_modules
            patchShebangs ./node_modules

            runHook postConfigure
          '';

          buildPhase = ''
            runHook preBuild

            bun run web:build
            bun build --target=bun src/cli.ts --outfile dist/cli.js

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/bin" "$out/dist" "$out/share/tokitoki"
            cp -R dist/. "$out/dist/"
            cp -R integrations "$out/share/tokitoki/"
            # Keep package metadata out of the package root so this derivation
            # can coexist in Home Manager's buildEnv with other JS tools.
            install -Dm644 package.json "$out/share/tokitoki/package.json"

            makeWrapper ${lib.getExe pkgs.bun} "$out/bin/tokitoki" \
              --add-flags "$out/dist/cli.js" \
              --set TOKITOKI_VERSION "${version}"

            runHook postInstall
          '';

          doInstallCheck = true;
          nativeInstallCheckInputs = [ pkgs.versionCheckHook ];
          versionCheckProgramArg = "--version";

          passthru.nodeModules = nodeModules;

          meta = {
            description = "Unified coding-agent usage and session analytics";
            homepage = "https://github.com/astahmer/tokitoki";
            mainProgram = "tokitoki";
            platforms = systems;
            sourceProvenance = [ lib.sourceTypes.fromSource ];
          };
        };

      packages = forEachSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          tokitoki = mkTokitoki pkgs;
        in
        {
          inherit tokitoki;
          default = tokitoki;
        }
      );

      devShellFor =
        pkgs:
        pkgs.mkShell {
          packages =
            with pkgs;
            [
              bun
              cacert
              direnv
              git
              jq
              pnpm
              ripgrep
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
              swift
            ];

          shellHook = ''
            if [ "''${TOKITOKI_SKIP_INSTALL:-0}" != "1" ]; then
              if ! (
                install_lock="$PWD/.direnv/bun-install.lock"
                mkdir -p "$PWD/.direnv"
                while ! mkdir "$install_lock" 2>/dev/null; do
                  sleep 0.1
                done

                cleanup() {
                  rmdir "$install_lock" 2>/dev/null || true
                }
                trap cleanup EXIT INT TERM

                bun install --frozen-lockfile
              ); then
                echo "tokitoki: dependency installation failed" >&2
                exit 1
              fi
            fi

            echo "tokitoki dev shell: bun $(bun --version)"
          '';
        };

      homeManagerModule =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.programs.tokitoki;
        in
        {
          options.programs.tokitoki = {
            enable = lib.mkEnableOption "tokitoki";

            package = lib.mkOption {
              type = lib.types.package;
              default = packages.${pkgs.stdenv.hostPlatform.system}.default;
              description = "Tokitoki package to install.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ];
          };
        };
    in
    {
      packages = packages;

      apps = forEachSystem (system: {
        default = {
          type = "app";
          program = "${packages.${system}.default}/bin/tokitoki";
          meta.description = "Tokitoki coding-agent usage analytics";
        };
      });

      checks = forEachSystem (system: {
        package = packages.${system}.default;
      });

      overlays = {
        default = final: _prev: {
          tokitoki = packages.${final.stdenv.hostPlatform.system}.default;
        };
      };

      homeManagerModules = {
        default = homeManagerModule;
        tokitoki = homeManagerModule;
      };

      devShells = forEachSystem (system: {
        default = devShellFor (import nixpkgs { inherit system; });
      });
    };
}
