#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"text":"tokitoki","tooltip":"jq is required by the Waybar adapter","class":"error"}'
  exit 0
fi

if ! payload="$(tokitoki widget-payload --cached --json 2>/dev/null)"; then
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
  {
    text: ("$" + ((.stats.costUsd // 0) | cost) + " · " + ((.stats.tokens // 0) | compact)),
    tooltip: (
      "Tokitoki " + (.window.label // "today") +
      "\n" + ((.stats.tokens // 0) | compact) + " tokens" +
      "\n" + ((.stats.requests // 0) | tostring) + " requests" +
      " · " + ((.stats.sessions // 0) | tostring) + " sessions" +
      "\n" + ((.stats.cachePct // 0) | tostring) + "% cache"
    ),
    class: (
      if any(.budgets[]?; .state == "exceeded") then "exceeded"
      elif any(.budgets[]?; .state == "warn") then "warn"
      else "ok"
      end
    ),
    percentage: ((.stats.cachePct // 0) | floor)
  }
'
