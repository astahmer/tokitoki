#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${E2E_OUT_DIR:-/tmp/tokitoki-native-e2e}
mkdir -p "$out"
noctalia=$(nix build 'github:noctalia-dev/noctalia/42c5d09a10f5642fd30fbdb0ded503c0098e6f22#default' --option substituters https://cache.nixos.org --no-link --print-out-paths)
plasma=$(nix build --inputs-from "$repo/e2e" nixpkgs#kdePackages.plasma-sdk --option substituters https://cache.nixos.org --no-link --print-out-paths)
desktop=$(nix build --inputs-from "$repo/e2e" nixpkgs#kdePackages.plasma-desktop --option substituters https://cache.nixos.org --no-link --print-out-paths)
mounts=()
while IFS= read -r item; do mounts+=(-v "${item}:${item}:ro"); done < <(nix-store -qR "$noctalia" "$plasma" "$desktop")
docker run -d --name tokitoki-native-e2e --tmpfs /tmp:rw,nosuid,size=768m \
  -e "NOCTALIA_BIN=$noctalia/bin/noctalia" -e "PLASMA_BIN=$plasma/bin/plasmoidviewer" -e "PLASMA_DATA=$desktop/share" \
  -v "$repo:/repo:ro" -v "$out:/out" "${mounts[@]}" \
  "${E2E_IMAGE:-tokitoki-e2e:latest}" dbus-run-session -- /repo/e2e/native/boot.sh
