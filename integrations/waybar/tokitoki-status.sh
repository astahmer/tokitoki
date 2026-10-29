#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"text":"tokitoki","tooltip":"jq is required by the Waybar adapter","class":"error"}'
  exit 0
fi

# Waybar starts a new run every interval even if the last one is still going;
# an overlapping run reprints the previous line instead of racing it.
state_dir="${XDG_RUNTIME_DIR:-/tmp}/tokitoki-waybar-$(id -u)"
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  cat "$state_dir/last" 2>/dev/null || printf '%s\n' '{"text":"tokitoki …","tooltip":"refreshing","class":"ok"}'
  exit 0
fi

if ! payload="$(tokitoki widget-payload --cached --notify --json 2>/dev/null)"; then
  printf '%s\n' '{"text":"tokitoki ?","tooltip":"tokitoki widget payload failed","class":"error"}'
  exit 0
fi

printf '%s\n' "$payload" | jq -c '
  def cost: ((. * 100 | round) / 100 | tostring);
  def compact:
    if . >= 1000000 then ((. / 1000000 * 10 | round) / 10 | tostring) + "M"
    elif . >= 1000 then ((. / 1000 * 10 | round) / 10 | tostring) + "k"
    else (floor | tostring)
    end;
  . as $root
  | ([(.statusIncidents // {}) | to_entries[] | select(.value.indicator != "none")]) as $incidents
  | {
    text: ("$" + ((.stats.costUsd // 0) | cost) + " · " + ((.stats.tokens // 0) | compact) + (if ($incidents | length) > 0 then " ⚠" else "" end)),
    tooltip: (
      "Tokitoki " + (.window.label // "today") +
      "\n" + ((.stats.tokens // 0) | compact) + " tokens" +
      "\n" + ((.stats.requests // 0) | tostring) + " requests" +
      " · " + ((.stats.sessions // 0) | tostring) + " sessions" +
      "\n" + ((.stats.cachePct // 0) | tostring) + "% cache" +
      ($incidents | map("\n" + ($root.providerRegistry[.key].displayName // .key) + " " + .value.indicator + ": " + .value.description) | join(""))
    ),
    class: (
      [
        if any(.budgets[]?; .state == "exceeded") then "exceeded"
        elif any(.budgets[]?; .state == "warn") then "warn"
        else "ok"
        end
      ] + (if ($incidents | length) > 0 then ["incident"] else [] end)
    ),
    percentage: ((.stats.cachePct // 0) | floor)
  }
' | tee "$state_dir/last"
