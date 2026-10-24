local model = require("./lib/model.luau")

local function render()
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
  if errorText and errorText ~= "" then table.insert(children, ui.label({text = "Refresh failed · " .. errorText, color = "error", maxLines = 3})) end
  local stats = payload.stats or {}
  table.insert(children, ui.label({text = ((payload.window or {}).label or "Usage") .. string.format(" · $%.2f · %s tokens", stats.costUsd or 0, model.compact(stats.tokens)), color = "on_surface_variant"}))
  local cards = {}
  for _, a in ipairs(model.accounts(payload, noctalia.getConfig("accounts"), noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities)) do
    local rows = {ui.label({text = model.vendorName(a) .. " · " .. a.name, fontWeight = "bold", fontSize = 16})}
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
