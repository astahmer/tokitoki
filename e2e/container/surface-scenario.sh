# Sourced by the container driver after its existing tab/gallery checks.
surface_ipc() {
  if [ "$E2E_SHELL" = dms ]; then
    dms ipc call tokitoki-surfaces "$@"
  else
    qs -p "$E2E_QUICKSHELL_DIR" ipc call tokitoki-surfaces "$@"
  fi
}
surface_matches() {
  surface_ipc state > "$E2E_OUT/surface-latest.json"
  jq -e "$1" "$E2E_OUT/surface-latest.json"
}
surface_save() {
  wait_for 10 "settled surface state" surface_matches '.busy == false'
  surface_ipc state > "$E2E_OUT/surface-$1.json"
  surface_ipc controls > "$E2E_OUT/surface-$1-controls.json"
  capture "surface-$1.png"
}
surface_click() {
  surface_ipc controls > "$E2E_OUT/surface-controls.json"
  point=$(jq -ce --arg label "$1" --arg account "${2:-}" '[.[] | select(.label == $label and .enabled and ($account == "" or .account == $account)) | select(.y > 280 and .y < 850)][0] // error("control not in viewport: " + $label)' "$E2E_OUT/surface-controls.json")
  cx=$(printf '%s' "$point" | jq -r .x)
  cy=$(printf '%s' "$point" | jq -r .y)
  click_at "$((cx - popout_offset_x))" "$((cy - popout_offset_y))"
}
select_tab quotas
surface_save baseline
surface_click 'Hide from bar only' 'claude-code@default'
wait_for 10 'bar-only hide payload readback' surface_matches '.ui.barHiddenAccounts == ["claude-code@default"] and .hiddenOverride == null'
surface_save bar-hidden
record_interaction account-bar-hide
surface_click 'Show in bar' 'claude-code@default'
wait_for 10 'bar-only restore payload readback' surface_matches '.ui.barHiddenAccounts == [] and .hiddenOverride == null'
surface_save bar-restored
record_interaction account-bar-restore
surface_click 'Move down in Quotas' 'claude-code@default'
wait_for 10 'quota order payload readback' surface_matches '.ui.accountOrder[0] == "codex@codex" and .quotaOverride == null'
surface_save quota-order
record_interaction account-quota-order
surface_click 'Move later in the bar' 'codex@codex'
wait_for 10 'bar order payload readback' surface_matches '.ui.barAccountOrder[1] == "codex@base_model_inference" and .barOverride == null'
surface_save bar-order
record_interaction account-bar-order
surface_click 'Hide this account everywhere' 'codex@codex'
wait_for 10 'global hide payload readback' surface_matches '.ui.menubarHidden == ["codex:codex"]'
surface_save globally-hidden
record_interaction account-global-hide
scroll_down 30
surface_save hidden-folded
surface_click expandHidden
wait_for 5 'hidden accounts expansion' surface_matches '.expanded == true'
# Expansion grows the card below the old scroll extent; reveal its restore row.
sleep 0.3
scroll_down 2
surface_save hidden-expanded
record_interaction account-hidden-expand
surface_click 'Restore this account'
wait_for 10 'global restore payload readback' surface_matches '.ui.menubarHidden == []'
scroll_up 30
surface_save globally-restored
record_interaction account-global-restore
for mode in failed null empty valid; do
  printf '%s\n' "$mode" > /out/refresh-next
  surface_click refresh
  wait_for 10 "refresh $mode consumed" test ! -f /out/refresh-next
  case "$mode" in
    failed) wait_for 10 'failed refresh preserved quotas' surface_matches '.busy == false and (.error | contains("e2e injected failed refresh"))' ;;
    null) wait_for 10 'missing quotas retained as stale' surface_matches '.busy == false and (.error | contains("incomplete"))' ;;
    empty) wait_for 10 'true empty quotas accepted' surface_matches '.busy == false and .limits == []' ;;
    valid) wait_for 10 'refresh recovered' surface_matches '.busy == false and (.limits | length) == 7 and .error == ""' ;;
  esac
  surface_save "refresh-$mode"
  record_interaction "refresh-$mode"
done
cp /out/ui-prefs.json "$E2E_OUT/surface-final-prefs.json"
