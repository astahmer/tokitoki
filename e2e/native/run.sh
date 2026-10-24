#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/start.sh"
trap 'docker rm -f tokitoki-native-e2e >/dev/null' EXIT
for attempt in {1..100}; do
  if docker exec tokitoki-native-e2e test -f /tmp/native-env; then break; fi
  sleep 0.1
done
docker exec tokitoki-native-e2e sh /repo/e2e/native/scenario.sh
