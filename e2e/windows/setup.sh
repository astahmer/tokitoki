#!/usr/bin/env bash
# Create the Windows VM, stage this machine's provider stores onto the
# shared profile, and boot. Deleting the container keeps the disk. Deleting
# TOKITOKI_WIN_DIR installs Windows again. Provider files stay outside the repo.
set -euo pipefail

here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
windows_user=${TOKITOKI_WIN_USER:-vincent}
windows_password=${TOKITOKI_WIN_PASSWORD:-admin}
container_name=${TOKITOKI_WIN_CONTAINER:-tokitoki-win}
legacy_directory=$HOME/vms/tokitoki-windows
default_directory=${XDG_DATA_HOME:-$HOME/.local/share}/tokitoki/e2e-windows

if [[ -n ${TOKITOKI_WIN_DIR:-} ]]; then
  windows_directory=$TOKITOKI_WIN_DIR
elif [[ -f $legacy_directory/storage/data.qcow2 && ! -e $default_directory ]]; then
  windows_directory=$legacy_directory
else
  windows_directory=$default_directory
fi

if [[ ! -e /dev/kvm ]]; then
  echo "e2e windows: /dev/kvm is missing, the VM cannot boot" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "e2e windows: docker is not available" >&2
  exit 1
fi

mkdir -p "$windows_directory/storage" "$windows_directory/shared/e2e/inbox" "$windows_directory/shared/e2e/out"
profile_directory=$windows_directory/shared/profile

copy_file() {
  local source_path=$1
  local destination_path=$2
  if [[ ! -f $source_path ]]; then
    return 0
  fi
  if [[ -f $destination_path ]]; then
    local source_size destination_size
    source_size=$(stat -c %s "$source_path")
    destination_size=$(stat -c %s "$destination_path")
    if [[ $source_size == "$destination_size" ]]; then
      return 0
    fi
  fi
  mkdir -p "$(dirname "$destination_path")"
  cp -a "$source_path" "$destination_path"
}

copy_directory() {
  local source_path=$1
  local destination_path=$2
  if [[ ! -d $source_path ]]; then
    return 0
  fi
  mkdir -p "$destination_path"
  cp -a "$source_path/." "$destination_path/"
}

stage_profile() {
  echo "e2e windows: staging provider stores from $HOME"
  copy_directory "$HOME/.claude/projects" "$profile_directory/.claude/projects"
  copy_file "$HOME/.claude/.credentials.json" "$profile_directory/.claude/.credentials.json"
  copy_file "$HOME/.claude.json" "$profile_directory/.claude.json"
  copy_directory "$HOME/.codex/sessions" "$profile_directory/.codex/sessions"
  copy_directory "$HOME/.codex/archived_sessions" "$profile_directory/.codex/archived_sessions"
  copy_file "$HOME/.codex/auth.json" "$profile_directory/.codex/auth.json"
  copy_file "$HOME/.codex/config.toml" "$profile_directory/.codex/config.toml"
  copy_directory "$HOME/.codex-evvi/sessions" "$profile_directory/.codex-evvi/sessions"
  copy_directory "$HOME/.codex-evvi/archived_sessions" "$profile_directory/.codex-evvi/archived_sessions"
  copy_file "$HOME/.codex-evvi/auth.json" "$profile_directory/.codex-evvi/auth.json"
  copy_directory "$HOME/.cursor/ai-tracking" "$profile_directory/.cursor/ai-tracking"
  copy_file "$HOME/.config/Cursor/User/globalStorage/state.vscdb" \
    "$profile_directory/AppData/Roaming/Cursor/User/globalStorage/state.vscdb"
  copy_file "$HOME/.config/Cursor/User/globalStorage/state.vscdb-wal" \
    "$profile_directory/AppData/Roaming/Cursor/User/globalStorage/state.vscdb-wal"
  local database
  if [[ -d $HOME/.local/share/opencode ]]; then
    mkdir -p "$profile_directory/.local/share/opencode"
    shopt -s nullglob
    for database in "$HOME/.local/share/opencode"/opencode*.db; do
      copy_file "$database" "$profile_directory/.local/share/opencode/$(basename "$database")"
    done
    shopt -u nullglob
  fi
  copy_directory "$HOME/.config/github-copilot" "$profile_directory/.config/github-copilot"

  mkdir -p "$profile_directory/.config/tokitoki"
  local host_config=$HOME/.config/tokitoki/config.json
  local windows_home="C:\\Users\\${windows_user}"
  if [[ -f $host_config ]]; then
    jq --arg home "$HOME" --arg windows_home "$windows_home" '
      if .poll.codexHomes then
        .poll.codexHomes |= map(
          if startswith($home) then
            $windows_home + (.[($home | length):] | gsub("/"; "\\"))
          elif startswith("~/") then
            $windows_home + "\\" + (.[2:] | gsub("/"; "\\"))
          else . end
        )
      else . end
    ' "$host_config" >"$profile_directory/.config/tokitoki/config.json"
  elif [[ -d $HOME/.codex-evvi ]]; then
    jq -n --arg home "$windows_home\\.codex-evvi" '{poll: {codexHomes: [$home]}}' \
      >"$profile_directory/.config/tokitoki/config.json"
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ >"$profile_directory/READY"
}

if [[ -n ${TOKITOKI_WIN_RESTAGE:-} || ! -f $profile_directory/READY ]]; then
  stage_profile
else
  echo "e2e windows: profile already staged"
fi

cp -f "$here/agent.ps1" "$windows_directory/shared/e2e/agent.ps1"

export TOKITOKI_WIN_DIR=$windows_directory
export TOKITOKI_WIN_OEM=$here/oem
export TOKITOKI_WIN_USER=$windows_user
export TOKITOKI_WIN_PASSWORD=$windows_password

started_now=0
if docker container inspect "$container_name" >/dev/null 2>&1; then
  status=$(docker inspect -f '{{.State.Status}}' "$container_name")
  if [[ $status != running ]]; then
    echo "e2e windows: starting $container_name"
    docker start "$container_name" >/dev/null
    started_now=1
  else
    echo "e2e windows: $container_name is already running"
  fi
else
  echo "e2e windows: creating $container_name ($windows_directory)"
  docker compose -f "$here/compose.yml" up -d
  started_now=1
fi

desktop_visible() {
  if ! command -v magick >/dev/null 2>&1; then
    return 1
  fi
  docker exec "$container_name" sh -c 'printf "screendump /tmp/e2e-ready.ppm\n" | nc -U -w 3 /run/shm/monitor.sock' >/dev/null || return 1
  docker cp "$container_name":/tmp/e2e-ready.ppm /tmp/tokitoki-e2e-ready.ppm >/dev/null || return 1
  local mean
  mean=$(magick /tmp/tokitoki-e2e-ready.ppm -gravity South -crop x40+0+0 -format '%[fx:mean]' info: 2>/dev/null || echo 0)
  awk -v mean="$mean" 'BEGIN { exit !(mean+0 > 0.7) }'
}

wait_until_booted() {
  local started_at
  started_at=$(docker inspect -f '{{.State.StartedAt}}' "$container_name")
  echo "e2e windows: waiting for Windows to reach the desktop"
  for _ in $(seq 1 90); do
    if docker logs --since "$started_at" "$container_name" 2>&1 | grep -q "Windows started successfully" && desktop_visible; then
      echo "e2e windows: Windows is up"
      return 0
    fi
    sleep 2
  done
  echo "e2e windows: Windows did not finish booting" >&2
  return 1
}

if [[ $started_now -eq 1 && -f $windows_directory/shared/install.done ]]; then
  wait_until_booted
fi

if [[ -f $windows_directory/shared/install.done ]]; then
  echo "e2e windows: guest already provisioned"
  exit 0
fi

echo "e2e windows: waiting for Windows to finish first logon"
for _ in $(seq 1 720); do
  if [[ -f $windows_directory/shared/install.done ]]; then
    echo "e2e windows: guest install finished"
    exit 0
  fi
  sleep 10
done
echo "e2e windows: install.done never appeared" >&2
echo "the first boot downloads Windows and copies the profile; check docker logs $container_name" >&2
exit 1
