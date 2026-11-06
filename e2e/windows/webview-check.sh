#!/usr/bin/env bash
# Install the Evergreen WebView2 runtime in the Windows VM and open a local page.
# The page prints WEBVIEW2 OK only when window.chrome.webview exists.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
container=${TOKITOKI_WIN_CONTAINER:-tokitoki-win}
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
source_dir=$here/webview-check
out_dir=${E2E_OUT_DIR:-"$root/e2e/out/windows"}

"$here/setup.sh"

shared=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/shared"}}{{.Source}}{{end}}{{end}}')
if [[ -z $shared || ! -d $shared ]]; then
  echo "e2e windows: $container has no /shared mount" >&2
  exit 1
fi

stage=$shared/e2e/webview-check
mkdir -p "$stage" "$out_dir"
cp -f "$source_dir/WebViewCheck.cs" "$stage/WebViewCheck.cs"
cp -f "$source_dir/check.html" "$stage/check.html"
cp -f "$source_dir/webview-check.bat" "$shared/e2e/webview-check.bat"
sed -i 's/\r$//; s/$/\r/' "$shared/e2e/webview-check.bat"

installer=$stage/MicrosoftEdgeWebView2RuntimeInstallerX64.exe
if [[ ! -f $installer ]]; then
  echo "e2e windows: downloading the WebView2 runtime"
  curl -fL --retry 3 -o "$installer.partial" "https://go.microsoft.com/fwlink/?linkid=2124701"
  mv -f "$installer.partial" "$installer"
fi

if [[ ! -f $stage/WebView2Loader.dll ]]; then
  echo "e2e windows: downloading the WebView2 assemblies"
  curl -fL --retry 3 -o "$stage/Microsoft.Web.WebView2.nupkg" "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2"
  extract=$(mktemp -d)
  bsdtar -xf "$stage/Microsoft.Web.WebView2.nupkg" -C "$extract"
  cp -f "$extract/lib/net462/Microsoft.Web.WebView2.Core.dll" "$stage/Microsoft.Web.WebView2.Core.dll"
  cp -f "$extract/lib/net462/Microsoft.Web.WebView2.WinForms.dll" "$stage/Microsoft.Web.WebView2.WinForms.dll"
  cp -f "$extract/runtimes/win-x64/native/WebView2Loader.dll" "$stage/WebView2Loader.dll"
  rm -rf "$extract"
fi

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

capture_guest_screen() {
  local dest=$1
  docker exec "$container" sh -c 'printf "screendump /tmp/e2e-webview.ppm\n" | nc -U -w 3 /run/shm/monitor.sock' >/dev/null
  docker cp "$container":/tmp/e2e-webview.ppm "$dest.ppm"
  magick "$dest.ppm" "$dest.png"
  rm -f "$dest.ppm"
}

log=$stage/setup.log
rm -f "$log" "$stage/webview-error.txt"

echo "e2e windows: opening the WebView2 check"
qemu_keys esc
sleep 0.4
printf 'sendkey meta_l-r 250\n' | docker exec -i "$container" sh -c 'nc -U -w 2 /run/shm/monitor.sock' >/dev/null
sleep 2
qemu_keys ctrl-a backspace
sleep 0.3
type_text 'Z:\e2e\webview-check.bat'
sleep 0.3
qemu_keys ret

for _ in $(seq 1 20); do
  if [[ -f $log ]]; then
    break
  fi
  sleep 0.5
done
if [[ ! -f $log ]]; then
  echo "e2e windows: accepting the network file warning"
  qemu_keys left ret
fi

ready=0
for _ in $(seq 1 180); do
  if [[ -f $log ]] && grep -q "launched" "$log"; then
    ready=1
    break
  fi
  if [[ -f $log ]] && grep -q "csc missing" "$log"; then
    echo "e2e windows: the guest has no C# compiler" >&2
    cat "$log" >&2
    capture_guest_screen "$out_dir/webview-check" || true
    exit 1
  fi
  if [[ -f $log ]] && grep -Eq "csc exit [1-9]" "$log"; then
    echo "e2e windows: the WebView2 check did not compile" >&2
    cat "$log" >&2
    capture_guest_screen "$out_dir/webview-check" || true
    exit 1
  fi
  sleep 2
done

if [[ $ready -eq 0 ]]; then
  echo "e2e windows: WebView2 check did not launch" >&2
  cat "$log" >&2 || true
  capture_guest_screen "$out_dir/webview-check" || true
  exit 1
fi

echo "e2e windows: waiting for the page to paint"
sleep 12
capture_guest_screen "$out_dir/webview-check"
if [[ -f $stage/webview-error.txt ]]; then
  echo "e2e windows: WebView2 failed to start" >&2
  cat "$stage/webview-error.txt" >&2
  exit 1
fi
echo "e2e windows: wrote $out_dir/webview-check.png"
cat "$log"
