local model = require("./lib/model.luau")
local payload = {}
local refreshing = false
local lastError = nil
local lastRefresh = 0
local firstRead = true

local function accounts()
  return model.accounts(payload, noctalia.getConfig("accounts"), noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities)
end

local function render()
  local now = noctalia.nowMs()
  local mode = noctalia.getConfig("display_mode")
  local children = {ui.glyph({name = "chart-bar", size = 16, color = "primary"})}
  local tooltip = {}
  local all = accounts()
  local counts = {}
  for _, a in ipairs(all) do counts[model.vendor(a)] = (counts[model.vendor(a)] or 0) + 1 end
  if lastError then table.insert(children, ui.label({text = "?", color = "error"})) end
  for _, a in ipairs(all) do
    if #tooltip > 0 then table.insert(tooltip, {key = "────────", value = "────────────"}) end
    table.insert(tooltip, {key = "◈ " .. model.vendorName(a), value = a.name})
    for _, w in ipairs(model.rows(a, false, now)) do
      local countdown = model.countdown(w, now)
      table.insert(tooltip, {key = "◷ " .. model.windowLabel(w), value = model.value(w, now) .. (if countdown ~= "" then " · " .. countdown else "")})
    end
    if #(a.windows or {}) == 0 then table.insert(tooltip, {key = "Quota", value = "No provider quota"}) end
    if mode == "quotas" or mode == "shortest" then
      local parts = {}
      for _, w in ipairs(model.rows(a, mode == "shortest", now)) do table.insert(parts, model.windowLabel(w) .. " " .. model.value(w, now)) end
      local prefix = if counts[model.vendor(a)] > 1 then string.upper(string.sub(a.name, 1, 2)) .. ": " else ""
      table.insert(children, ui.separator({orientation = "vertical", spacing = 4, height = 18}))
      local logo = model.logo(a)
      if logo then table.insert(children, ui.image({path = "assets/" .. logo .. ".svg", width = 16, height = 16}))
      else prefix = model.vendor(a) .. " " .. prefix end
      table.insert(children, ui.label({text = prefix .. (if #parts > 0 then table.concat(parts, " · ") else "—")}))
    end
  end
  local stats = payload.stats or {}
  if mode == "total" then table.insert(children, ui.label({text = string.format("$%.2f · %s", stats.costUsd or 0, model.compact(stats.tokens))})) end
  if #all == 0 and mode ~= "icon" and mode ~= "total" then table.insert(children, ui.label({text = if lastError then "Unavailable" else "No provider quotas"})) end
  if #tooltip > 0 then table.insert(tooltip, {key = "────────", value = "────────────"}) end
  table.insert(tooltip, {key = (payload.window or {}).label or "Usage", value = string.format("$%.2f · %s", stats.costUsd or 0, model.compact(stats.tokens))})
  if lastError then table.insert(tooltip, {key = "Refresh failed", value = lastError}) end
  -- The native tooltip anchors to this row's bounds; leave a little clearance below the capsule.
  barWidget.render(ui.row({gap = 6, paddingH = 10, paddingV = 4, align = "center"}, children))
  barWidget.setTooltip(tooltip)
end

-- One short line for the bar; raw stderr can carry paths and account keys.
local function failureText(result)
  local hideIdentities = noctalia.getConfig("hide_identities") or (payload.uiPreview or {}).privacyHideIdentities
  local line = string.match(result.stderr or "", "error: ([^\n]+)")
  if hideIdentities or not line then return "Tokitoki request failed (exit " .. tostring(result.exitCode) .. ")" end
  return line
end

-- The first paint reads the stored payload; later reads are live without a
-- source scan, and a manual refresh (middle click) scans sources too.
local function refresh(scan)
  if refreshing then return end
  refreshing = true
  lastRefresh = noctalia.nowMs()
  local args = {noctalia.getConfig("executable"), "widget-payload"}
  if firstRead then table.insert(args, "--cached") elseif not scan then table.insert(args, "--skip-scan") end
  firstRead = false
  table.insert(args, "--notify")
  table.insert(args, "--json")
  local accepted = noctalia.runAsync(args, function(result)
    refreshing = false
    if result.exitCode ~= 0 then
      lastError = failureText(result)
    else
      local nextPayload = noctalia.json.decode(result.stdout)
      if type(nextPayload) == "table" and nextPayload.schema == 1 and nextPayload.app == "tokitoki" then
        payload, lastError = nextPayload, nil
        noctalia.state.set("payload", payload)
      else lastError = "Unsupported Tokitoki payload" end
    end
    noctalia.state.set("error", lastError or "")
    render()
  end)
  if not accepted then
    refreshing, lastError = false, "Could not start Tokitoki"
    noctalia.state.set("error", lastError)
    render()
  end
end

function update()
  noctalia.setUpdateInterval(1000)
  render()
  if noctalia.nowMs() - lastRefresh >= 30000 then refresh() end
end

function onClick() noctalia.togglePanel("tokitoki/usage:details") end
function onRightClick() noctalia.openSettings() end
function onMiddleClick() refresh(true) end

noctalia.state.watch("payload", function(value)
  payload = value or {}
  render()
end)
