#!/bin/sh
set -eu
export XDG_RUNTIME_DIR=/tmp/native-runtime
export XDG_STATE_HOME=$HOME/.local/state
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
export LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe QT_QPA_PLATFORM=wayland QT_QUICK_BACKEND=software
export PATH=/repo/e2e/native:$PATH
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config/noctalia" "$HOME/.local/share/noctalia/plugins" /out
rm -f /out/plasma-states.jsonl /out/result.json
chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p /tmp/fontcache
sed 's|<cachedir>/var/cache/fontconfig</cachedir>|<cachedir>/tmp/fontcache</cachedir>|; s|</fontconfig>|<alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias></fontconfig>|' /etc/fonts/fonts.conf > /tmp/native-fonts.conf
export FONTCONFIG_FILE=/tmp/native-fonts.conf
# Pin a real text face for fixture screenshots; the minimal image lacks distro aliases.
sed 's|</fontconfig>|<match target="pattern"><edit name="family" mode="prepend" binding="strong"><string>DejaVu Sans</string></edit></match></fontconfig>|' "$FONTCONFIG_FILE" >/tmp/native-fonts-pinned.conf
export FONTCONFIG_FILE=/tmp/native-fonts-pinned.conf
mkdir -p "$HOME/.config"
cat > "$HOME/.config/kdeglobals" <<'KDE'
[General]
font=DejaVu Sans,10,-1,5,50,0,0,0,0,0
KDE
export __EGL_VENDOR_LIBRARY_FILENAMES=$(find /nix/store -path '*/share/glvnd/egl_vendor.d/50_mesa.json' -print -quit)
export NIXPKGS_QT6_QML_IMPORT_PATH=$(find /nix/store -maxdepth 4 -type d -path '*/lib/qt-6/qml' | paste -sd:)
export XDG_DATA_DIRS="${PLASMA_DATA:-/usr/share}:${XDG_DATA_DIRS:-/usr/share}"
cp -R /repo/integrations/noctalia-v5/tokitoki "$HOME/.local/share/noctalia/plugins/"
node /repo/e2e/native/instrument.mjs
node /repo/e2e/native/fixture.mjs
node /repo/e2e/native/server.mjs >/out/server.log 2>&1 &
cat > "$HOME/.config/noctalia/config.toml" <<'TOML'
[shell]
telemetry_enabled = false
[plugins]
enabled = ["tokitoki/usage"]
auto_update = "none"
[bar.main]
position = "top"
thickness = 40
margin_ends = 12
start = ["tokitoki"]
center = []
end = ["clock"]
[widget.tokitoki]
type = "tokitoki/usage:usage"
TOML
sway -c /repo/e2e/container/sway.conf >/out/sway.log 2>&1 &
for i in $(seq 1 50); do
  socket=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'wayland-*' | head -1)
  if [ -n "$socket" ]; then export WAYLAND_DISPLAY=$(basename "$socket"); break; fi
  sleep 0.1
done
export SWAYSOCK=$(find "$XDG_RUNTIME_DIR" -name 'sway-ipc.*.sock' | head -1)
WLRCTL_HOLD=1 wlrctl pointer move 0 0 &
sleep 0.2
wlrctl pointer move -10000 -10000
# Export the isolated bus/display environment for subsequent native-host commands.
export -p > /tmp/native-env
sleep infinity
