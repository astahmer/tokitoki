#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${E2E_MODE:-}" ]; then
  mode="$E2E_MODE"
elif [ -n "${E2E_TAB:-}" ]; then
  mode=single
else
  mode=all
fi
tab="${E2E_TAB:-overview}"
if [ -n "${E2E_OUT_DIR:-}" ]; then
  out="$E2E_OUT_DIR"
elif [ "$mode" = all ]; then
  out="$here/out/autonomous"
else
  out="$here/out/$tab"
fi
mkdir -p "$out"

if [ -n "${E2E_IMAGE:-}" ]; then
  image_ref="$E2E_IMAGE"
else
  build_tmp="${E2E_TMPDIR:-${TMPDIR:-/tmp}}"
  mkdir -p "$build_tmp"
  image="$(TMPDIR="$build_tmp" nix build --option substituters https://cache.nixos.org --no-link --print-out-paths "$here#image")"
  docker load <"$image"
  image_ref=tokitoki-e2e:latest
fi
docker run --rm \
  --tmpfs /tmp:rw,nosuid,size=512m \
  -e "E2E_MODE=$mode" \
  -e "E2E_TAB=$tab" \
  -e "E2E_OUT=/out" \
  -e "E2E_PLUGIN_DIR=/plugin-src" \
  -v "$here/container/entrypoint.sh:/opt/e2e/entrypoint.sh:ro" \
  -v "$here/container/fake-tokitoki:/opt/e2e/bin/tokitoki:ro" \
  -v "$here/../integrations/dms/tokitoki:/plugin-src:ro" \
  -v "$here/container/rebase-dates.jq:/opt/e2e/rebase-dates.jq:ro" \
  -v "$here/fixtures:/opt/e2e/fixtures:ro" \
  -v "$out:/out" \
  "$image_ref"

if [ "$mode" = all ]; then
  screenshots=(tab-overview tab-quotas tab-tokens tab-reports tab-sessions \
    tab-sources tab-mcp tab-settings sessions-search sessions-detail sessions-back \
    sessions-pagination sessions-page-2 sessions-page-1-return settings-tab settings-config \
    tokens-lower reports-lower settings-notifications)
  docker run --rm --entrypoint sh \
    --tmpfs /tmp:rw,nosuid,size=64m \
    -v "$here:/e2e:ro" \
    -v "$out:/out:ro" \
    "$image_ref" -c '
      set -eu
      node /e2e/assert.mjs /out/bar.png --size 1600x44
      for name do
        node /e2e/assert.mjs "/out/$name.png" --size 1600x1000 --region "0,44 540x860"
      done
      node /e2e/check-run.mjs /out
    ' sh "${screenshots[@]}"
else
  docker run --rm --entrypoint node \
    --tmpfs /tmp:rw,nosuid,size=64m \
    -v "$here:/e2e:ro" \
    -v "$out:/out:ro" \
    "$image_ref" /e2e/assert.mjs "/out/popout-$tab.png" --size 1600x1000 --region "0,44 540x860"
fi

echo "screenshots and logs: $out"
