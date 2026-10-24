#!/bin/sh
set -eu
. /tmp/native-env
wait_for() {
  i=0
  until "$@"; do i=$((i+1)); [ "$i" -lt 80 ] || { echo "Timed out: $*" >&2; exit 1; }; sleep 0.1; done
}
state() { "$NOCTALIA_BIN" msg plugin tokitoki/usage:usage all e2e-state "$1"; }
capture() { sleep 0.4; grim "/out/$1.png"; }
capture_plasma() {
  capture "$1"
  region=$(node --input-type=module -e 'import fs from "node:fs"; const s=JSON.parse(fs.readFileSync("/out/plasma-states.jsonl","utf8").trim().split("\n").at(-1)).bounds; console.log(`${Math.max(0,s.x-12)},${Math.max(0,s.y-12)} ${Math.min(1600-s.x+12,s.width+24)}x${Math.min(1000-s.y+12,s.height+24)}`)')
  grim -g "$region" "/out/$1-widget.png"
}
"$NOCTALIA_BIN" >/out/noctalia.log 2>&1 &
wait_for test -S "$XDG_RUNTIME_DIR/noctalia-$WAYLAND_DISPLAY.sock"
wait_for sh -c 'grep -q "IPC socket" /out/noctalia.log'
sleep 1
state shortest
capture noctalia-shortest
wlrctl pointer move -10000 -10000
wlrctl pointer move 120 20
sleep 0.2
wlrctl pointer click left
capture noctalia-details
wlrctl pointer move -10000 -10000
wlrctl pointer move 700 450
sleep 0.3
wlrctl pointer scroll 900 0
sleep 0.8
capture noctalia-details-lower
swaymsg output HEADLESS-1 resolution 960x540 >/out/noctalia-short-output.json
sleep 0.3
"$NOCTALIA_BIN" msg panel-open tokitoki/usage:details
capture noctalia-short-screen
swaymsg output HEADLESS-1 resolution 1600x1000 >/dev/null
# Native pointer hover over the real bar opens the host tooltip.
"$NOCTALIA_BIN" msg panel-close tokitoki/usage:details
wlrctl pointer move -10000 -10000
wlrctl pointer move 180 20
sleep 1
capture noctalia-hover
cat >> "$HOME/.config/noctalia/config.toml" <<'TOML'
[plugin_settings."tokitoki/usage"]
display_mode = "quotas"
accounts = ["codex@evvi", "codex@work", "cursor@personal"]
TOML
"$NOCTALIA_BIN" msg config-reload
sleep 1
state quotas
capture noctalia-all-windows
sed -i 's/display_mode = "quotas"/display_mode = "shortest"/; s/accounts = \[.*/accounts = ["codex@work", "cursor@personal"]/' "$HOME/.config/noctalia/config.toml"
"$NOCTALIA_BIN" msg config-reload
sleep 1
state selected
capture noctalia-selected
sed -i 's/display_mode = "shortest"/display_mode = "total"/' "$HOME/.config/noctalia/config.toml"
"$NOCTALIA_BIN" msg config-reload
sleep 1
state total
capture noctalia-totals
jq '.failure=true' /tmp/native-payload.json >/tmp/next.json
mv /tmp/next.json /tmp/native-payload.json
"$NOCTALIA_BIN" msg plugin tokitoki/usage:usage all e2e-refresh test
sleep 0.5
state failure
capture noctalia-error
jq 'del(.failure)' /tmp/native-payload.json >/tmp/next.json
mv /tmp/next.json /tmp/native-payload.json
"$NOCTALIA_BIN" msg plugin tokitoki/usage:usage all e2e-refresh test
sleep 0.5
state recovered
pkill -x .noctalia-wrapp || pkill -f "bin/.noctalia-wrapped"
sleep 0.5
"$PLASMA_BIN" -a /tmp/native-plasma -c org.kde.desktopcontainment -l floating -f planar -s 520x780 >/out/plasma.log 2>&1 &
wait_for test -f /out/plasma-states.jsonl
sleep 1
capture_plasma plasma-details
node /repo/e2e/native/control.mjs '{"mode":"shortest","accounts":"codex@work,cursor@personal"}'
sleep 1
capture_plasma plasma-selected
node /repo/e2e/native/control.mjs '{"mode":"quotas","accounts":"","configure":true}'
sleep 1
capture plasma-settings
# The viewer form-factor menu is the native host's panel-mode switch.
# A second invocation starts the actual compact representation in a horizontal panel.
pkill plasmoidviewer
sleep 0.4
node /repo/e2e/native/control.mjs '{"mode":"shortest","accounts":"","expanded":false}'
"$PLASMA_BIN" -a /tmp/native-plasma -c org.kde.desktopcontainment -l topedge -f horizontal -s 1500x44 >/out/plasma-panel.log 2>&1 &
sleep 1
node /repo/e2e/native/control.mjs '{"mode":"shortest","accounts":"","expanded":false}'
sleep 1
capture_plasma plasma-shortest
node /repo/e2e/native/control.mjs '{"mode":"quotas"}'
sleep 1
capture_plasma plasma-all-windows
jq '.failure=true' /tmp/native-payload.json >/tmp/next.json
mv /tmp/next.json /tmp/native-payload.json
node /repo/e2e/native/control.mjs '{"refresh":true}'
sleep 1
capture_plasma plasma-error
jq 'del(.failure)' /tmp/native-payload.json >/tmp/next.json
mv /tmp/next.json /tmp/native-payload.json
node /repo/e2e/native/control.mjs '{"refresh":true,"mode":"total"}'
sleep 1
capture_plasma plasma-totals
node /repo/e2e/assert.mjs /out/noctalia-details.png --size 1600x1000 --region "540,48 520x720"
node /repo/e2e/assert.mjs /out/noctalia-short-screen.png --size 960x540 --region "220,8 520x524"
for file in /out/plasma-*-widget.png; do node /repo/e2e/assert.mjs "$file"; done
node /repo/e2e/native/check.mjs
