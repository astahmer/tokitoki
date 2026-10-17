#!/bin/sh
set -eu

integrations=$1
destination=$2
mkdir -p "$destination"
cp -R "$integrations/quickshell/tokitoki/." "$destination/"
cp -R "$integrations/dms/tokitoki" "$destination/views"
for view in "$destination/views/"*.qml; do
  sed -i \
    -e 's|import qs.Common$|import "../Common"|' \
    -e 's|import qs.Widgets$|import "../Widgets"|' \
    -e 's|import qs.Modules.Plugins$|import "../Modules/Plugins"|' \
    "$view"
done
sed -i 's|"file://" + Quickshell.shellPath("../../dms/tokitoki/TokitokiWidget.qml")|Qt.resolvedUrl("views/TokitokiWidget.qml")|' \
  "$destination/TokitokiController.qml"
sed -i '/import "Modules\/Plugins"/a import "views" as Views' "$destination/TokitokiController.qml"
