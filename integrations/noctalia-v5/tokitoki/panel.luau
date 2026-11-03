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
  local args = if bar then {noctalia.getConfig("executable"), "config", "set", "ui.previewHiddenAccounts", if #list == 0 then "[]" else noctalia.json.encode(list)} else {noctalia.getConfig("executable"), "ui", if hidden then "--hide" else "--show", target, "--surface", "widget"}
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

local layoutMode = false
local collapsed = {}

-- Popout palette: the neutral macOS-menubar look by default, or Noctalia's roles.
-- Noctalia has no success/warning roles, so capacity colors stay fixed in both.
local MENUBAR = {
  window = "#1e1e1e", card = "#2a2a2a", cardBorder = "#333333", text = "#ececec", secondary = "#8e8e8e",
  separator = "#333333", track = "#3a3a3a", badge = "#3a3a3a", control = "#383838", selected = "#4a4a4a",
  green = "#29c778", amber = "#ff9e0a", rose = "#f04259", neutral = "#549ef5", mint = "#63d9d0", orange = "#ff9f0a",
}
local SHELL = {
  nativeButtons = true,
  window = "surface", card = "surface_variant", cardBorder = "outline/0.3", text = "on_surface", secondary = "on_surface_variant",
  separator = "outline/0.3", track = "on_surface/0.15", badge = "on_surface/0.1",
  green = "#29c778", amber = "#ff9e0a", rose = "error", neutral = "primary", mint = "#63d9d0", orange = "#ff9f0a",
}

local function palette()
  return if noctalia.getConfig("appearance") == "shell" then SHELL else MENUBAR
end

-- ui.button always paints Noctalia's theme roles, so the menubar palette
-- draws its buttons from clickable rows with the same props.
local function button(c, props)
  if c.nativeButtons then return ui.button(props) end
  local enabled = props.enabled ~= false
  local outlined = props.variant ~= "ghost"
  local content = {}
  if props.glyph then table.insert(content, ui.glyph({name = props.glyph, size = 14, color = c.text})) end
  if props.text then table.insert(content, ui.label({text = props.text, color = c.text, fontSize = 12, maxLines = 1})) end
  return ui.row({
    gap = 5, align = "center", justify = if props.contentAlign == "start" then "start" else "center",
    paddingH = if props.text then 10 else 0, width = props.width, height = 28, radius = 7,
    fill = if props.selected then c.selected elseif outlined then c.control else "#00000000",
    border = if outlined then c.cardBorder else "#00000000", borderWidth = if outlined then 1 else 0,
    opacity = if enabled then 1 else 0.4, tooltip = props.tooltip,
    -- An empty name clears the click target, so a disabled button stops reacting.
    onClick = if enabled then props.onClick else "",
  }, content)
end

local function windowRows(c, w, now)
  local remaining = model.percent(w, now)
  local tone = c[model.tone(w, now)]
  local rows = {
    ui.row({gap = 6, align = "center"}, {
      ui.label({text = model.title(w), color = c.secondary, fontSize = 13, flexGrow = 1, maxLines = 1}),
      ui.label({text = model.sourceText(w, now), color = c.secondary, fontSize = 12, visible = model.sourceText(w, now) ~= ""}),
      ui.label({text = model.valueText(w, now), color = tone, fontSize = 13, fontWeight = "bold"}),
    }),
  }
  if remaining ~= nil then table.insert(rows, ui.progress({progress = remaining / 100, fill = tone, track = c.track, height = 6, radius = 3})) end
  local reset = model.resetText(w, now)
  if reset ~= "" then table.insert(rows, ui.label({text = reset, color = c.secondary, fontSize = 11})) end
  return ui.column({gap = 5}, rows)
end

local function accountCard(c, a, index, count, payload, now)
  local folded = collapsed[a.id] == true
  local barHidden = table.find((payload.uiPreview or {}).barHiddenAccounts or {}, a.id) ~= nil
  local logo = model.logo(a)
  local subtitle = model.vendorName(a)
  if a.name ~= a.accountKey and a.name ~= model.vendorName(a) then subtitle = subtitle .. " · " .. a.accountKey end
  local header = {
    button(c, {glyph = if folded then "chevron-right" else "chevron-down", variant = "ghost", controlSize = "sm", width = 26,
      tooltip = if folded then "Expand account" else "Collapse account",
      onClick = function() collapsed[a.id] = not folded render() end}),
    if logo then ui.image({path = "assets/" .. logo .. ".svg", width = 20, height = 20}) else ui.glyph({name = "chart-bar", size = 20, color = c.secondary}),
    ui.column({gap = 0, flexGrow = 1}, {
      ui.label({text = a.name, color = c.text, fontSize = 14, fontWeight = "bold", maxLines = 1}),
      ui.label({text = subtitle, color = c.secondary, fontSize = 11, maxLines = 1}),
    }),
  }
  if layoutMode then
    table.insert(header, button(c, {glyph = "chevron-up", tooltip = "Move account up", variant = "ghost", controlSize = "sm", width = 30, enabled = not saving and index > 1, onClick = function() moveAccount(a.id, -1) end}))
    table.insert(header, button(c, {glyph = "chevron-down", tooltip = "Move account down", variant = "ghost", controlSize = "sm", width = 30, enabled = not saving and index < count, onClick = function() moveAccount(a.id, 1) end}))
    table.insert(header, button(c, {glyph = if barHidden then "eye-off" else "eye", tooltip = if barHidden then "Show on bar" else "Hide from bar", variant = "ghost", controlSize = "sm", width = 30, enabled = not saving, onClick = function() setVisibility(a, not barHidden, true) end}))
    table.insert(header, button(c, {glyph = "trash", tooltip = "Hide everywhere", variant = "ghost", controlSize = "sm", width = 30, enabled = not saving, onClick = function() setVisibility(a, true, false) end}))
  end
  local plan = model.plan(a)
  if plan ~= "" then
    table.insert(header, ui.row({fill = c.badge, radius = 6, paddingH = 7, paddingV = 2, align = "center"}, {
      ui.label({text = plan, color = c.text, fontSize = 11}),
    }))
  end
  local rows = {ui.row({key = "header", align = "center", gap = 8}, header)}
  if not folded then
    local issue = model.issue(a)
    if issue then
      table.insert(rows, ui.row({gap = 6, align = "center"}, {
        ui.glyph({name = "alert-triangle", size = 14, color = c.orange}),
        ui.label({text = issue.title, color = c.orange, fontSize = 12, fontWeight = "bold"}),
        ui.label({text = issue.reason, color = c.secondary, fontSize = 11, maxLines = 1, flexGrow = 1}),
      }))
    end
    for _, w in ipairs(model.rows(a, false, now)) do table.insert(rows, windowRows(c, w, now)) end
    if #(a.windows or {}) == 0 then table.insert(rows, ui.label({text = "No provider quota", color = c.secondary, fontSize = 12})) end
    local banked = model.banked(a, now)
    if banked ~= "" then
      table.insert(rows, ui.row({gap = 6, align = "center"}, {
        ui.glyph({name = "repeat", size = 14, color = c.mint}),
        ui.label({text = banked, color = c.mint, fontSize = 12}),
      }))
    end
    if #(a.budgetWindows or {}) > 0 then
      table.insert(rows, ui.separator({spacing = 2, color = c.separator}))
      table.insert(rows, ui.label({text = "Local usage / budget pace", color = c.secondary, fontSize = 12, fontWeight = "bold"}))
      for _, w in ipairs(a.budgetWindows) do
        table.insert(rows, ui.row({gap = 6}, {
          ui.label({text = model.capitalize(w.label or w.kind or "Usage"), color = c.secondary, fontSize = 12, flexGrow = 1}),
          ui.label({text = string.format("$%.2f · %s tokens", w.cost or 0, model.compact(w.tokens)), color = c.text, fontSize = 12}),
        }))
      end
    end
  end
  return ui.column({key = a.id, gap = 10, padding = 12, fill = c.card, radius = 10, border = c.cardBorder, borderWidth = 1}, rows)
end

render = function()
  local payload = noctalia.state.get("payload") or {}
  local now = noctalia.nowMs()
  local c = palette()
  local hideIdentities = noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities
  local stats = payload.stats or {}
  local children = {
    ui.label({text = ((payload.window or {}).label or "Usage") .. string.format(" · $%.2f · %s tokens", stats.costUsd or 0, model.compact(stats.tokens)), color = c.secondary, fontSize = 12}),
  }
  local errorText = noctalia.state.get("error")
  local orderError = noctalia.state.get("order_error")
  if orderError and orderError ~= "" then errorText = orderError end
  if errorText and errorText ~= "" then table.insert(children, ui.label({text = "Refresh failed · " .. errorText, color = c.rose, maxLines = 3})) end

  local cards = {}
  local accounts = model.accounts(payload, noctalia.getConfig("accounts"), hideIdentities, "cards")
  for index, a in ipairs(accounts) do table.insert(cards, accountCard(c, a, index, #accounts, payload, now)) end
  if #cards == 0 then table.insert(cards, ui.label({text = "No selected accounts. Check Tokitoki and plugin settings.", color = c.secondary})) end
  for _, activity in ipairs(payload.t3codeActivity or {}) do
    if activity.key == "today" and activity.total and activity.total.requests > 0 then
      table.insert(cards, ui.column({key = "t3code", gap = 4, padding = 12, fill = c.card, radius = 10, border = c.cardBorder, borderWidth = 1}, {
        ui.label({text = "Via T3 Code", color = c.text, fontWeight = "bold"}),
        ui.label({text = string.format("%d requests · $%.2f observed / estimated", activity.total.requests, activity.total.costUsd or 0), color = c.text, fontSize = 12}),
        ui.label({text = "Activity only · excluded from usage totals", color = c.secondary, fontSize = 11}),
      }))
    end
  end

  if layoutMode then
    local hiddenAccounts = {}
    for _, a in ipairs(model.accounts(payload, noctalia.getConfig("accounts"), hideIdentities, "all")) do
      if a.globallyHidden then table.insert(hiddenAccounts, a) end
    end
    if #hiddenAccounts > 0 then
      table.insert(cards, button(c, {text = "Hidden quotas (" .. tostring(#hiddenAccounts) .. ")", glyph = if showHidden then "chevron-down" else "chevron-right", variant = "outline", controlSize = "sm", contentAlign = "start", onClick = function() showHidden = not showHidden render() end}))
      if showHidden then
        for _, a in ipairs(hiddenAccounts) do
          table.insert(cards, ui.row({gap = 6, align = "center"}, {
            ui.label({text = a.name, color = c.text, flexGrow = 1, maxLines = 1}),
            button(c, {text = if table.find((payload.uiPreview or {}).menubarHidden or {}, a.provider) then "Restore all " .. a.provider .. " accounts" else "Restore", variant = "outline", controlSize = "sm", enabled = not saving, onClick = function() setVisibility(a, false, false) end}),
          }))
        end
      end
    end
    local barAccounts = model.accounts(payload, noctalia.getConfig("accounts"), hideIdentities, "bar")
    if #barAccounts > 0 then table.insert(cards, ui.label({text = "Bar order", color = c.secondary, fontWeight = "bold"})) end
    for index, a in ipairs(barAccounts) do
      table.insert(cards, ui.row({gap = 6, align = "center"}, {
        ui.label({text = a.name, color = c.text, flexGrow = 1, maxLines = 1}),
        button(c, {glyph = "chevron-left", tooltip = "Move bar account left", variant = "ghost", controlSize = "sm", width = 30, enabled = not saving and index > 1, onClick = function() moveAccount(a.id, -1, true) end}),
        button(c, {glyph = "chevron-right", tooltip = "Move bar account right", variant = "ghost", controlSize = "sm", width = 30, enabled = not saving and index < #barAccounts, onClick = function() moveAccount(a.id, 1, true) end}),
      }))
    end
  end
  table.insert(children, ui.scroll({key = "accounts", gap = 10, flexGrow = 1}, cards))

  local refreshing = noctalia.state.get("refreshing") == true
  table.insert(children, ui.separator({spacing = 0, color = c.separator}))
  table.insert(children, ui.row({key = "footer", gap = 6, align = "center"}, {
    button(c, {text = if refreshing then "Refreshing…" else "Refresh & scan", glyph = "refresh", variant = "outline", controlSize = "sm", enabled = not refreshing,
      onClick = function() noctalia.state.set("refresh_request", noctalia.nowMs()) end}),
    ui.spacer({flexGrow = 1}),
    button(c, {text = "Layout", glyph = "layout-grid", variant = "outline", controlSize = "sm", selected = layoutMode, onClick = function() layoutMode = not layoutMode render() end}),
    button(c, {text = "Settings", glyph = "settings", variant = "outline", controlSize = "sm", onClick = function() noctalia.openSettings() end}),
    button(c, {text = "Open", glyph = "external-link", variant = "outline", controlSize = "sm",
      onClick = function() noctalia.runAsync({"xdg-open", "http://127.0.0.1:7788/"}) end}),
  }))
  panel.render(ui.column({key = "details", flexGrow = 1, gap = 10, padding = 14, fill = c.window, radius = 12}, children))
end

function onOpen() noctalia.setUpdateInterval(1000) render() end
function update() render() end
noctalia.state.watch("payload", function() render() end)
noctalia.state.watch("refreshing", function() render() end)
