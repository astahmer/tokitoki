// Both the CLI payload and the versioned limits document use the same quota semantics.
function compact(value) {
    var n = Number(value || 0)
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.floor(n))
}
function status(w, now) {
    if (w.status && w.status !== "current") return w.status
    var end = Date.parse(w.resetsAt || w.windowEnd || "")
    return isFinite(end) && end <= now ? "expired" : "current"
}
function remaining(w, now) {
    if (w.source === "derived" || typeof w.amountUsd === "number" || status(w, now) !== "current") return null
    var n = w.usedPercent === undefined ? w.usedPct : w.usedPercent
    return typeof n === "number" && isFinite(n) ? Math.max(0, Math.min(100, 100 - n)) : null
}
function duration(w) {
    return Number(w.windowMinutes) > 0 ? Number(w.windowMinutes) : null
}
function label(w) {
    var n = duration(w)
    var time = !n ? "?" : n < 60 ? n + "m" : n < 1440 ? n / 60 + "h" : n === 43200 ? "1mo" : n / 1440 + "d"
    var bucket = w.model || (w.label === "Other Models" ? "API" : w.label === "On-Demand" ? "OD" : "")
    return (bucket ? bucket + " " : "") + time
}
function value(w, now) {
    var state = status(w, now)
    if (state !== "current") return state
    if (typeof w.amountUsd === "number") return "$" + w.amountUsd.toFixed(2)
    var n = remaining(w, now)
    return n === null ? "unknown" : Math.round(n) + "%"
}
function countdown(w, now) {
    var end = Date.parse(w.resetsAt || w.windowEnd || "")
    if (!isFinite(end) || end <= now) return ""
    var n = Math.ceil((end - now) / 60000)
    return n >= 1440 ? Math.floor(n / 1440) + "d " + Math.floor(n % 1440 / 60) + "h" : n >= 60 ? Math.floor(n / 60) + "h " + n % 60 + "m" : n + "m"
}
function windows(a, shortest, now) {
    var rows = (a.windows || []).filter(function(w) { return w.source !== "derived" })
    if (!shortest) return rows
    var candidates = rows.filter(function(w) { return remaining(w, now) !== null && duration(w) !== null })
    candidates.sort(function(a, b) { return duration(a) - duration(b) })
    return candidates.length ? [candidates[0]] : rows.slice(0, 1)
}
function globallyHidden(a, ui) {
    return ((ui || {}).menubarHidden || []).some(function(entry) {
        var index = entry.indexOf(":")
        return index < 0 ? entry === a.harness : entry.slice(0, index) === a.harness && a.accountKey.endsWith(entry.slice(index + 1))
    })
}
function accounts(doc, selected, hide, ui, surface) {
    ui = ui || {}
    hide = hide || ui.privacyHideIdentities
    var ids = selected.split(",").map(function(v) { return v.trim() }).filter(Boolean)
    var saved = surface === "cards" || surface === "all" ? (doc.accountOrder || []) : (ui.barAccountOrder || doc.accountOrder || [])
    var ordered = (doc.accounts || []).slice().sort(function(a, b) {
        var left = saved.indexOf(a.id), right = saved.indexOf(b.id)
        return (left < 0 ? saved.length : left) - (right < 0 ? saved.length : right)
    })
    return ordered.filter(function(a) {
        var hidden = surface !== "all" && (globallyHidden(a, ui) || (surface !== "cards" && ((ui.previewHidden || []).indexOf(a.vendor) >= 0 || (ui.barHiddenAccounts || []).indexOf(a.id) >= 0)))
        return !hidden && (!ids.length || ids.indexOf(a.id) >= 0)
    }).map(function(a) {
        var copy = Object.assign({}, a)
        copy.name = hide ? a.vendorName : (a.label || a.accountKey)
        return copy
    })
}
function moveOrder(doc, visible, id, direction) {
    var ids = visible.map(function(a) { return a.id })
    var index = ids.indexOf(id)
    var neighbour = ids[index + direction]
    if (index < 0 || !neighbour) return null
    var saved = (doc.accountOrder || []).slice()
    ;(doc.accounts || []).forEach(function(a) { if (saved.indexOf(a.id) < 0) saved.push(a.id) })
    var from = saved.indexOf(id), to = saved.indexOf(neighbour)
    saved[from] = neighbour
    saved[to] = id
    return saved
}
function logo(a) {
    return a.vendor === "openai" ? "codex" : a.vendor === "anthropic" ? "claude-code" : a.vendor === "cursor" ? "cursor" : ""
}
function accountBar(a, accounts, mode, now) {
    var count = accounts.filter(function(b) { return a.vendor === b.vendor }).length
    return (count > 1 ? a.name.slice(0, 2).toUpperCase() + ": " : "") + (windows(a, mode === "shortest", now).map(function(w) {
        return label(w) + " " + value(w, now)
    }).join(" · ") || "—")
}
function bar(accounts, mode, stats, now) {
    if (mode === "icon") return ""
    if (mode === "total") return "$" + Number(stats.costUsd || 0).toFixed(2) + " · " + compact(stats.tokens)
    return accounts.map(function(a) {
        var count = accounts.filter(function(b) { return a.vendor === b.vendor }).length
        var prefix = a.vendorName + (count > 1 ? " " + a.name.slice(0, 2).toUpperCase() + ":" : "")
        var rows = windows(a, mode === "shortest", now)
        return prefix + " " + (rows.map(function(w) { return label(w) + " " + value(w, now) }).join(" · ") || "—")
    }).join("  │  ") || "No provider quotas"
}
function tooltip(accounts, now) {
    return accounts.map(function(a) {
        return a.vendorName + " · " + a.name + "\n" + windows(a, false, now).map(function(w) {
            return "◷ " + label(w) + " " + value(w, now) + (countdown(w, now) ? " · " + countdown(w, now) : "")
        }).join("\n")
    }).join("\n────────────\n")
}
