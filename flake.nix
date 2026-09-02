{
  description = "Development environment for tokitoki";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              cacert
              direnv
              git
              jq
              pnpm
              ripgrep
            ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
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
        });
    };
}
