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
function durationText(w) {
    var n = duration(w)
    return !n ? "?" : n < 60 ? n + "m" : n < 1440 ? n / 60 + "h" : n === 43200 ? "1mo" : n / 1440 + "d"
}
function label(w) {
    var time = durationText(w)
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
    // Qt's Array.sort is not stable: unsaved accounts keep source order explicitly.
    var source = (doc.accounts || []).map(function(a) { return a.id })
    var ordered = (doc.accounts || []).slice().sort(function(a, b) {
        var left = saved.indexOf(a.id), right = saved.indexOf(b.id)
        return (left < 0 ? saved.length : left) - (right < 0 ? saved.length : right) || source.indexOf(a.id) - source.indexOf(b.id)
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
function capitalize(text) {
    text = String(text || "")
    return text.charAt(0).toUpperCase() + text.slice(1)
}
// Popout card wording, shared with the DMS and Noctalia popouts.
function title(w) {
    var n = duration(w)
    var named = ({300: "Session", 1440: "Daily", 10080: "Weekly", 43200: "Monthly"})[n]
    var text = w.label === "Other Models" ? "API" : w.label ? String(w.label) : named || (n ? durationText(w) + " limit" : "Limit")
    return (w.model ? w.model + " · " : "") + capitalize(text)
}
function tone(w, now) {
    var n = remaining(w, now)
    return n === null ? "neutral" : n < 20 ? "rose" : n < 50 ? "amber" : "green"
}
function sourceText(w, now) {
    if (status(w, now) !== "current" || (remaining(w, now) === null && typeof w.amountUsd !== "number")) return ""
    return w.source === "provider" || w.source === "embedded" ? "Reported" : "Estimated"
}
function valueText(w, now) {
    var state = status(w, now)
    if (state !== "current") return capitalize(state)
    if (typeof w.amountUsd === "number") return "$" + w.amountUsd.toFixed(2)
    var n = remaining(w, now)
    if (n !== null) return Math.round(n) + "% left"
    return Number(w.tokens || 0) > 0 ? compact(w.tokens) + " tokens" : "Usage unknown"
}
function resetText(w, now) {
    if (status(w, now) !== "current") return "Awaiting fresh observation"
    var left = countdown(w, now)
    return left ? "Resets in " + left : ""
}
function issue(a) {
    var reason = String(a.refreshError || "")
    if (!reason) return null
    var login = /log ?in|sign ?in|auth|401|403|unauthori|credential|expired/i.test(reason)
    return {title: login ? "Login required" : "Refresh failed", reason: reason}
}
function plan(a) {
    return capitalize(a.planLabel || a.plan || "")
}
function banked(a, now) {
    var n = Math.floor(Number(a.bankedResets || 0))
    if (n <= 0) return ""
    var left = a.bankedExpiresAt ? countdown({resetsAt: a.bankedExpiresAt}, now) : ""
    return n + " banked reset" + (n === 1 ? "" : "s") + (left ? " · expires in " + left : "")
}
