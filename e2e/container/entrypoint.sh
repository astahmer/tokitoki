#!/bin/sh
set -eu

E2E_MODE="${E2E_MODE:-single}"
E2E_SHELL="${E2E_SHELL:-dms}"
E2E_TAB="${E2E_TAB:-overview}"
E2E_OUT="${E2E_OUT:-/out}"
RUNTIME=/tmp/e2e-runtime
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_CONFIG_HOME XDG_STATE_HOME XDG_CACHE_HOME
CONFIG="$XDG_CONFIG_HOME/dms"
state_dir="$XDG_STATE_HOME/dms/plugins"
state_file="$state_dir/tokitoki_state.json"
QS_CONFIG_FILE="$XDG_CONFIG_HOME/tokitoki/quickshell.json"
QS_STATE_FILE="$XDG_STATE_HOME/tokitoki/quickshell-state.json"
E2E_QUICKSHELL_DIR="${E2E_QUICKSHELL_DIR:-/integrations-src/quickshell/tokitoki}"
E2E_COMMAND_LOG="$E2E_OUT/cli-invocations.jsonl"
E2E_STATE_LOG="$E2E_OUT/state-interactions.jsonl"
E2E_SHELL_IPC_LOG="$E2E_OUT/quickshell-ipc.jsonl"
export E2E_COMMAND_LOG

case "$E2E_SHELL" in
  dms|quickshell) ;;
  *) echo "e2e: unknown shell '$E2E_SHELL' (expected dms or quickshell)" >&2; exit 2 ;;
esac
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
export NO_COLOR=1
export PATH="/opt/e2e/bin:$PATH"

mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$E2E_OUT" "$XDG_CACHE_HOME/fontconfig"
sed "s|<cachedir>/var/cache/fontconfig</cachedir>|<cachedir>$XDG_CACHE_HOME/fontconfig</cachedir>|" /etc/fonts/fonts.conf > /tmp/e2e-fonts.conf
export FONTCONFIG_FILE=/tmp/e2e-fonts.conf
fc-match 'DejaVu Sans' > "$E2E_OUT/fonts.log"
fc-match 'DejaVu Sans Mono' >> "$E2E_OUT/fonts.log"
mkdir -p "$E2E_OUT/previews"
rm -f "$E2E_OUT/index.json" "$E2E_OUT/index.pending.json" "$E2E_OUT/quickshell-before-restart.log"
: > "$E2E_OUT/interactions.jsonl"
chmod 700 "$XDG_RUNTIME_DIR"
rm -f /out/ui-prefs.json /out/refresh-next /out/refresh-results.log
: > "$E2E_COMMAND_LOG"
: > "$E2E_STATE_LOG"
: > "$E2E_SHELL_IPC_LOG"
fixture_latest_day=$(jq -r '[.rows[].lastRequestAt[0:10]] | max' /opt/e2e/fixtures/sessions.json)
fixture_epoch=$(date -u -d "$fixture_latest_day" +%s)
today_epoch=$(date -u -d "$(date -u +%F)" +%s)
export E2E_DATE_SHIFT_SECONDS=$((today_epoch - fixture_epoch))

if [ "$E2E_SHELL" = dms ]; then
  mkdir -p "$CONFIG/plugins" "$state_dir"
  dms_share="$(dirname "$(readlink -f "$(command -v dms)")")/../share/quickshell/dms"
  changelog_version="$(sed -n 's/.*currentVersion: *"\([^"]*\)".*/\1/p' "$dms_share/Services/ChangelogService.qml" 2>/dev/null | head -1)"
  [ -n "$changelog_version" ] && touch "$CONFIG/.changelog-$changelog_version"

  cp -r /opt/e2e/dms/. "$CONFIG/"
  cp -R "${E2E_PLUGIN_DIR:-/opt/e2e/plugin}" /tmp/e2e-plugin
  # Keep inspection in the fixture: production plugins need no testing IPC.
  node --input-type=module - /tmp/e2e-plugin/TokitokiWidget.qml <<'JS'
import fs from "node:fs";
const file = process.argv[2];
const source = fs.readFileSync(file, "utf8")
  .replace("readonly property bool tooltipOpen: root.openTooltipProvider === String(groupData.provider)", "readonly property bool tooltipOpen: root.openTooltipProvider === String(groupData.provider)\n                    onTooltipOpenChanged: if (tooltipOpen) root.e2eHoverGroup = providerGroup")
  .replace("id: clearSearch", "id: clearSearch\n                                    Component.onCompleted: root.e2eClearSearch = clearSearch")
  .replace("TokitokiSessionsView {", "TokitokiSessionsView {\n                                    Component.onCompleted: root.e2eSessionsView = this")
  .replace("TokitokiNotifications {", "TokitokiNotifications {\n                                    Component.onCompleted: root.e2eNotifications = this")
  .replace('tooltipText: root.configOpen ?', 'Component.onCompleted: root.e2eSettingsButton = this\n                        tooltipText: root.configOpen ?');
const directory = file.slice(0, file.lastIndexOf("/"));
const sessionsFile = directory + "/TokitokiSessionsView.qml";
fs.writeFileSync(sessionsFile, fs.readFileSync(sessionsFile, "utf8")
  .replace("id: root", "id: root\n    property alias e2ePrevious: testPrevious\n    property alias e2eNext: testNext")
  .replace('label: "Previous"', 'id: testPrevious\n                label: "Previous"')
  .replace('label: "Next"', 'id: testNext\n                label: "Next"'));
const notificationsFile = directory + "/TokitokiNotifications.qml";
fs.writeFileSync(notificationsFile, fs.readFileSync(notificationsFile, "utf8")
  .replace("id: root", "id: root\n    property alias e2eToggle: testNotificationsToggle")
  .replace('label: "Allow notifications"', 'id: testNotificationsToggle\n            label: "Allow notifications"'));
const hook = `
    property var e2eClearSearch: null
    property var e2eHoverGroup: null
    property var e2eSessionsView: null
    property var e2eNotifications: null
    property var e2eSettingsButton: null
    IpcHandler {
        target: "tokitoki-e2e"
        function advanceBarClock(): string {
            root.barNow += 60000;
            return String(root.barNow);
        }
        function hoverState(): string {
            return JSON.stringify({ open: Boolean(root.e2eHoverGroup && root.e2eHoverGroup.tooltipOpen) });
        }
        function controlGeometry(name: string): string {
            var controls = { clearSearch: root.e2eClearSearch,
                previous: root.e2eSessionsView ? root.e2eSessionsView.e2ePrevious : null,
                next: root.e2eSessionsView ? root.e2eSessionsView.e2eNext : null,
                notifications: root.e2eNotifications ? root.e2eNotifications.e2eToggle : null,
                settings: root.e2eSettingsButton };
            var item = controls[name];
            if (!item || !item.visible)
                return "{}";
            var window = item.QsWindow.window;
            var center = window.mapFromItem(item, item.width / 2, item.height / 2);
            // Qt cannot infer a layer surface's compositor position; use its anchors/margins.
            var x = window.anchors.left ? window.margins.left : window.screen.width - window.width - window.margins.right;
            var y = window.anchors.top ? window.margins.top : window.screen.height - window.height - window.margins.bottom;
            return JSON.stringify({ x: Math.round(x + center.x), y: Math.round(y + center.y) });
        }
        function geometry(): string {
            var popout = Array.from(root.children).find(function(child) {
                return child.alignedX !== undefined && child.shouldBeVisible !== undefined;
            });
            return JSON.stringify({ ready: root.hasPayload && !root.isBusy,
                x: popout ? Math.round(popout.alignedX) : null,
                y: popout ? Math.round(popout.alignedY) : null });
        }
    }
`;
const end = source.lastIndexOf("}");
fs.writeFileSync(file, source.slice(0, end) + hook + source.slice(end));
JS
  node /opt/e2e/instrument-surfaces.mjs /tmp/e2e-plugin/TokitokiWidget.qml
  ln -sfn /tmp/e2e-plugin "$CONFIG/plugins/tokitoki"
  jq --arg tab "$E2E_TAB" \
    '.tokitoki = ((.tokitoki // {}) + {enabled: true, openingTab: $tab})' \
    "$CONFIG/plugin_settings.json" > "$CONFIG/plugin_settings.json.next"
  mv "$CONFIG/plugin_settings.json.next" "$CONFIG/plugin_settings.json"
  printf '{"selectedTab":"%s"}\n' "$E2E_TAB" > "$state_file"
else
  if [ "${E2E_QUICKSHELL_MODE:-standalone}" = embedded ]; then
    E2E_QUICKSHELL_DIR=/tmp/tokitoki-host
    mkdir -p "$E2E_QUICKSHELL_DIR"
    cp -R /opt/e2e/embedded/. "$E2E_QUICKSHELL_DIR/"
    sh /integrations-src/quickshell/prepare-components.sh /integrations-src /tmp/tokitoki-components
    node /opt/e2e/instrument-surfaces.mjs /tmp/tokitoki-components/views/TokitokiWidget.qml
    ln -s /tmp/tokitoki-components "$E2E_QUICKSHELL_DIR/Tokitoki"
  else
    E2E_QUICKSHELL_DIR=/tmp/tokitoki-components
    sh /integrations-src/quickshell/prepare-components.sh /integrations-src "$E2E_QUICKSHELL_DIR"
    node /opt/e2e/instrument-surfaces.mjs "$E2E_QUICKSHELL_DIR/views/TokitokiWidget.qml"
  fi
  mkdir -p "$(dirname "$QS_CONFIG_FILE")" "$(dirname "$QS_STATE_FILE")"
  printf '{"autoRefreshEnabled":true}\n' > "$QS_CONFIG_FILE"
  printf '{"selectedTab":"%s"}\n' "$E2E_TAB" > "$QS_STATE_FILE"
fi

sway -c /opt/e2e/sway.conf >/tmp/sway.log 2>&1 &
SWAY_PID=$!
DMS_PID=
QS_PID=
POINTER_PID=
qml_error_pattern='component error .*tokitoki|Tokitoki.*is not a type|QQml.*(error|failed|not ready)|(^|[[:space:]])(TypeError|ReferenceError|SyntaxError):|\.qml:[0-9]+(:[0-9]+)?:.*(error|syntax|unavailable|not a type|failed|cannot assign|referenceerror|typeerror)|Failed to load configuration|Error loading configuration'
check_shell() {
  if [ "$E2E_SHELL" = quickshell ]; then
    if ! kill -0 "$QS_PID" 2>/dev/null || grep -Ei "$qml_error_pattern|Unable to assign|Binding loop" /tmp/quickshell.log >/dev/null 2>&1 || grep -E '^[[:space:]]*ERROR([[:space:]]|:)' /tmp/quickshell.log >/dev/null 2>&1; then
      echo "e2e: standalone Quickshell failed" >&2
      tail -n 60 /tmp/quickshell.log >&2
      grim "$E2E_OUT/failure-runtime.png" 2>/dev/null || true
      exit 1
    fi
  fi
}
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    grim "$E2E_OUT/failure.png" 2>/dev/null || true
  fi
  [ -n "$DMS_PID" ] && kill "$DMS_PID" 2>/dev/null || true
  [ -n "$QS_PID" ] && kill "$QS_PID" 2>/dev/null || true
  [ -n "$POINTER_PID" ] && kill "$POINTER_PID" 2>/dev/null || true
  kill "$SWAY_PID" 2>/dev/null || true
  sleep 0.2
  [ -f /tmp/dms.log ] && cp /tmp/dms.log "$E2E_OUT/dms.log" || true
  [ -f /tmp/dms.out ] && cp /tmp/dms.out "$E2E_OUT/dms.out" || true
  [ -f /tmp/quickshell.log ] && cp /tmp/quickshell.log "$E2E_OUT/quickshell.log" || true
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
    check_shell
    i=$((i + 1))
    if [ "$i" -gt "$((limit * 5))" ]; then
      echo "e2e: timed out waiting for $label" >&2
      tail -n 60 /tmp/sway.log /tmp/dms.log /tmp/dms.out /tmp/quickshell.log 2>/dev/null >&2 || true
      exit 1
    fi
    sleep 0.2
  done
}

wait_for_tab() {
  tab=$1
  i=0
  while [ "$i" -lt 50 ]; do
    check_shell
    if [ "$E2E_SHELL" = quickshell ]; then
      current="$(read_shell_selected_tab || true)"
    else
      current="$(jq -r '.selectedTab // ""' "$state_file" 2>/dev/null || true)"
    fi
    if [ "$current" = "$tab" ]; then
      source=state-file
      [ "$E2E_SHELL" = quickshell ] && source=ipc-status
      jq -cn --arg shell "$E2E_SHELL" --arg tab "$tab" --arg source "$source" \
        '{shell:$shell, expected:$tab, actual:$tab, source:$source}' >> "$E2E_STATE_LOG"
      return 0
    fi
    i=$((i + 1))
    sleep 0.2
  done
  echo "e2e: tab click did not select '$tab' (state: $current)" >&2
  grim -c "$E2E_OUT/failure-tab-$tab.png"
  exit 1
}

shell_ipc() {
  method=$1
  shift
  argument="${1:-}"
  if response="$(timeout 5 qs -p "$E2E_QUICKSHELL_DIR" ipc call tokitoki "$method" "$@" 2>&1)"; then
    jq -cn --arg method "$method" --arg argument "$argument" --arg response "$response" \
      '{method:$method, argument:$argument, response:$response, ok:true}' >> "$E2E_SHELL_IPC_LOG"
    printf '%s\n' "$response"
  else
    jq -cn --arg method "$method" --arg argument "$argument" --arg response "$response" \
      '{method:$method, argument:$argument, response:$response, ok:false}' >> "$E2E_SHELL_IPC_LOG"
    printf '%s\n' "$response" >&2
    return 1
  fi
}

read_shell_selected_tab() {
  response="$(shell_ipc status)"
  selected="$(printf '%s\n' "$response" | jq -r '
    if type == "object" then .selectedTab // ""
    elif type == "string" then
      try (fromjson | if type == "object" then .selectedTab // "" else . end) catch .
    else "" end
  ' 2>/dev/null || true)"
  case "$selected" in
    *selectedTab*)
      selected="$(printf '%s\n' "$response" | sed -n 's/.*"selectedTab"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
      ;;
  esac
  printf '%s\n' "$selected"
}

pointer_x=0
pointer_y=0
popout_offset_x=0
popout_offset_y=0
move_pointer_to() {
  target_x=$(($1 + popout_offset_x))
  target_y=$(($2 + popout_offset_y))
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

click_dms_control() {
  control_geometry=$(dms ipc call tokitoki-e2e controlGeometry "$1")
  printf '%s\n' "$control_geometry" > "$E2E_OUT/control-$1-geometry.json"
  control_x=$(printf '%s' "$control_geometry" | jq -er '.x')
  control_y=$(printf '%s' "$control_geometry" | jq -er '.y')
  click_at "$((control_x - popout_offset_x))" "$((control_y - popout_offset_y))"
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
    check_shell
    i=$((i + 1))
    if [ "$i" -gt 100 ]; then
      echo "e2e: timed out waiting for $label" >&2
      exit 1
    fi
    sleep 0.2
  done
}

record_interaction() {
  jq -cn --arg interaction "$1" '{interaction:$interaction}' >> "$E2E_OUT/interactions.jsonl"
}

status_matches() {
  shell_ipc status | jq -e "$1"
}

capture() {
  check_shell
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

if [ "$E2E_SHELL" = dms ]; then
  dms run --log-file /tmp/dms.log >/tmp/dms.out 2>&1 &
  DMS_PID=$!
  wait_for 90 "dms ipc" dms ipc call plugins list
else
  qs -p "$E2E_QUICKSHELL_DIR" >/tmp/quickshell.log 2>&1 &
  QS_PID=$!
  wait_for 15 "Quickshell IPC status" shell_ipc status
  qs_args="$(ps -p "$QS_PID" -o args= 2>/dev/null || true)"
  case "$qs_args" in
    *"$E2E_QUICKSHELL_DIR"*) ;;
    *) echo "e2e: Quickshell is not running the mounted standalone config: $qs_args" >&2; exit 1 ;;
  esac
  if pgrep -x dms >/dev/null 2>&1 || pgrep -x dms-shell >/dev/null 2>&1 || [ -e "$CONFIG" ]; then
    echo "e2e: standalone Quickshell run started DMS or created DMS configuration" >&2
    ps -eo pid,comm,args >&2
    exit 1
  fi
  jq -cn '{shell:"quickshell",dmsRunning:false,dmsConfigExists:false}' > "$E2E_OUT/runtime.json"
fi
wait_for 30 "initial widget payload" grep -Fq '"widget-payload"' "$E2E_COMMAND_LOG"
if [ "$E2E_SHELL" = quickshell ]; then
  wait_for 15 "standalone payload cards ready" status_matches '.ready == true and .hasPayload == true and .isBusy == false'
fi
if [ "$E2E_SHELL" = dms ]; then
  wait_for 15 "DMS payload ready" sh -c 'dms ipc call tokitoki-e2e geometry | jq -e ".ready == true"'
fi
grim -g "0,0 1600x44" "$E2E_OUT/bar.png"
if [ "$E2E_SHELL" = dms ] && [ "$E2E_MODE" = all ]; then
  move_pointer_to 70 24
  wait_for 5 "quota hover opens" sh -c 'dms ipc call tokitoki-e2e hoverState | jq -e ".open == true"'
  move_pointer_to 100 90
  sleep 0.3
  dms ipc call tokitoki-e2e hoverState | jq -e '.open == true' >/dev/null
  grim -c "$E2E_OUT/hover-before-tick.png"
  dms ipc call tokitoki-e2e advanceBarClock > "$E2E_OUT/hover-clock.txt"
  sleep 0.3
  dms ipc call tokitoki-e2e hoverState > "$E2E_OUT/hover-after-tick.json"
  jq -e '.open == true' "$E2E_OUT/hover-after-tick.json" >/dev/null
  grim -c "$E2E_OUT/hover-after-tick.png"
  record_interaction hover-countdown
  move_pointer_to 1500 900
  sleep 0.3
fi
if [ "$E2E_SHELL" = dms ]; then
  dms ipc call widget toggle tokitoki >/dev/null
else
  shell_ipc open "$E2E_TAB" >/dev/null
  wait_for_tab "$E2E_TAB"
fi
sleep 0.5
if [ "$E2E_SHELL" = dms ]; then
  popout_geometry=$(dms ipc call tokitoki-e2e geometry)
  printf '%s\n' "$popout_geometry" > "$E2E_OUT/popout-geometry.json"
  popout_x=$(printf '%s' "$popout_geometry" | jq -er '.x')
  popout_y=$(printf '%s' "$popout_geometry" | jq -er '.y')
  popout_offset_x=$((popout_x - 4))
  popout_offset_y=$((popout_y - 48))
fi

if [ "$E2E_MODE" = single ]; then
  capture "popout-$E2E_TAB.png"
  printf '{"mode":"single","shell":"%s","tabs":["%s"]}\n' "$E2E_SHELL" "$E2E_TAB" > "$E2E_OUT/index.pending.json"
else
  for tab in overview quotas tokens reports sessions sources mcp settings; do
    select_tab "$tab"
    capture "tab-$tab.png"
  done

  select_tab quotas
  scroll_down 30
  capture quotas-lower.png
  . /opt/e2e/surface-scenario.sh
  select_tab tokens
  scroll_down 5
  capture tokens-lower.png
  scroll_down 4
  capture tokens-models.png
  scroll_up 30
  click_at 250 157
  wtype -s 200 tracking
  sleep 0.5
  capture tracking-quality.png
  record_interaction tracking-quality
  if [ "$E2E_SHELL" = dms ]; then
    click_dms_control clearSearch
  else
    click_at 487 157
  fi
  select_tab reports
  scroll_down 5
  capture reports-lower.png

  select_tab sessions
  click_at 250 157
  wtype -s 200 needle
  wait_for 20 "session search command" grep -Fq '"--search","needle"' "$E2E_COMMAND_LOG"
  record_interaction search
  capture sessions-search.png

  click_at 220 390
  wait_for 20 "session detail command" grep -Fq '"--session","e2e-session-001"' "$E2E_COMMAND_LOG"
  record_interaction session-detail
  capture sessions-detail.png
  click_at 65 326
  capture sessions-back.png
  record_interaction session-back

  before="$(wc -l < "$E2E_COMMAND_LOG")"
  if [ "$E2E_SHELL" = dms ]; then
    click_dms_control clearSearch
  else
    click_at 487 157
  fi
  wait_for_log_growth "$before" "unfiltered session list after clearing search"
  scroll_down 30
  capture sessions-pagination.png
  before="$(wc -l < "$E2E_COMMAND_LOG")"
  if [ "$E2E_SHELL" = dms ]; then
    click_dms_control next
  else
    click_at 195 775
  fi
  wait_for_log_growth "$before" "session page two command"
  wait_for 10 "page two argument" grep -Fq '"--page","2"' "$E2E_COMMAND_LOG"
  record_interaction next-page
  capture sessions-page-2.png
  scroll_up 30
  before="$(wc -l < "$E2E_COMMAND_LOG")"
  if [ "$E2E_SHELL" = dms ]; then
    click_dms_control previous
  else
    click_at 66 445
  fi
  wait_for_log_growth "$before" "session previous-page command"
  wait_for 10 "page one after page two" sh -c 'tail -n +"$1" "$2" | grep -F "\"--page\",\"1\"" | grep -vq -- --search' sh "$((before + 1))" "$E2E_COMMAND_LOG"
  record_interaction previous-page
  capture sessions-page-1-return.png

  select_tab settings
  capture settings-tab.png
  if [ "$E2E_SHELL" = dms ]; then
    click_dms_control settings
  else
    click_at 465 76
  fi
  if [ "$E2E_SHELL" = quickshell ]; then
    wait_for 5 "widget settings open" status_matches '.configOpen == true'
  fi
  capture settings-config.png
  if [ "$E2E_SHELL" = dms ]; then
    click_dms_control settings
  else
    click_at 465 76
  fi
  if [ "$E2E_SHELL" = quickshell ]; then
    wait_for 5 "widget settings closed" status_matches '.configOpen == false'
  fi
  record_interaction settings-config
  select_tab settings
  if [ "$E2E_SHELL" = quickshell ]; then
    click_at 460 560
  else
    click_dms_control notifications
  fi
  wait_for 20 "notification setting write" grep -Fq '"config","set","notifications.enabled","true"' "$E2E_COMMAND_LOG"
  scroll_down 6
  capture settings-notifications.png
  record_interaction settings-notifications
  if [ "$E2E_SHELL" = quickshell ]; then
    scroll_up 30
    click_at 465 76
    wait_for 5 "widget settings open" status_matches '.configOpen == true'
    capture widget-config-before.png
    click_at 470 216
    wait_for 5 "widget auto refresh setting write" jq -e '.autoRefreshEnabled == false' "$QS_CONFIG_FILE"
    record_interaction widget-config-write
    cp "$QS_CONFIG_FILE" "$E2E_OUT/config-before-restart.json"
    click_at 465 76
    wait_for 5 "widget settings closed" status_matches '.configOpen == false'
    select_tab tokens
    wait_for 5 "saved selected tab" jq -e '.selectedTab == "tokens"' "$QS_STATE_FILE"
    cp "$QS_STATE_FILE" "$E2E_OUT/state-before-restart.json"
    old_pid=$QS_PID
    check_shell
    kill "$QS_PID"
    wait "$QS_PID" || true
    cp /tmp/quickshell.log "$E2E_OUT/quickshell-before-restart.log"
    qs -p "$E2E_QUICKSHELL_DIR" >/tmp/quickshell.log 2>&1 &
    QS_PID=$!
    wait_for 15 "restarted Quickshell IPC" shell_ipc status
    wait_for 15 "restored widget settings, tab and payload" status_matches '.selectedTab == "tokens" and .autoRefreshEnabled == false and .hasPayload == true and .isBusy == false'
    shell_ipc status > "$E2E_OUT/status-after-restart.json"
    cp "$QS_CONFIG_FILE" "$E2E_OUT/config-after-restart.json"
    cp "$QS_STATE_FILE" "$E2E_OUT/state-after-restart.json"
    jq -cn --argjson before "$old_pid" --argjson after "$QS_PID" '{beforePid:$before,afterPid:$after}' > "$E2E_OUT/restart.json"
    shell_ipc toggle >/dev/null
    wait_for 5 "toggle opens popup" status_matches '.visible == true'
    capture after-restart.png
    shell_ipc close >/dev/null
    wait_for 5 "close hides popup" status_matches '.visible == false'
    shell_ipc open tokens >/dev/null
    wait_for 5 "open restores tokens popup" status_matches '.visible == true and .selectedTab == "tokens"'
    record_interaction restart-persistence

    swaymsg create_output > "$E2E_OUT/output-create.json"
    swaymsg output HEADLESS-2 resolution 960x540 position 1600 0 > "$E2E_OUT/output-configure.json"
    swaymsg output HEADLESS-1 position 0 0 > "$E2E_OUT/output-primary.json"
    wait_for 5 "two positioned outputs" sh -c 'swaymsg -t get_outputs | jq -e '\''any(.[]; .name == "HEADLESS-1" and .rect.x == 0 and .rect.y == 0) and any(.[]; .name == "HEADLESS-2" and .rect.x == 1600 and .rect.y == 0 and .rect.width == 960 and .rect.height == 540)'\'''
    swaymsg -t get_outputs > "$E2E_OUT/outputs.json"
    shell_ipc close >/dev/null
    wlrctl pointer move -10000 -10000
    pointer_x=0
    pointer_y=0
    sleep 0.3
    click_at 80 22
    wait_for 5 "bar opens on first screen" status_matches '.visible == true and .screen == "HEADLESS-1"'
    click_at 1680 22
    wait_for 5 "bar transfers popup to second screen" status_matches '.visible == true and .screen == "HEADLESS-2"'
    record_interaction multi-screen-transfer
    wait_for 5 "popup fits short output" status_matches '.popupGeometry.y + .popupGeometry.height <= 540 and .popupGeometry.x + .popupGeometry.width <= 960'
    shell_ipc status > "$E2E_OUT/status-short-screen.json"
    grim -o HEADLESS-2 "$E2E_OUT/short-screen.png"
    record_interaction short-screen-fit
    click_at 1680 22
    wait_for 5 "same bar closes popup" status_matches '.visible == false'
    record_interaction bar-toggle
    click_at 1680 22
    wait_for 5 "same bar reopens popup" status_matches '.visible == true'
    wtype -s 200 -k Escape
    wait_for 5 "Escape closes popup" status_matches '.visible == false'
    record_interaction escape-close
    click_at 1680 22
    wait_for 5 "bar reopens after Escape" status_matches '.visible == true'
    click_at 2400 400
    wait_for 5 "outside click closes popup" status_matches '.visible == false'
    record_interaction outside-close
  fi
  jq -n --arg shell "$E2E_SHELL" --slurpfile states "$E2E_STATE_LOG" \
    --slurpfile actions "$E2E_OUT/interactions.jsonl" \
    '{mode:"all",shell:$shell,tabs:[$states[(if $shell == "quickshell" then 1 else 0 end):(if $shell == "quickshell" then 9 else 8 end)][].actual],interactions:[$actions[].interaction]}' > "$E2E_OUT/index.pending.json"
fi

sleep 0.5
check_shell
if grep -Eih "$qml_error_pattern" /tmp/dms.log /tmp/dms.out /tmp/sway.log /tmp/quickshell.log "$E2E_OUT/quickshell-before-restart.log" 2>/dev/null; then
  grim "$E2E_OUT/failure-runtime.png"
  echo "e2e: FAIL - QML runtime error detected; logs are in $E2E_OUT" >&2
  exit 1
fi

mv "$E2E_OUT/index.pending.json" "$E2E_OUT/index.json"

echo "e2e: wrote screenshots and interaction log under $E2E_OUT"
