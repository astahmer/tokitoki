#!/usr/bin/env bash
# Boot the Windows VM, install tokitoki, and check that a fresh scan reads the
# staged provider stores. setup.sh creates the VM and the profile.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
container=${TOKITOKI_WIN_CONTAINER:-tokitoki-win}
password=${TOKITOKI_WIN_PASSWORD:-admin}
windows_user=${TOKITOKI_WIN_USER:-vincent}
out_dir=${E2E_OUT_DIR:-"$root/e2e/out/windows"}

"$root/e2e/windows/setup.sh"

shared=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/shared"}}{{.Source}}{{end}}{{end}}')
if [[ -z "$shared" || ! -d "$shared" ]]; then
  echo "e2e windows: $container has no /shared mount" >&2
  exit 1
fi

stage="$shared/e2e"
mkdir -p "$stage/inbox" "$stage/out" "$out_dir"

qemu_keys() {
  if [[ $# -eq 0 ]]; then
    return 0
  fi
  printf '%s\n' "$@" | docker exec -i "$container" sh -c 'while IFS= read -r key; do printf "sendkey %s 60\n" "$key"; sleep 0.06; done | nc -U -w 2 /run/shm/monitor.sock' >/dev/null
}

key_name() {
  local char=$1
  case $char in
    ':') echo shift-semicolon ;;
    '\') echo backslash ;;
    '.') echo dot ;;
    '/') echo slash ;;
    '-') echo minus ;;
    '$') echo shift-4 ;;
    "'") echo apostrophe ;;
    ';') echo semicolon ;;
    '"') echo shift-apostrophe ;;
    '(') echo shift-9 ;;
    ')') echo shift-0 ;;
    ' ') echo spc ;;
    [[:upper:]]) echo "shift-$(printf '%s' "$char" | tr '[:upper:]' '[:lower:]')" ;;
    *) echo "$char" ;;
  esac
}

type_text() {
  local text=$1
  local index char keys=()
  for ((index = 0; index < ${#text}; index++)); do
    char=${text:index:1}
    keys+=("$(key_name "$char")")
  done
  qemu_keys "${keys[@]}"
}

start_agent_once() {
  qemu_keys esc
  sleep 0.4
  # Hold Win long enough for the shell to see it, then wait until the Run box
  # has focus. A long command matches Run history and the suggestion list eats
  # keystrokes, so the box only receives the short launcher path.
  printf 'sendkey meta_l-r 250\n' | docker exec -i "$container" sh -c 'nc -U -w 2 /run/shm/monitor.sock' >/dev/null
  sleep 2
  qemu_keys ctrl-a backspace
  sleep 0.3
  type_text 'Z:\e2e\start.bat'
  sleep 0.3
  qemu_keys ret
}

capture_guest_screen() {
  local dest=$1
  docker exec "$container" sh -c 'printf "screendump /tmp/e2e-fail.ppm\n" | nc -U -w 3 /run/shm/monitor.sock' >/dev/null || return 0
  docker cp "$container":/tmp/e2e-fail.ppm "$dest.ppm" >/dev/null || return 0
  if command -v magick >/dev/null 2>&1; then
    magick "$dest.ppm" "$dest.png" && rm -f "$dest.ppm"
  fi
}

unlock_session() {
  qemu_keys spc
  sleep 0.8
  type_text "$password"
  qemu_keys ret
  sleep 2
}

agent_alive() {
  local beat=$stage/heartbeat.txt
  [[ -f $beat ]] || return 1
  local now modified
  now=$(date +%s)
  modified=$(date -d "$(stat -c %y "$beat")" +%s)
  (( now - modified < 15 ))
}

echo "e2e windows: building the Windows executable"
mkdir -p "$out_dir"
if [[ -n ${BUN:-} ]]; then
  "$BUN" build --compile "$root/src/cli.ts" --target=bun-windows-x64 --outfile "$out_dir/tokitoki.exe"
elif command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1; then
  bun build --compile "$root/src/cli.ts" --target=bun-windows-x64 --outfile "$out_dir/tokitoki.exe"
else
  (cd "$root" && nix develop --command bun build --compile src/cli.ts --target=bun-windows-x64 --outfile "$out_dir/tokitoki.exe")
fi
# Publish the whole file in one rename so the guest never copies a partial exe.
cp -f "$out_dir/tokitoki.exe" "$stage/tokitoki.exe.next"
mv -f "$stage/tokitoki.exe.next" "$stage/tokitoki.exe"
cp -f "$root/e2e/windows/agent.ps1" "$stage/agent.ps1"
cp -f "$root/e2e/windows/start.bat" "$stage/start.bat"
# cmd.exe wants CRLF or the agent path splits.
sed -i 's/\r$//; s/$/\r/' "$stage/start.bat"

agent_hash=$(sha256sum "$root/e2e/windows/agent.ps1" | awk 'NR==1 { print $1 }')
previous_hash=$(cat "$stage/agent.sha256" 2>/dev/null || true)
if [[ $agent_hash != "$previous_hash" ]]; then
  echo "e2e windows: guest agent script changed"
  rm -f "$stage/heartbeat.txt"
fi
printf '%s\n' "$agent_hash" >"$stage/agent.sha256"

wait_for_agent() {
  local tries=$1
  local attempt
  for ((attempt = 0; attempt < tries; attempt++)); do
    if agent_alive; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

if ! agent_alive; then
  echo "e2e windows: starting the guest agent"
  rm -f "$stage/agent.started" "$stage/heartbeat.txt"
  start_agent_once
  if ! wait_for_agent 16; then
    echo "e2e windows: accepting the network file warning"
    qemu_keys left ret
    wait_for_agent 20 || true
  fi
  if ! agent_alive; then
    echo "e2e windows: agent did not start, unlocking and retrying"
    unlock_session
    start_agent_once
    if ! wait_for_agent 16; then
      qemu_keys left ret
      wait_for_agent 20 || true
    fi
  fi
  if ! agent_alive; then
    capture_guest_screen "$out_dir/agent-start-failed"
    echo "e2e windows: guest agent never wrote a heartbeat" >&2
    exit 1
  fi
fi

run_job() {
  local name=$1
  shift
  local id="${name}-$$"
  local dest="$stage/out/$id"
  local tries_limit=${JOB_TRIES:-360}
  rm -rf "$dest"
  if [[ -n ${JOB_ENV:-} ]]; then
    jq -n --argjson env "$JOB_ENV" --args '{args: $ARGS.positional, env: $env}' -- "$@" >"$stage/inbox/$id.json.tmp"
  else
    jq -n --args '{args: $ARGS.positional}' -- "$@" >"$stage/inbox/$id.json.tmp"
  fi
  mv "$stage/inbox/$id.json.tmp" "$stage/inbox/$id.json"
  local tries=0
  until [[ -f $dest/done ]]; do
    tries=$((tries + 1))
    if (( tries > tries_limit )); then
      echo "e2e windows: timed out waiting for $name" >&2
      exit 1
    fi
    sleep 0.5
  done
  cp -f "$dest/stdout.txt" "$out_dir/$name.stdout.txt"
  cp -f "$dest/stderr.txt" "$out_dir/$name.stderr.txt"
  cp -f "$dest/exit.txt" "$out_dir/$name.exit.txt"
  echo "$dest"
}

event_count() {
  local provider=$1 file=$2
  awk -v provider="$provider" '
    index($0, provider " ") == 1 { show = 1 }
    show && $1 == "events:" {
      gsub(/,/, "", $2)
      print $2
      exit
    }
  ' "$file"
}

echo "e2e windows: tokitoki --version"
version_dir=$(run_job version --version)
version_exit=$(tr -d '\r' <"$version_dir/exit.txt")
if [[ $version_exit != 0 ]]; then
  echo "e2e windows: --version failed" >&2
  cat "$version_dir/stderr.txt" >&2
  exit 1
fi
grep -q 'tokitoki v' "$version_dir/stdout.txt"

echo "e2e windows: tokitoki sources"
sources_dir=$(run_job sources sources)
sources_exit=$(tr -d '\r' <"$sources_dir/exit.txt")
if [[ $sources_exit != 0 ]]; then
  echo "e2e windows: sources failed" >&2
  cat "$sources_dir/stderr.txt" >&2
  exit 1
fi
sources_out=$sources_dir/stdout.txt
grep -q 'claude-code' "$sources_out"
grep -F "Users\\${windows_user}\\.claude" "$sources_out"
grep -F "Users\\${windows_user}\\.codex" "$sources_out"
grep -F 'Roaming\Cursor' "$sources_out"
grep -F 'share\opencode' "$sources_out"

echo "e2e windows: sources see the Windows profile"

# A directory this process has never written, so event totals cannot come from
# the cache copied with the profile.
scan_dir="C:\\Users\\${windows_user}\\AppData\\Local\\tokitoki\\e2e-scan-$$"
JOB_ENV=$(jq -n --arg dir "$scan_dir" '{TOKITOKI_DATA_DIR: $dir}')
export JOB_ENV
echo "e2e windows: scanning into a fresh data dir"
for provider in claude-code opencode codex cursor; do
  echo "e2e windows: scan $provider"
  JOB_TRIES=2400
  scan_result=$(run_job "scan-$provider" scan --provider "$provider")
  scan_exit=$(tr -d '\r' <"$scan_result/exit.txt")
  if [[ $scan_exit != 0 ]]; then
    echo "e2e windows: scan $provider failed" >&2
    cat "$scan_result/stderr.txt" >&2
    exit 1
  fi
  if ! grep -Eq "^${provider}: \\+[1-9][0-9]* events" "$scan_result/stdout.txt"; then
    echo "e2e windows: scan $provider produced no events" >&2
    cat "$scan_result/stdout.txt" >&2
    cat "$scan_result/stderr.txt" >&2
    exit 1
  fi
  echo "  $(tr -d '\r' <"$scan_result/stdout.txt" | tr '\n' ' ')"
done

echo "e2e windows: sources after the fresh scan"
JOB_TRIES=360
fresh_dir=$(run_job fresh-sources sources)
fresh_exit=$(tr -d '\r' <"$fresh_dir/exit.txt")
if [[ $fresh_exit != 0 ]]; then
  echo "e2e windows: fresh sources failed" >&2
  cat "$fresh_dir/stderr.txt" >&2
  exit 1
fi
fresh_out=$fresh_dir/stdout.txt
# Cursor bubble rows are estimated and kept out of account totals, so their
# proof is the scan line above, not this count.
for provider in claude-code opencode codex; do
  count=$(event_count "$provider" "$fresh_out")
  if [[ -z $count || $count == 0 ]]; then
    echo "e2e windows: $provider has no events in the fresh cache" >&2
    exit 1
  fi
  echo "  $provider events: $count"
done
cursor_files=$(awk '
  index($0, "cursor ") == 1 { show = 1 }
  show && $1 == "files:" { print $2; exit }
' "$fresh_out")
if [[ -z $cursor_files || $cursor_files == 0 ]]; then
  echo "e2e windows: cursor files were not listed from the fresh scan" >&2
  exit 1
fi
echo "  cursor files: $cursor_files"
grep -F "Users\\${windows_user}\\.claude" "$fresh_out" >/dev/null
grep -F "Users\\${windows_user}\\.codex" "$fresh_out" >/dev/null
grep -F 'Roaming\Cursor' "$fresh_out" >/dev/null
grep -F 'share\opencode' "$fresh_out" >/dev/null

unset JOB_ENV
echo "version: $(tr -d '\r' <"$version_dir/stdout.txt")"
echo "wrote $out_dir"
