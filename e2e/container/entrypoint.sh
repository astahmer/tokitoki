#!/bin/sh
set -eu

E2E_MODE="${E2E_MODE:-single}"
E2E_TAB="${E2E_TAB:-overview}"
E2E_OUT="${E2E_OUT:-/out}"
RUNTIME=/tmp/e2e-runtime
CONFIG="$HOME/.config/DankMaterialShell"
state_dir="$HOME/.local/state/DankMaterialShell/plugins"
state_file="$state_dir/tokitoki_state.json"
E2E_COMMAND_LOG="$E2E_OUT/cli-invocations.jsonl"
export E2E_COMMAND_LOG

case "$E2E_MODE" in
  all|single) ;;
  *) echo "e2e: unknown mode '$E2E_MODE' (expected all or single)" >&2; exit 2 ;;
esac
case "$E2E_TAB" in
  overview|quotas|tokens|reports|sessions|sources|mcp|settings) ;;
  *) echo "e2e: unknown tab '$E2E_TAB'" >&2; exit 2 ;;
esac

export XDG_RUNTIME_DIR="$RUNTIME"
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=sway
export XDG_SESSION_DESKTOP=sway
export WLR_BACKENDS=headless
export WLR_LIBINPUT_NO_DEVICES=1
export WLR_RENDERER=pixman
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
export QT_QPA_PLATFORM=wayland
export QT_QUICK_BACKEND=software
export PATH="/opt/e2e/bin:$PATH"

mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$E2E_OUT" "$CONFIG/plugins" "$state_dir"
mkdir -p "$E2E_OUT/previews"
chmod 700 "$XDG_RUNTIME_DIR"
: > "$E2E_COMMAND_LOG"
fixture_latest_day=$(jq -r '[.rows[].lastRequestAt[0:10]] | max' /opt/e2e/fixtures/sessions.json)
fixture_epoch=$(date -u -d "$fixture_latest_day" +%s)
today_epoch=$(date -u -d "$(date -u +%F)" +%s)
export E2E_DATE_SHIFT_SECONDS=$((today_epoch - fixture_epoch))

dms_share="$(dirname "$(readlink -f "$(command -v dms)")")/../share/quickshell/dms"
changelog_version="$(sed -n 's/.*currentVersion: *"\([^"]*\)".*/\1/p' "$dms_share/Services/ChangelogService.qml" 2>/dev/null | head -1)"
[ -n "$changelog_version" ] && touch "$CONFIG/.changelog-$changelog_version"

cp -r /opt/e2e/dms/. "$CONFIG/"
ln -sfn "${E2E_PLUGIN_DIR:-/opt/e2e/plugin}" "$CONFIG/plugins/tokitoki"
jq --arg tab "$E2E_TAB" \
  '.tokitoki = ((.tokitoki // {}) + {enabled: true, openingTab: $tab})' \
  "$CONFIG/plugin_settings.json" > "$CONFIG/plugin_settings.json.next"
mv "$CONFIG/plugin_settings.json.next" "$CONFIG/plugin_settings.json"
printf '{"selectedTab":"%s"}\n' "$E2E_TAB" > "$state_file"

sway -c /opt/e2e/sway.conf >/tmp/sway.log 2>&1 &
SWAY_PID=$!
DMS_PID=
POINTER_PID=
cleanup() {
  [ -n "$DMS_PID" ] && kill "$DMS_PID" 2>/dev/null || true
  [ -n "$POINTER_PID" ] && kill "$POINTER_PID" 2>/dev/null || true
  kill "$SWAY_PID" 2>/dev/null || true
  sleep 0.2
  [ -f /tmp/dms.log ] && cp /tmp/dms.log "$E2E_OUT/dms.log" || true
  [ -f /tmp/dms.out ] && cp /tmp/dms.out "$E2E_OUT/dms.out" || true
  [ -f /tmp/sway.log ] && cp /tmp/sway.log "$E2E_OUT/sway.log" || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for() {
  limit=$1
  label=$2
  shift 2
  i=0
  while ! "$@" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "$((limit * 5))" ]; then
      echo "e2e: timed out waiting for $label" >&2
      tail -n 60 /tmp/sway.log /tmp/dms.log /tmp/dms.out 2>/dev/null >&2 || true
      exit 1
    fi
    sleep 0.2
  done
}

wait_for_tab() {
  tab=$1
  i=0
  while [ "$i" -lt 50 ]; do
    current="$(jq -r '.selectedTab // ""' "$state_file" 2>/dev/null || true)"
    [ "$current" = "$tab" ] && return 0
    i=$((i + 1))
    sleep 0.2
  done
  echo "e2e: tab click did not select '$tab' (state: $current)" >&2
  grim -c "$E2E_OUT/failure-tab-$tab.png"
  exit 1
}

pointer_x=0
pointer_y=0
move_pointer_to() {
  target_x=$1
  target_y=$2
  delta_x=$((target_x - pointer_x))
  delta_y=$((target_y - pointer_y))
  wlrctl pointer move "$delta_x" "$delta_y"
  pointer_x=$target_x
  pointer_y=$target_y
  sleep 0.05
}

click_at() {
  move_pointer_to "$1" "$2"
  wlrctl pointer click left
  sleep 0.15
}

select_tab() {
  tab=$1
  scroll_up 30
  case "$tab" in
    overview) x=60 ;;
    quotas) x=130 ;;
    tokens) x=193 ;;
    reports) x=256 ;;
    sessions) x=326 ;;
    sources) x=397 ;;
    mcp) x=456 ;;
    settings) x=55 ;;
  esac
  if [ "$tab" = settings ]; then
    click_at "$x" 235
  else
    click_at "$x" 203
  fi
  wait_for_tab "$tab"
}

scroll_down() {
  count=$1
  move_pointer_to 250 500
  i=0
  while [ "$i" -lt "$count" ]; do
    wlrctl pointer scroll 120 0
    i=$((i + 1))
  done
  sleep 0.5
}

scroll_up() {
  count=$1
  move_pointer_to 250 500
  i=0
  while [ "$i" -lt "$count" ]; do
    wlrctl pointer scroll -120 0
    i=$((i + 1))
  done
  sleep 0.5
}

wait_for_log_growth() {
  previous=$1
  label=$2
  i=0
  while [ "$(wc -l < "$E2E_COMMAND_LOG")" -le "$previous" ]; do
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
      echo "e2e: timed out waiting for $label" >&2
      exit 1
    fi
    sleep 0.2
  done
}

capture() {
  sleep 0.35
  grim "$E2E_OUT/$1"
  grim -g '0,0 540x870' "$E2E_OUT/previews/$1"
}

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

sway_socket=
i=0
while [ -z "$sway_socket" ]; do
  sway_socket=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'sway-ipc.*.sock' -print -quit 2>/dev/null)
  [ -n "$sway_socket" ] && break
  i=$((i + 1))
  if [ "$i" -gt 150 ]; then
    echo "e2e: timed out waiting for sway IPC socket" >&2
    tail -n 60 /tmp/sway.log >&2 || true
    exit 1
  fi
  sleep 0.2
done
export SWAYSOCK="$sway_socket"
WLRCTL_HOLD=1 wlrctl pointer move 0 0 &
POINTER_PID=$!
sleep 0.2
wlrctl pointer move -1600 -1000
pointer_x=0
pointer_y=0

dms run --log-file /tmp/dms.log >/tmp/dms.out 2>&1 &
DMS_PID=$!
wait_for 90 "dms ipc" dms ipc call plugins list
wait_for 30 "initial widget payload" grep -Fq '"widget-payload"' "$E2E_COMMAND_LOG"
grim -g "0,0 1600x44" "$E2E_OUT/bar.png"
dms ipc call widget toggle tokitoki >/dev/null
sleep 0.5

if [ "$E2E_MODE" = single ]; then
  capture "popout-$E2E_TAB.png"
  printf '{"mode":"single","tabs":["%s"]}\n' "$E2E_TAB" > "$E2E_OUT/index.json"
else
  for tab in overview quotas tokens reports sessions sources mcp settings; do
    select_tab "$tab"
    capture "tab-$tab.png"
  done

  select_tab tokens
  scroll_down 5
  capture tokens-lower.png
  select_tab reports
  scroll_down 5
  capture reports-lower.png

  select_tab sessions
  click_at 250 157
  wtype -s 200 needle
  wait_for 20 "session search command" grep -Fq '"--search","needle"' "$E2E_COMMAND_LOG"
  capture sessions-search.png

  click_at 220 390
  wait_for 20 "session detail command" grep -Fq '"--session","e2e-session-001"' "$E2E_COMMAND_LOG"
  capture sessions-detail.png
  click_at 65 326
  capture sessions-back.png

  before="$(wc -l < "$E2E_COMMAND_LOG")"
  click_at 487 157
  wait_for_log_growth "$before" "unfiltered session list after clearing search"
  scroll_down 30
  capture sessions-pagination.png
  before="$(wc -l < "$E2E_COMMAND_LOG")"
  click_at 195 775
  wait_for_log_growth "$before" "session page two command"
  wait_for 10 "page two argument" grep -Fq '"--page","2"' "$E2E_COMMAND_LOG"
  capture sessions-page-2.png
  scroll_up 30
  before="$(wc -l < "$E2E_COMMAND_LOG")"
  click_at 66 445
  wait_for_log_growth "$before" "session previous-page command"
  capture sessions-page-1-return.png

  select_tab settings
  capture settings-tab.png
  click_at 465 76
  capture settings-config.png
  click_at 465 76
  select_tab settings
  click_at 455 584
  wait_for 20 "notification setting write" grep -Fq '"config","set","notifications.enabled","true"' "$E2E_COMMAND_LOG"
  scroll_down 6
  capture settings-notifications.png
  cat > "$E2E_OUT/index.json" <<'JSON'
{"mode":"all","tabs":["overview","quotas","tokens","reports","sessions","sources","mcp","settings"],"interactions":["search","session-detail","session-back","next-page","previous-page","settings-config","settings-notifications"]}
JSON
fi

sleep 0.5
qml_error_pattern='component error .*tokitoki|Tokitoki.*is not a type|QQml.*(error|failed|not ready)|(^|[[:space:]])(TypeError|ReferenceError|SyntaxError):|\.qml:[0-9]+(:[0-9]+)?:.*(error|syntax|unavailable|not a type|failed|cannot assign|referenceerror|typeerror)'
if grep -Eih "$qml_error_pattern" /tmp/dms.log /tmp/dms.out /tmp/sway.log 2>/dev/null; then
  echo "e2e: FAIL - QML runtime error detected; logs are in $E2E_OUT" >&2
  exit 1
fi

echo "e2e: wrote screenshots and interaction log under $E2E_OUT"
