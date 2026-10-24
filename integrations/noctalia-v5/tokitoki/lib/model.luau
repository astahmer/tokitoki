local M = {}

function M.compact(value)
  local n = tonumber(value) or 0
  if n >= 1000000 then return string.format("%.1fM", n / 1000000) end
  if n >= 1000 then return string.format("%.1fk", n / 1000) end
  return tostring(math.floor(n))
end

-- Parse explicit ISO timezones without depending on the desktop's local timezone.
function M.epoch(value)
  if type(value) ~= "string" then return nil end
  local y, m, d, h, mi, s = string.match(value, "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)")
  if not y then return nil end
  y, m, d = tonumber(y), tonumber(m), tonumber(d)
  local offset = 0
  if string.sub(value, -1) ~= "Z" then
    local sign, oh, om = string.match(value, "([+-])(%d%d):(%d%d)$")
    if not sign then return nil end
    offset = (tonumber(oh) * 60 + tonumber(om)) * (if sign == "+" then 1 else -1)
  end
  if m < 1 or m > 12 or d < 1 or d > 31 or tonumber(h) > 23 or tonumber(mi) > 59 or tonumber(s) > 59 then return nil end
  y = y - (if m <= 2 then 1 else 0)
  local era = math.floor(y / 400)
  local year = y - era * 400
  local day = math.floor((153 * (m + (if m > 2 then -3 else 9)) + 2) / 5) + d - 1
  return ((era * 146097 + year * 365 + math.floor(year / 4) - math.floor(year / 100) + day - 719468) * 86400
    + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(s) - offset * 60) * 1000
end

function M.status(w, now)
  if w.status and w.status ~= "current" then return w.status end
  local endAt = M.epoch(w.resetsAt or w.windowEnd)
  if endAt and endAt <= now then return "expired" end
  return "current"
end

function M.percent(w, now)
  if w.source == "derived" or type(w.amountUsd) == "number" or M.status(w, now) ~= "current" then return nil end
  local n = w.usedPercent
  if n == nil then n = w.usedPct end
  if type(n) ~= "number" or n ~= n or math.abs(n) == math.huge then return nil end
  return math.clamp(100 - n, 0, 100)
end

function M.duration(w)
  local n = tonumber(w.windowMinutes)
  if n and n > 0 then return n end
  return nil
end

function M.windowLabel(w)
  local n = M.duration(w)
  local duration = "?"
  if n then
    if n < 60 then duration = tostring(n) .. "m"
    elseif n < 1440 then duration = string.format("%gh", n / 60)
    elseif n == 43200 then duration = "1mo"
    else duration = string.format("%gd", n / 1440) end
  end
  local label = w.label or w.kind or ""
  local bucket = w.model or (if label == "Other Models" then "API" elseif label == "On-Demand" then "OD" else "")
  return (if bucket ~= "" then bucket .. " " else "") .. duration
end

function M.countdown(w, now)
  local endAt = M.epoch(w.resetsAt or w.windowEnd)
  if not endAt or endAt <= now then return "" end
  local minutes = math.ceil((endAt - now) / 60000)
  if minutes >= 1440 then return string.format("%dd %dh", math.floor(minutes / 1440), math.floor(minutes % 1440 / 60)) end
  if minutes >= 60 then return string.format("%dh %dm", math.floor(minutes / 60), minutes % 60) end
  return tostring(minutes) .. "m"
end

function M.vendor(a)
  return a.vendor or (if a.provider == "codex" then "openai" elseif a.provider == "claude-code" then "anthropic" else a.provider) or "provider"
end

function M.logo(a)
  local vendor = M.vendor(a)
  return if vendor == "openai" then "codex" elseif vendor == "anthropic" then "claude-code" elseif vendor == "cursor" then "cursor" else nil
end

function M.vendorName(a)
  local vendor = M.vendor(a)
  return ({openai = "OpenAI", anthropic = "Anthropic", cursor = "Cursor", google = "Google", github = "GitHub"})[vendor] or vendor
end

function M.accounts(payload, selected, hideIdentities)
  local result = {}
  local hidden = (payload.uiPreview or {}).previewHidden or {}
  local function contains(list, value)
    for _, item in ipairs(list) do if item == value then return true end end
    return false
  end
  local function accountHidden(list, a)
    for _, entry in ipairs(list) do
      if entry == a.provider then return true end
      local provider, suffix = string.match(entry, "^([^:]+):(.+)$")
      if provider == a.provider and string.sub(a.accountKey, -#suffix) == suffix then return true end
    end
    return false
  end
  for _, a in ipairs(payload.limits or {}) do
    local id = a.provider .. "@" .. a.accountKey
    local barHidden = (payload.uiPreview or {}).menubarHidden or {}
    if not contains(hidden, id) and not contains(hidden, M.vendor(a)) and not contains(hidden, a.provider)
      and not accountHidden(barHidden, a)
      and (#selected == 0 or contains(selected, id)) then
      local copy = table.clone(a)
      copy.id = id
      copy.name = if hideIdentities then M.vendorName(a) else (a.label or a.accountKey)
      table.insert(result, copy)
    end
  end
  return result
end

function M.rows(a, shortest, now)
  local result = {}
  for _, w in ipairs(a.windows or {}) do
    if w.source ~= "derived" then table.insert(result, w) end
  end
  if shortest then
    local best = nil
    for _, w in ipairs(result) do
      local duration = M.duration(w)
      if M.percent(w, now) ~= nil and duration and (not best or duration < M.duration(best)) then best = w end
    end
    if best then return {best} end
    -- Keep the account visible even when it has no current observation.
    if #result > 0 then return {result[1]} end
  end
  return result
end

function M.value(w, now)
  local status = M.status(w, now)
  if status ~= "current" then return status end
  if type(w.amountUsd) == "number" then return string.format("$%.2f", w.amountUsd) end
  local remaining = M.percent(w, now)
  return if remaining ~= nil then string.format("%d%%", math.floor(remaining + 0.5)) else "unknown"
end

return M
