local model = require("./lib/model.luau")
local saving = false
local render
local showHidden = false

local function moveAccount(id, direction, bar)
  if saving then return end
  local payload = noctalia.state.get("payload") or {}
  local visible = model.accounts(payload, noctalia.getConfig("accounts"), noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities, if bar then "bar" else "cards")
  local order = model.moveOrder(payload, visible, id, direction, bar)
  if not order then return end
  saving = true
  noctalia.state.set("order_error", "")
  render()
  local preferences = payload.uiPreview or {}
  local barSeed = table.clone(preferences.barAccountOrder or preferences.accountOrder or {})
  for _, a in ipairs(model.accounts(payload, {}, false, "all")) do
    if not table.find(barSeed, a.id) then table.insert(barSeed, a.id) end
  end
  local args = {noctalia.getConfig("executable"), "ui", if bar then "--bar-account-order" else "--account-order", table.concat(order, ",")}
  if not bar then table.insert(args, "--bar-account-order") table.insert(args, table.concat(barSeed, ",")) end
  local accepted = noctalia.runAsync(args, function(result)
    saving = false
    if result.exitCode == 0 then
      local nextPayload = table.clone(noctalia.state.get("payload") or payload)
      nextPayload.uiPreview = table.clone(nextPayload.uiPreview or {})
      if bar then nextPayload.uiPreview.barAccountOrder = order else nextPayload.uiPreview.accountOrder = order nextPayload.uiPreview.barAccountOrder = preferences.barAccountOrder or barSeed end
      noctalia.state.set("payload", nextPayload)
    else noctalia.state.set("order_error", "Could not save account order") end
    render()
  end)
  if not accepted then
    saving = false
    noctalia.state.set("order_error", "Could not start Tokitoki to save account order")
    render()
  end
end

local function setVisibility(a, hidden, bar)
  if saving then return end
  local payload = noctalia.state.get("payload") or {}
  local preferences = payload.uiPreview or {}
  local list = table.clone((if bar then preferences.barHiddenAccounts else preferences.menubarHidden) or {})
  local target = a.provider .. ":" .. a.accountKey
  for index = #list, 1, -1 do
    local entry = list[index]
    local provider, suffix = string.match(entry, "^([^:]+):(.+)$")
    if (bar and entry == a.id) or (not bar and (entry == a.provider or (provider == a.provider and string.sub(a.accountKey, -#suffix) == suffix))) then table.remove(list, index) end
  end
  if hidden then table.insert(list, if bar then a.id else target) end
  local args = if bar then {noctalia.getConfig("executable"), "config", "set", "ui.previewHiddenAccounts", noctalia.json.encode(list)} else {noctalia.getConfig("executable"), "ui", if hidden then "--hide" else "--show", target, "--surface", "widget"}
  saving = true
  noctalia.state.set("order_error", "")
  render()
  local accepted = noctalia.runAsync(args, function(result)
    saving = false
    if result.exitCode == 0 then
      local nextPayload = table.clone(noctalia.state.get("payload") or payload)
      nextPayload.uiPreview = table.clone(nextPayload.uiPreview or {})
      if bar then nextPayload.uiPreview.barHiddenAccounts = list else nextPayload.uiPreview.menubarHidden = list end
      noctalia.state.set("payload", nextPayload)
    else noctalia.state.set("order_error", "Could not save account visibility") end
    render()
  end)
  if not accepted then saving = false noctalia.state.set("order_error", "Could not start Tokitoki to save visibility") render() end
end

render = function()
  local payload = noctalia.state.get("payload") or {}
  local now = noctalia.nowMs()
  local children = {
    ui.row({gap = 10, align = "center"}, {
      ui.glyph({name = "chart-bar", size = 24, color = "primary"}),
      ui.label({text = "Tokitoki", fontSize = 22, fontWeight = "bold", flexGrow = 1}),
      ui.button({glyph = "settings", text = "Settings", onClick = function() noctalia.openSettings() end}),
    }),
  }
  local errorText = noctalia.state.get("error")
  local orderError = noctalia.state.get("order_error")
  if orderError and orderError ~= "" then errorText = orderError end
  if errorText and errorText ~= "" then table.insert(children, ui.label({text = "Refresh failed · " .. errorText, color = "error", maxLines = 3})) end
  local stats = payload.stats or {}
  table.insert(children, ui.label({text = ((payload.window or {}).label or "Usage") .. string.format(" · $%.2f · %s tokens", stats.costUsd or 0, model.compact(stats.tokens)), color = "on_surface_variant"}))
  local cards = {}
  local accounts = model.accounts(payload, noctalia.getConfig("accounts"), noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities, "cards")
  for index, a in ipairs(accounts) do
    local rows = {ui.row({key = "header", align = "center", gap = 6}, {
      ui.label({text = model.vendorName(a) .. " · " .. a.name, fontWeight = "bold", fontSize = 16, flexGrow = 1}),
      ui.button({glyph = "chevron-up", tooltip = "Move account up", controlSize = "sm", enabled = not saving and index > 1, onClick = function() moveAccount(a.id, -1) end}),
      ui.button({glyph = "chevron-down", tooltip = "Move account down", controlSize = "sm", enabled = not saving and index < #accounts, onClick = function() moveAccount(a.id, 1) end}),
    })}
    local barHidden = table.find((payload.uiPreview or {}).barHiddenAccounts or {}, a.id) ~= nil
    table.insert(rows, ui.row({gap = 6}, {
      ui.button({text = "Hide everywhere", enabled = not saving, onClick = function() setVisibility(a, true, false) end}),
      ui.button({text = if barHidden then "Show on bar" else "Hide from bar", enabled = not saving, onClick = function() setVisibility(a, not barHidden, true) end}),
    }))
    for _, w in ipairs(model.rows(a, false, now)) do
      local value = model.value(w, now)
      local remaining = model.percent(w, now)
      table.insert(rows, ui.row({gap = 12}, {
        ui.label({text = model.windowLabel(w), flexGrow = 1}),
        ui.label({text = value, color = if remaining and remaining <= 10 then "error" else "primary"}),
        ui.label({text = model.countdown(w, now), color = "on_surface_variant"}),
      }))
      if remaining ~= nil and not w.amountUsd then table.insert(rows, ui.progress({progress = remaining / 100, height = 4})) end
      if w.observedAt then table.insert(rows, ui.label({text = "Observed · " .. w.observedAt, fontSize = 11, color = "on_surface_variant"})) end
    end
    if #(a.windows or {}) == 0 then table.insert(rows, ui.label({text = "No provider quota", color = "on_surface_variant"})) end
    if #(a.budgetWindows or {}) > 0 then
      table.insert(rows, ui.separator({spacing = 6}))
      table.insert(rows, ui.label({text = "Local usage / budget pace", fontWeight = "bold"}))
      for _, w in ipairs(a.budgetWindows) do
        table.insert(rows, ui.label({text = (w.label or w.kind or "Usage") .. string.format(" · $%.2f · %s tokens", w.cost or 0, model.compact(w.tokens)), color = "on_surface_variant"}))
      end
    end
    table.insert(cards, ui.column({key = a.id, gap = 8, padding = 14, fill = "surface_variant", radius = 12}, rows))
  end
  if #cards == 0 then table.insert(cards, ui.label({text = "No selected accounts. Check Tokitoki and plugin settings."})) end
  local hiddenAccounts = {}
  for _, a in ipairs(model.accounts(payload, noctalia.getConfig("accounts"), noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities, "all")) do
    if a.globallyHidden then table.insert(hiddenAccounts, a) end
  end
  if #hiddenAccounts > 0 then
    table.insert(cards, ui.button({text = "Hidden quotas (" .. tostring(#hiddenAccounts) .. ")", onClick = function() showHidden = not showHidden render() end}))
    if showHidden then
      for _, a in ipairs(hiddenAccounts) do
        table.insert(cards, ui.row({gap = 6}, {
          ui.label({text = a.name, flexGrow = 1}),
          ui.button({text = if table.find((payload.uiPreview or {}).menubarHidden or {}, a.provider) then "Restore all " .. a.provider .. " accounts" else "Restore", enabled = not saving, onClick = function() setVisibility(a, false, false) end}),
        }))
      end
    end
  end
  local barAccounts = model.accounts(payload, noctalia.getConfig("accounts"), noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities, "bar")
  if #barAccounts > 0 then table.insert(cards, ui.label({text = "Bar order", fontWeight = "bold"})) end
  for index, a in ipairs(barAccounts) do
    table.insert(cards, ui.row({gap = 6}, {
      ui.label({text = a.name, flexGrow = 1}),
      ui.button({glyph = "chevron-left", tooltip = "Move bar account left", enabled = not saving and index > 1, onClick = function() moveAccount(a.id, -1, true) end}),
      ui.button({glyph = "chevron-right", tooltip = "Move bar account right", enabled = not saving and index < #barAccounts, onClick = function() moveAccount(a.id, 1, true) end}),
    }))
  end
  for _, activity in ipairs(payload.t3codeActivity or {}) do
    if activity.key == "today" and activity.total and activity.total.requests > 0 then
      table.insert(cards, ui.column({gap = 6, padding = 14, fill = "surface_variant", radius = 12}, {
        ui.label({text = "Via T3 Code", fontWeight = "bold"}),
        ui.label({text = string.format("%d requests · $%.2f observed / estimated", activity.total.requests, activity.total.costUsd or 0)}),
        ui.label({text = "Activity only · excluded from usage totals", color = "on_surface_variant"}),
      }))
    end
  end
  table.insert(children, ui.scroll({key = "accounts", gap = 12, flexGrow = 1}, cards))
  panel.render(ui.column({key = "details", flexGrow = 1, gap = 14, padding = 20}, children))
end

function onOpen() noctalia.setUpdateInterval(1000) render() end
function update() render() end
noctalia.state.watch("payload", function() render() end)
