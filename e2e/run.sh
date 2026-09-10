#!/usr/bin/env bash
# Build the e2e image, boot it once for a given tab, and print where the
# screenshots landed.
#
#   ./e2e/run.sh                 # overview tab
#   E2E_TAB=quotas ./e2e/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tab="${E2E_TAB:-overview}"
out="$here/out"
mkdir -p "$out"

image="$(nix build --no-link --print-out-paths "$here#image")"
docker load <"$image"
# The plugin is bind-mounted from the working tree so uncommitted QML is what
# gets rendered; the image copy stays as the fallback for plain CI use.
docker run --rm \
  -e "E2E_TAB=$tab" \
  -e "E2E_PLUGIN_DIR=/plugin-src" \
  -v "$here/../integrations/dms/tokitoki:/plugin-src:ro" \
  -v "$out:/out" \
  tokitoki-e2e:latest

echo "screenshots: $out"
