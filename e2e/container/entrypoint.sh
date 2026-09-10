#!/bin/sh
# Headless DMS + tokitoki screenshot harness.
#
# Boots sway (wlroots headless) on llvmpipe, starts the real DMS shell with the
# tokitoki plugin pointed at fixture data, then captures the bar and the widget
# popout into $E2E_OUT. See e2e/README.md.
set -eu

E2E_TAB="${E2E_TAB:-overview}"
E2E_OUT="${E2E_OUT:-/out}"
RUNTIME=/tmp/e2e-runtime
CONFIG="$HOME/.config/DankMaterialShell"

export XDG_RUNTIME_DIR="$RUNTIME"
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=sway
export XDG_SESSION_DESKTOP=sway
# CI/desktop boxes have no /dev/dri, so wlroots' GLES2 renderer cannot start
# ("no DRM FD available"). pixman draws the compositor in software; the Qt
# client still gets GL through mesa's llvmpipe EGL.
export WLR_BACKENDS=headless
export WLR_LIBINPUT_NO_DEVICES=1
export WLR_RENDERER=pixman
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export QT_QPA_PLATFORM=wayland
export QT_QUICK_BACKEND=software
export PATH="/opt/e2e/bin:$PATH"

mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$E2E_OUT" "$CONFIG/plugins"
chmod 700 "$XDG_RUNTIME_DIR"

# DMS pops a first-run "What's New" window that would sit on top of every
# screenshot. It is suppressed by a versioned marker file whose name we read
# from the shell itself so a DMS bump does not silently reintroduce it.
dms_share="$(dirname "$(readlink -f "$(command -v dms)")")/../share/quickshell/dms"
changelog_version="$(sed -n 's/.*currentVersion: *"\([^"]*\)".*/\1/p' "$dms_share/Services/ChangelogService.qml" 2>/dev/null | head -1)"
[ -n "$changelog_version" ] && touch "$CONFIG/.changelog-$changelog_version"

# Seed the DMS config: a bar holding only the tokitoki widget, the plugin
# symlinked in, and the fixture shim first on PATH so the widget's Process
# calls read fixtures instead of the real CLI.
cp -r /opt/e2e/dms/. "$CONFIG/"
# E2E_PLUGIN_DIR points at a bind mount of the live working tree, so the
# harness tests uncommitted QML (Nix only sees git-tracked files).
ln -sfn "${E2E_PLUGIN_DIR:-/opt/e2e/plugin}" "$CONFIG/plugins/tokitoki"
jq --arg tab "$E2E_TAB" \
  '.tokitoki = ((.tokitoki // {}) + {enabled: true, openingTab: $tab})' \
  "$CONFIG/plugin_settings.json" > "$CONFIG/plugin_settings.json.next"
mv "$CONFIG/plugin_settings.json.next" "$CONFIG/plugin_settings.json"

# `openingTab` only covers overview/quotas/tokens; the widget restores its tab
# from DMS' per-plugin state file, which is what lets the harness open any of
# the eight tabs directly.
state_dir="$HOME/.local/state/DankMaterialShell/plugins"
mkdir -p "$state_dir"
printf '{"selectedTab":"%s"}\n' "$E2E_TAB" > "$state_dir/tokitoki_state.json"

sway -c /opt/e2e/sway.conf >/tmp/sway.log 2>&1 &
SWAY_PID=$!
DMS_PID=
cleanup() {
  [ -n "$DMS_PID" ] && kill "$DMS_PID" 2>/dev/null || true
  kill "$SWAY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() {
  # wait_for <timeout-seconds> <label> <command...>
  limit=$1
  label=$2
  shift 2
  i=0
  while ! "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "$((limit * 5))" ]; then
      echo "e2e: timed out waiting for $label" >&2
      tail -n 60 /tmp/sway.log /tmp/dms.log 2>/dev/null >&2 || true
      exit 1
    fi
    sleep 0.2
  done
}

# sway names its socket wayland-<n>; discover it instead of guessing.
wayland_socket=
i=0
while [ -z "$wayland_socket" ]; do
  wayland_socket=$(ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep '^wayland-' | grep -v '\.lock$' | head -1)
  [ -n "$wayland_socket" ] && break
  i=$((i + 1))
  if [ "$i" -gt 150 ]; then
    echo "e2e: timed out waiting for sway wayland socket" >&2
    tail -n 60 /tmp/sway.log >&2 || true
    exit 1
  fi
  sleep 0.2
done
export WAYLAND_DISPLAY="$wayland_socket"

dms run --log-file /tmp/dms.log >/tmp/dms.out 2>&1 &
DMS_PID=$!
wait_for 90 "dms ipc" dms ipc call plugins list

# The bar draws as soon as the shell is up; give the plugin one payload cycle.
sleep 4

# grim rejects -o together with -g; a bare -g grabs from the (single) output.
grim -g "0,0 1600x44" "$E2E_OUT/bar.png"

dms ipc call widget toggle tokitoki >/dev/null 2>&1 || true
sleep 4
grim "$E2E_OUT/popout-$E2E_TAB.png"

{
  echo "tab=$E2E_TAB"
  ls -1 "$E2E_OUT"
} >"$E2E_OUT/index.txt"

echo "e2e: wrote $E2E_OUT/popout-$E2E_TAB.png"

# A QML component error leaves the widget silently missing from an otherwise
# healthy screenshot, so surface it as a non-zero exit for automated runs.
if grep -qE 'component error .*tokitoki|Tokitoki.*is not a type' /tmp/dms.log 2>/dev/null; then
  echo "e2e: FAIL - tokitoki QML component error:" >&2
  grep -E 'component error .*tokitoki|Tokitoki.*is not a type' /tmp/dms.log \
    | grep -v '^$' >&2
  exit 1
fi
