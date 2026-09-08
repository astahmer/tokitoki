local payload = {}
local refreshing = false
local lastError = nil

local function formatTokens(value)
  local number = tonumber(value or 0) or 0
  if number >= 1000000 then
    return string.format("%.1fM", number / 1000000)
  end
  if number >= 1000 then
    return string.format("%.1fk", number / 1000)
  end
  return tostring(math.floor(number))
end

local function stats()
  return payload.stats or {}
end

local function render()
  local current = stats()
  local cost = tonumber(current.costUsd or 0) or 0
  local tokens = tonumber(current.tokens or 0) or 0
  local requests = tonumber(current.requests or 0) or 0
  local sessions = tonumber(current.sessions or 0) or 0
  local cache = tonumber(current.cachePct or 0) or 0
  local label = payload.window and payload.window.label or "today"

  barWidget.setGlyph("chart-bar")
  if lastError ~= nil then
    barWidget.setText("tokitoki ?")
    barWidget.setTooltip(lastError)
    return
  end

  barWidget.setText(string.format("$%.2f · %s", cost, formatTokens(tokens)))
  barWidget.setTooltip(string.format(
    "%s · %s tokens · %d requests · %d sessions · %d%% cache",
    label,
    formatTokens(tokens),
    requests,
    sessions,
    math.floor(cache)
  ))
end

local function refresh()
  if refreshing then
    return
  end
  refreshing = true

  local accepted = noctalia.runAsync("tokitoki widget-payload --cached --json", function(result)
    refreshing = false
    if result.exitCode ~= 0 then
      lastError = result.stderr ~= "" and result.stderr or "tokitoki widget payload failed"
      render()
      return
    end

    local nextPayload, decodeError = noctalia.json.decode(result.stdout)
    if nextPayload == nil or nextPayload.schema ~= 1 or nextPayload.app ~= "tokitoki" then
      lastError = decodeError or "unsupported tokitoki widget payload"
      render()
      return
    end

    payload = nextPayload
    lastError = nil
    render()
  end)

  if not accepted then
    refreshing = false
    lastError = "could not start tokitoki"
    render()
  end
end

function update()
  noctalia.setUpdateInterval(30000)
  render()
  refresh()
end

function onClick()
  refresh()
end
