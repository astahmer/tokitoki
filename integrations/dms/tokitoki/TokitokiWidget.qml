import QtQuick
import Quickshell
import Quickshell.Io
import "."
import qs.Common
import qs.Modules.Plugins
import qs.Widgets

PluginComponent {
    id: root

    property var payload: ({})
    property string errorText: "waiting for tokitoki"
    property string lastError: ""
    property bool scanNextRefresh: false
    property string searchText: ""
    property string selectedTab: "overview"
    property string selectedPeriod: "today"
    property string selectedMetric: "cost"
    property string historyPeriod: "month"
    property string compositionPeriod: "day"
    property bool stateReady: false
    property bool configOpen: false
    property string visibilityTarget: ""
    property bool visibilityHide: true
    property bool pendingRefresh: false
    readonly property string barSummaryMode: root.pluginSetting("barSummaryMode", "summary")
    readonly property string barTotalPeriod: root.normalizeChoice(
        root.pluginSetting("barTotalPeriod", "day"),
        ["day", "week", "month"],
        "day"
    )
    readonly property string providerVisibility: root.pluginSetting("providerVisibility", "all")
    readonly property string selectedProviders: root.pluginSetting("selectedProviders", "")
    readonly property var tabOptions: ["overview", "quotas", "tokens", "reports", "sources", "mcp", "settings"]
    readonly property var periodOptions: ["today", "yesterday", "week", "month", "year"]
    readonly property var historyPeriodOptions: ["day", "week", "month", "year"]
    readonly property var openingTabOptions: ["overview", "quotas", "tokens"]
    readonly property string openingTab: normalizeChoice(
        root.pluginSetting("openingTab", "overview"),
        root.openingTabOptions,
        "overview"
    )

    readonly property bool hasPayload: payload && payload.schema === 1 && payload.app === "tokitoki"
    readonly property bool isBusy: statusProcess.running
    readonly property bool hasLimits: hasPayload && Array.isArray(payload.limits) && payload.limits.length > 0
    readonly property bool hasHistory: hasPayload && payload.history &&
        Array.isArray(payload.history.days) && payload.history.days.length > 0
    readonly property bool hasHistoryYear: hasPayload && payload.historyYear &&
        Array.isArray(payload.historyYear.days) && payload.historyYear.days.length > 0
    readonly property bool hasHistoryData: hasHistory || hasHistoryYear
    readonly property bool hasActivityGrid: hasPayload && payload.activityGrid &&
        Array.isArray(payload.activityGrid.cells)
    readonly property bool privacyHideIdentities: root.pluginSetting("privacyHideIdentities", false)
    readonly property bool privacyHideRepoSessionNames: root.pluginSetting("privacyHideRepoSessionNames", false)
    readonly property bool autoRefreshEnabled: Boolean(root.pluginSetting("autoRefreshEnabled", true))
    readonly property int autoRefreshIntervalMinutes: {
        var value = Number(root.pluginSetting("autoRefreshIntervalMinutes", 5))
        if (value === 1 || value === 5 || value === 15 || value === 30)
            return value
        return 5
    }
    readonly property bool autoRefreshScansSources: Boolean(root.pluginSetting("autoRefreshScansSources", false))
    readonly property int autoRefreshIntervalMs: root.autoRefreshIntervalMinutes * 60000
    readonly property string commandOverride: String(root.pluginSetting("executablePath", ""))
    readonly property string command: commandOverride.length > 0 ? commandOverride : "tokitoki"
    readonly property var distributionSlices: root.buildSlices(root.selectedPeriod, root.selectedMetric)
    readonly property var tokenMixSlices: root.buildTokenMixSlices(root.compositionPeriod)
    readonly property var attentionItems: root.buildAttentionItems()
    readonly property var statusStripGroups: root.barSummaryMode === "icon" ||
        root.barSummaryMode === "total"
        ? [] : root.buildStatusStripGroups()

    layerNamespacePlugin: "tokitoki"

    function safeNumber(value) {
        var number = Number(value)
        return isFinite(number) ? number : 0
    }

    function compactNumber(value) {
        var number = safeNumber(value)
        var sign = number < 0 ? "-" : ""
        number = Math.abs(number)
        if (number >= 1000000000)
            return sign + trimDecimal((number / 1000000000).toFixed(1)) + "B"
        if (number >= 1000000)
            return sign + trimDecimal((number / 1000000).toFixed(1)) + "M"
        if (number >= 1000)
            return sign + trimDecimal((number / 1000).toFixed(1)) + "k"
        return sign + Math.round(number)
    }

    function trimDecimal(text) {
        return String(text).replace(/\.0$/, "")
    }

    function pluginSetting(key, defaultValue) {
        var value = pluginData ? pluginData[key] : undefined
        return value === undefined ? defaultValue : value
    }

    function displayLabel(value) {
        var text = String(value || "")
        if (text.length === 0)
            return text
        return text.charAt(0).toUpperCase() + text.slice(1)
    }

    function normalizeTab(tab, fallback) {
        return root.tabOptions.indexOf(tab) >= 0 ? tab : fallback
    }

    function normalizeChoice(value, choices, fallback) {
        return choices.indexOf(value) >= 0 ? value : fallback
    }

    function loadState(key, fallback) {
        if (!root.pluginService || !root.pluginId || !root.pluginService.loadPluginState)
            return fallback
        return root.pluginService.loadPluginState(root.pluginId, key, fallback)
    }

    function saveState(key, value) {
        if (!root.stateReady || !root.pluginService || !root.pluginId ||
                !root.pluginService.savePluginState)
            return
        root.pluginService.savePluginState(root.pluginId, key, value)
    }

    function openDashboard() {
        Qt.openUrlExternally("http://127.0.0.1:7788")
    }

    function metricLabel(metric) {
        return metric === "tokens" ? "Tokens" : "Cost"
    }

    function formatMoney(value) {
        return "$" + safeNumber(value).toFixed(2)
    }

    function selectedProviderList() {
        var raw = String(root.selectedProviders || "")
        if (raw.length === 0)
            return []
        return raw.split(",").map(function(item) {
            return item.trim().toLowerCase()
        }).filter(function(item) {
            return item.length > 0
        })
    }

    function providerIsSelected(provider, accountKey) {
        var list = selectedProviderList()
        var localProvider = String(provider || "").toLowerCase()
        var upstream = String(root.upstreamProvider(provider, accountKey) || "").toLowerCase()
        return list.length === 0 || list.indexOf(localProvider) >= 0 ||
            (upstream.length > 0 && list.indexOf(upstream) >= 0)
    }

    function totalTokens(row) {
        if (!row)
            return 0
        return safeNumber(row.inputTokens) +
            safeNumber(row.outputTokens) +
            safeNumber(row.cacheReadTokens) +
            safeNumber(row.cacheWriteTokens)
    }

    function cachePercent(report) {
        if (!report || !report.total)
            return 0
        var prompt = safeNumber(report.total.inputTokens) + safeNumber(report.total.cacheReadTokens)
        if (prompt <= 0)
            return 0
        return Math.round(safeNumber(report.total.cacheReadTokens) / prompt * 100)
    }

    function sumRows(rows) {
        var result = {
            bucket: "TOTAL",
            requests: 0,
            sessions: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0
        }
        if (!Array.isArray(rows))
            return result
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i]
            result.requests += safeNumber(row.requests)
            result.sessions += safeNumber(row.sessions)
            result.inputTokens += safeNumber(row.inputTokens)
            result.outputTokens += safeNumber(row.outputTokens)
            result.cacheReadTokens += safeNumber(row.cacheReadTokens)
            result.cacheWriteTokens += safeNumber(row.cacheWriteTokens)
            result.costUsd += safeNumber(row.costUsd)
        }
        return result
    }

    function reportFor(period) {
        if (!hasPayload)
            return null
        if (period === "today")
            return payload.today || null
        if (period === "week")
            return payload.week || null

        var periods = Array.isArray(payload.spendPeriods) ? payload.spendPeriods : []
        for (var i = 0; i < periods.length; i++) {
            if (periods[i].key === period)
                return {
                    period: period,
                    rows: Array.isArray(periods[i].rows) ? periods[i].rows : [],
                    total: sumRows(periods[i].rows)
                }
        }
        return null
    }

    function rowsForPeriod(period) {
        var report = reportFor(period)
        if (!report || !Array.isArray(report.rows))
            return []
        var query = searchText.trim().toLowerCase()
        var rows = report.rows.slice()
        if (query.length > 0 && !privacyHideRepoSessionNames) {
            rows = rows.filter(function(row) {
                return String(row.bucket || "").toLowerCase().indexOf(query) >= 0
            })
        }
        return rows.sort(function(a, b) {
            var metricA = safeNumber(selectedMetric === "cost" ? a.costUsd : totalTokens(a))
            var metricB = safeNumber(selectedMetric === "cost" ? b.costUsd : totalTokens(b))
            if (metricA !== metricB)
                return metricB - metricA
            return safeNumber(b.requests) - safeNumber(a.requests)
        })
    }

    function rowsFromReport(report) {
        if (!report || !Array.isArray(report.rows))
            return []
        var query = searchText.trim().toLowerCase()
        var rows = report.rows.slice()
        if (query.length > 0 && !privacyHideRepoSessionNames) {
            rows = rows.filter(function(row) {
                return String(row.bucket || "").toLowerCase().indexOf(query) >= 0
            })
        }
        return rows.sort(function(a, b) {
            return safeNumber(b.costUsd) - safeNumber(a.costUsd) ||
                totalTokens(b) - totalTokens(a)
        })
    }

    function paletteColor(name, index) {
        var colors = [
            Theme.warning,
            Theme.success,
            Theme.primary,
            Theme.secondary,
            Theme.error,
            Theme.tertiary,
            Theme.info
        ]
        if (index !== undefined && index >= 0)
            return colors[index % colors.length]

        var hash = 0
        var text = String(name || "")
        for (var i = 0; i < text.length; i++)
            hash = ((hash << 5) - hash) + text.charCodeAt(i)
        return colors[Math.abs(hash) % colors.length]
    }

    function buildSlices(period, metric) {
        var rows = rowsForPeriod(period)
        var values = []
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i]
            var value = metric === "cost" ? safeNumber(row.costUsd) : totalTokens(row)
            if (value > 0) {
                values.push({
                name: displayLabel(row.bucket || "unknown"),
                value: value,
                color: paletteColor(row.bucket, i)
                })
            }
        }
        return values.sort(function(a, b) {
            return b.value - a.value
        })
    }

    function tokenMixReport(period) {
        if (!hasPayload)
            return null
        if (period === "day")
            return payload.rollingDay || payload.today || null
        return reportFor(period)
    }

    function hasTokenMixReport(period) {
        var report = tokenMixReport(period)
        return Boolean(report && report.total)
    }

    function buildTokenMixSlices(period) {
        if (!hasPayload)
            return []
        var report = tokenMixReport(period)
        if (!report || !report.total)
            return []
        var values = [
            { name: "Input", value: safeNumber(report.total.inputTokens), color: Theme.info },
            { name: "Output", value: safeNumber(report.total.outputTokens), color: Theme.warning },
            { name: "Cache read", value: safeNumber(report.total.cacheReadTokens), color: Theme.success },
            { name: "Cache write", value: safeNumber(report.total.cacheWriteTokens), color: Theme.secondary }
        ]
        return values.filter(function(item) {
            return item.value > 0
        })
    }

    function tokenMixTotal() {
        return tokenMixSlices.reduce(function(sum, item) {
            return sum + item.value
        }, 0)
    }

    function metricTotal(period, metric) {
        var report = reportFor(period)
        if (!report)
            return 0
        if (metric === "cost")
            return safeNumber(report.total && report.total.costUsd)
        return totalTokens(report.total)
    }

    function barSummaryText() {
        if (root.barSummaryMode === "icon")
            return ""
        if (!hasPayload)
            return "tokitoki ?"
        if (root.barSummaryMode === "total") {
            var reportPeriod = root.barTotalPeriod === "day" ? "today" : root.barTotalPeriod
            var report = root.reportFor(reportPeriod)
            if (!report || !report.total)
                return "tokitoki ?"
            return compactNumber(totalTokens(report.total)) + " · " + formatMoney(report.total.costUsd)
        }
        var quota = ""
        if (hasLimits) {
            for (var i = 0; i < payload.limits.length; i++) {
                var account = payload.limits[i]
                if (!providerIsVisible(account.provider, account.accountKey))
                    continue
                var windows = Array.isArray(account.windows) ? account.windows : []
                for (var j = 0; j < windows.length; j++) {
                    var windowData = windows[j]
                    if (!hasUsedPercent(windowData))
                        continue
                    var remaining = Math.round(remainingPercent(windowData))
                    if (quota.length === 0 || remaining < Number(quota.replace("%", "")))
                        quota = remaining + "%"
                }
            }
        }
        var today = payload.today && payload.today.total ? payload.today.total : null
        var stats = today || payload.stats || ({})
        var parts = []
        if (quota.length > 0)
            parts.push(quota)
        parts.push(compactNumber(stats.tokens))
        parts.push(formatMoney(stats.costUsd))
        return parts.join(" · ")
    }

    function accountTarget(provider, accountKey) {
        return String(provider || "") + ":" + String(accountKey || "")
    }

    // Card-level hide reads Tokitoki's own config list, so the widget, the
    // macOS menubar app and `tokitoki ui --hide` all agree on one source.
    // Entries are "provider" or "provider:accountKey"; the account half is a
    // suffix match, mirroring the CLI (see uiToggles.matches).
    function hiddenEntryMatches(entry, provider, accountKey) {
        var text = String(entry || "")
        var at = text.indexOf(":")
        if (at <= 0)
            return text === String(provider || "")
        if (text.slice(0, at) !== String(provider || ""))
            return false
        return String(accountKey || "").endsWith(text.slice(at + 1))
    }

    function accountCardHidden(provider, accountKey) {
        var ui = payload.uiPreview || ({})
        var menubarHidden = Array.isArray(ui.menubarHidden) ? ui.menubarHidden : []
        for (var i = 0; i < menubarHidden.length; i++) {
            if (root.hiddenEntryMatches(menubarHidden[i], provider, accountKey))
                return true
        }
        return false
    }

    function setAccountHidden(provider, accountKey, hidden) {
        if (visibilityProcess.running)
            return
        visibilityTarget = root.accountTarget(provider, accountKey)
        visibilityHide = hidden
        visibilityProcess.running = true
    }

    function providerIsVisible(provider, accountKey) {
        var ui = payload.uiPreview || ({})
        var previewHidden = Array.isArray(ui.previewHidden) ? ui.previewHidden : []
        if (root.accountCardHidden(provider, accountKey))
            return false
        if (previewHidden.indexOf(upstreamProvider(provider, accountKey)) >= 0)
            return false
        return root.providerVisibility !== "selected" || providerIsSelected(provider, accountKey)
    }

    function periodLabel(period) {
        switch (period) {
        case "today": return "Today"
        case "yesterday": return "Yest"
        case "week": return "Week"
        case "month": return "Month"
        case "year": return "Year"
        default: return period
        }
    }

    function historyRangeLabel(period) {
        switch (period) {
        case "day": return "1 day"
        case "week": return "7 days"
        case "month": return "30 days"
        case "year": return "1 year"
        default: return period
        }
    }

    function compositionRangeLabel(period) {
        switch (period) {
        case "day": return "last 24h"
        case "week": return "7 days"
        case "month": return "30 days"
        case "year": return "1 year"
        default: return period
        }
    }

    function tabLabel(tab) {
        switch (tab) {
        case "overview": return "Overview"
        case "quotas": return "Quotas"
        case "tokens": return "Tokens"
        case "reports": return "Reports"
        case "sources": return "Sources"
        case "mcp": return "MCP"
        case "settings": return "Settings"
        default: return tab
        }
    }

    function tabIs(tab) {
        return selectedTab === tab
    }

    function restoreSelections() {
        selectedTab = normalizeTab(loadState("selectedTab", openingTab), openingTab)
        selectedPeriod = normalizeChoice(loadState("selectedPeriod", "today"), periodOptions, "today")
        selectedMetric = normalizeChoice(loadState("selectedMetric", "cost"), ["cost", "tokens"], "cost")
        historyPeriod = normalizeChoice(loadState("historyPeriod", "month"), historyPeriodOptions, "month")
        compositionPeriod = normalizeChoice(loadState("compositionPeriod", "day"), historyPeriodOptions, "day")
        stateReady = true
    }

    function providerName(provider) {
        switch (provider) {
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case "copilot": return "GitHub Copilot"
        case "openrouter": return "OpenRouter"
        case "opencode":
        case "opencode-go": return "OpenCode"
        case "gemini-cli": return "Gemini CLI"
        case "cursor": return "Cursor"
        case "commandcode": return "Command Code"
        case "pi": return "Pi"
        default: return provider || "Unknown provider"
        }
    }

    function harnessIcon(provider) {
        switch (provider) {
        case "codex": return "smart_toy"
        case "cursor": return "mouse"
        case "claude-code": return "psychology"
        case "copilot": return "assistant"
        case "opencode":
        case "opencode-go":
        case "commandcode": return "code"
        case "gemini-cli": return "auto_awesome"
        default: return "terminal"
        }
    }

    function accountPrimaryLabel(account) {
        if (privacyHideIdentities)
            return "Private account"
        if (account.email)
            return account.email
        if (account.credential)
            return providerName(account.provider) + " " + account.credential
        return providerName(account.provider)
    }

    function accountSecondaryLabel(account) {
        if (privacyHideIdentities)
            return providerName(account.provider) + " · identities hidden"
        var label = String(account.accountKey || "default")
        if (Array.isArray(account.alsoOn) && account.alsoOn.length > 0)
            label += " · via " + account.alsoOn.join(", ")
        return label
    }

    function matchesAccount(account) {
        var query = searchText.trim().toLowerCase()
        if (query.length === 0)
            return true
        return [
            account.provider,
            privacyHideIdentities ? "" : account.accountKey,
            privacyHideIdentities ? "" : account.email,
            privacyHideIdentities ? "" : account.credential
        ].some(function(value) {
            return String(value || "").toLowerCase().indexOf(query) >= 0
        })
    }

    function filteredLimits() {
        if (!hasLimits)
            return []
        return payload.limits.filter(function(account) {
            return matchesAccount(account) &&
                !root.accountCardHidden(account.provider, account.accountKey)
        })
    }

    function orderedWindows(windows) {
        if (!windows || windows.length === undefined)
            return []
        var order = { day: 0, week: 1, month: 2 }
        var ordered = []
        for (var i = 0; i < windows.length; i++)
            ordered.push(windows[i])
        return ordered.sort(function(a, b) {
            return (order[a.kind] === undefined ? 9 : order[a.kind]) -
                (order[b.kind] === undefined ? 9 : order[b.kind])
        })
    }

    function tokenScale(kind) {
        var maximum = 0
        if (!hasLimits)
            return maximum
        for (var i = 0; i < payload.limits.length; i++) {
            var windows = payload.limits[i].windows || []
            for (var j = 0; j < windows.length; j++) {
                if (windows[j].kind === kind)
                    maximum = Math.max(maximum, safeNumber(windows[j].tokens))
            }
        }
        return maximum
    }

    function hasUsedPercent(windowData) {
        return windowData && windowData.usedPct !== null &&
            windowData.usedPct !== undefined && isFinite(Number(windowData.usedPct))
    }

    function remainingPercent(windowData) {
        if (!hasUsedPercent(windowData))
            return 0
        return Math.max(0, Math.min(100, 100 - safeNumber(windowData.usedPct)))
    }

    function limitFraction(windowData) {
        if (hasUsedPercent(windowData))
            return remainingPercent(windowData) / 100
        var scale = tokenScale(windowData && windowData.kind)
        if (windowData && safeNumber(windowData.tokens) > 0 && scale > 0)
            return Math.max(0.05, Math.min(1, safeNumber(windowData.tokens) / scale))
        return 0
    }

    function limitColor(windowData) {
        if (!hasUsedPercent(windowData))
            return Theme.primary
        var remaining = remainingPercent(windowData)
        if (remaining < 20)
            return Theme.error
        if (remaining < 50)
            return Theme.warning
        return Theme.success
    }

    function windowName(kind) {
        switch (kind) {
        case "day": return "Daily"
        case "week": return "Weekly"
        case "month": return "Monthly"
        default: return kind || "Window"
        }
    }

    function sourceLabel(source) {
        return source === "embedded" ? "Reported" : "Estimated"
    }

    function limitValueLabel(windowData) {
        if (windowData && windowData.amountUsd !== null &&
                windowData.amountUsd !== undefined)
            return sourceLabel(windowData.source) + " · " + formatMoney(windowData.amountUsd)
        if (hasUsedPercent(windowData))
            return sourceLabel(windowData.source) + " · " + Math.round(remainingPercent(windowData)) + "% left"
        if (windowData && safeNumber(windowData.tokens) > 0)
            return "Estimated · " + compactNumber(windowData.tokens) + " tokens"
        return "No usage recorded"
    }

    function resetLabel(value) {
        if (!value)
            return ""
        var target = Date.parse(String(value))
        if (!isFinite(target))
            return ""
        var seconds = Math.max(0, (target - Date.now()) / 1000)
        if (seconds <= 30)
            return "Available now"
        if (seconds < 3600)
            return "Resets in " + Math.max(1, Math.round(seconds / 60)) + "m"
        if (seconds < 86400)
            return "Resets in " + Math.floor(seconds / 3600) + "h " + Math.round((seconds % 3600) / 60) + "m"
        return "Resets in " + Math.floor(seconds / 86400) + "d " + Math.round((seconds % 86400) / 3600) + "h"
    }

    function buildAttentionItems() {
        var items = []
        if (hasLimits) {
            for (var i = 0; i < payload.limits.length; i++) {
                var account = payload.limits[i]
                if (!providerIsVisible(account.provider, account.accountKey))
                    continue
                var windows = orderedWindows(account.windows)
                for (var j = 0; j < windows.length; j++) {
                    var windowData = windows[j]
                    if (hasUsedPercent(windowData) && remainingPercent(windowData) <= 10) {
                        items.push({
                            title: accountPrimaryLabel(account),
                            detail: windowName(windowData.kind) + " · " +
                                Math.round(remainingPercent(windowData)) + "% left" +
                                (resetLabel(windowData.resetsAt).length > 0 ? " · " + resetLabel(windowData.resetsAt) : "")
                        })
                        break
                    }
                }
            }
        }
        if (payload.spendHealth && payload.spendHealth.state !== "ok" &&
                payload.spendHealth.monthlyCap !== null &&
                payload.spendHealth.monthlyCap !== undefined) {
            items.push({
                title: "Monthly spend pace",
                detail: "Projected " + formatMoney(payload.spendHealth.projected) +
                    " / " + formatMoney(payload.spendHealth.monthlyCap)
            })
        }
        return items.slice(0, 3)
    }

    function relativeAge(value) {
        var timestamp = Date.parse(String(value || ""))
        if (!isFinite(timestamp))
            return "unknown"
        var seconds = Math.max(0, (Date.now() - timestamp) / 1000)
        if (seconds < 60)
            return "just now"
        if (seconds < 3600)
            return Math.floor(seconds / 60) + "m ago"
        if (seconds < 86400)
            return Math.floor(seconds / 3600) + "h ago"
        return Math.floor(seconds / 86400) + "d ago"
    }

    function freshnessText() {
        if (isBusy)
            return scanNextRefresh ? "Scanning local sources…" : "Reading saved payload…"
        if (!hasPayload)
            return errorText
        var updated = payload.snapshotAt ? "Updated " + relativeAge(payload.snapshotAt) : "Payload ready"
        if (lastError.length > 0)
            return updated + " · refresh warning"
        return updated
    }

    function barText() {
        return barSummaryText()
    }

    function detailText() {
        if (!hasPayload)
            return errorText
        var stats = payload.stats || ({})
        var label = payload.window && payload.window.label ? payload.window.label : "last 24h"
        return displayLabel(label) + " · " + compactNumber(stats.tokens) + " tokens · " +
            safeNumber(stats.requests) + " requests · " +
            safeNumber(stats.sessions) + " sessions · " +
            safeNumber(stats.cachePct) + "% cache"
    }

    function upstreamProvider(provider, accountKey) {
        switch (provider) {
        case "codex": return "openai"
        case "claude-code": return "claude"
        case "gemini-cli": return "gemini"
        case "grok": return "grok"
        case "cursor": return "cursor"
        case "copilot": return "copilot"
        case "openrouter": return "openrouter"
        case "openai":
        case "claude":
        case "gemini": return provider
        case "pi":
        case "opencode":
        case "opencode-go": {
            var key = String(accountKey || "").toLowerCase()
            if (key.indexOf("openrouter") >= 0)
                return "openrouter"
            if (provider === "opencode" || provider === "opencode-go" ||
                    key.indexOf("opencode") >= 0)
                return "opencode"
            return ""
        }
        default: return ""
        }
    }

    function barProviderLabel(provider) {
        switch (provider) {
        case "openai": return "OpenAI"
        case "claude": return "Claude"
        case "gemini": return "Gemini"
        case "grok": return "Grok"
        case "cursor": return "Cursor"
        case "copilot": return "Copilot"
        case "openrouter": return "OpenRouter"
        case "opencode": return "OpenCode"
        default: return displayLabel(provider)
        }
    }

    function barWindowLabel(kind) {
        switch (kind) {
        case "day": return "Day"
        case "week": return "Week"
        case "month": return "Month"
        default: return displayLabel(kind || "Limit")
        }
    }

    function windowRank(kind) {
        var text = String(kind || "").toLowerCase()
        if (text === "day" || text === "session" || text === "5h")
            return 0
        if (text === "week" || text === "weekly" || text === "7d")
            return 1
        if (text === "month" || text === "monthly" || text === "30d")
            return 2

        var match = text.match(/^(\\d+(?:\\.\\d+)?)\\s*(min|h|d|w|mo)$/)
        if (!match)
            return 50
        var value = Number(match[1])
        switch (match[2]) {
        case "min": return value
        case "h": return value * 60
        case "d": return value * 1440
        case "w": return value * 10080
        case "mo": return value * 43200
        default: return 50
        }
    }

    function todayUsageForProvider(provider) {
        var result = { tokens: 0, cost: 0, found: false }
        var report = payload.today || ({})
        var rows = Array.isArray(report.rows) ? report.rows : []
        for (var i = 0; i < rows.length; i++) {
            var bucket = String(rows[i].bucket || "").toLowerCase()
            var rowProvider = upstreamProvider(bucket, "")
            if (rowProvider !== provider && bucket !== provider)
                continue
            result.tokens += totalTokens(rows[i])
            result.cost += safeNumber(rows[i].costUsd)
            result.found = true
        }
        return result
    }

    function buildStatusStripGroups() {
        if (!hasLimits)
            return []

        var ui = payload.uiPreview || ({})
        var groups = []

        for (var i = 0; i < payload.limits.length; i++) {
            var account = payload.limits[i]
            var provider = upstreamProvider(account.provider, account.accountKey)
            if (provider.length === 0 || !providerIsVisible(account.provider, account.accountKey))
                continue

            var group = null
            for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
                if (groups[groupIndex].provider === provider) {
                    group = groups[groupIndex]
                    break
                }
            }
            if (!group) {
                group = {
                    provider: provider,
                    label: barProviderLabel(provider),
                    windows: []
                }
                groups.push(group)
            }

            var windows = Array.isArray(account.windows) ? account.windows : []
            for (var j = 0; j < windows.length; j++) {
                var windowData = windows[j]
                if (windowData.amountUsd !== null && windowData.amountUsd !== undefined) {
                    group.windows.push({
                        kind: String(windowData.kind || ""),
                        rank: windowRank(windowData.kind),
                        amount: formatMoney(windowData.amountUsd)
                    })
                } else if (hasUsedPercent(windowData)) {
                    group.windows.push({
                        kind: String(windowData.kind || ""),
                        rank: windowRank(windowData.kind),
                        remaining: Math.round(remainingPercent(windowData))
                    })
                }
            }
        }

        for (var summaryIndex = 0; summaryIndex < groups.length; summaryIndex++) {
            var summaryGroup = groups[summaryIndex]
            var quotaText = ""
            var percentWindows = summaryGroup.windows.filter(function(windowData) {
                return windowData.remaining !== undefined
            })
            if (percentWindows.length > 0) {
                var currentWindow = percentWindows[0]
                for (var windowIndex = 1; windowIndex < percentWindows.length; windowIndex++) {
                    var candidate = percentWindows[windowIndex]
                    if (candidate.rank < currentWindow.rank ||
                            (candidate.rank === currentWindow.rank && candidate.remaining < currentWindow.remaining))
                        currentWindow = candidate
                }
                quotaText = barWindowLabel(currentWindow.kind) + ": " + currentWindow.remaining + "%"
            } else if (summaryGroup.windows.length > 0) {
                var amountWindow = summaryGroup.windows[0]
                quotaText = barWindowLabel(amountWindow.kind) + " " + amountWindow.amount
            }

            var usage = todayUsageForProvider(summaryGroup.provider)
            var parts = []
            if (quotaText.length > 0)
                parts.push(quotaText)
            parts.push(compactNumber(usage.tokens))
            parts.push(formatMoney(usage.cost))
            summaryGroup.lines = [parts.join(" · ")]
        }

        return groups.filter(function(groupData) {
            return groupData.lines.length > 0
        })
    }

    function refresh(scan) {
        if (statusProcess.running) {
            pendingRefresh = true
            return
        }
        scanNextRefresh = Boolean(scan)
        statusProcess.running = true
    }

    function accept(raw) {
        if (raw.trim().length === 0) {
            if (hasPayload)
                lastError = "tokitoki returned an empty widget payload"
            else
                errorText = "tokitoki unavailable (check the DMS PATH)"
            return
        }
        try {
            var next = JSON.parse(raw)
            if (next.schema !== 1 || next.app !== "tokitoki")
                throw new Error("unsupported widget payload")
            payload = next
            errorText = ""
            lastError = ""
        } catch (error) {
            if (hasPayload)
                lastError = String(error)
            else
                errorText = String(error)
        }
    }

    Component.onCompleted: Qt.callLater(root.restoreSelections)

    onSelectedTabChanged: saveState("selectedTab", selectedTab)
    onSelectedPeriodChanged: saveState("selectedPeriod", selectedPeriod)
    onSelectedMetricChanged: saveState("selectedMetric", selectedMetric)
    onHistoryPeriodChanged: saveState("historyPeriod", historyPeriod)
    onCompositionPeriodChanged: saveState("compositionPeriod", compositionPeriod)

    horizontalBarPill: Component {
        Row {
            spacing: Theme.spacingS

            DankIcon {
                name: "monitoring"
                size: root.iconSize
                color: Theme.widgetIconColor
                anchors.verticalCenter: parent.verticalCenter
                visible: root.statusStripGroups.length === 0
            }

            StyledText {
                text: root.barText()
                color: Theme.widgetTextColor
                font.pixelSize: Theme.barTextSize(
                    root.barThickness,
                    root.barConfig?.fontScale,
                    root.barConfig?.maximizeWidgetText
                )
                font.weight: Font.Medium
                anchors.verticalCenter: parent.verticalCenter
                visible: root.statusStripGroups.length === 0 && root.barText().length > 0
            }

            Repeater {
                model: root.statusStripGroups

                delegate: Row {
                    property var groupData: modelData

                    spacing: Theme.spacingXS

                    Rectangle {
                        width: 1
                        height: Math.max(8, root.iconSize - Theme.spacingXXS)
                        radius: 0.5
                        color: Theme.withAlpha(Theme.outlineLight, 0.65)
                        anchors.verticalCenter: parent.verticalCenter
                        visible: index > 0
                    }

                    TokitokiProviderLogo {
                        provider: groupData.provider
                        size: root.iconSize
                        fallbackIcon: "monitoring"
                        fallbackColor: Theme.widgetIconColor
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    Row {
                        spacing: Theme.spacingXXS
                        anchors.verticalCenter: parent.verticalCenter

                        StyledText {
                            text: groupData.lines.join(" · ")
                            color: Theme.widgetTextColor
                            font.pixelSize: root.barTextSize(
                                root.barThickness,
                                root.barConfig?.fontScale,
                                root.barConfig?.maximizeWidgetText
                            )
                            font.weight: Font.DemiBold
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }
                }
            }
        }
    }

    verticalBarPill: Component {
        Column {
            spacing: Theme.spacingXXS

            DankIcon {
                name: "monitoring"
                size: root.iconSize
                color: Theme.widgetIconColor
                anchors.horizontalCenter: parent.horizontalCenter
            }

            StyledText {
                text: root.barText()
                color: Theme.widgetTextColor
                font.pixelSize: Theme.fontSizeSmall
                visible: root.barText().length > 0
                anchors.horizontalCenter: parent.horizontalCenter
            }
        }
    }

    popoutWidth: 520
    popoutHeight: root.parentScreen && root.parentScreen.height > 0
        ? Math.min(860, Math.max(620, root.parentScreen.height * 0.82))
        : 760

    popoutContent: Component {
        PopoutComponent {
            id: popout

            width: parent.width
            headerText: root.configOpen ? "Tokitoki Settings" : "Tokitoki Usage"
            showCloseButton: true

            headerActions: Component {
                DankActionButton {
                    buttonSize: 32
                    iconName: root.configOpen ? "close" : "more_vert"
                    iconSize: 18
                    iconColor: Theme.surfaceText
                    onClicked: root.configOpen = !root.configOpen
                }
            }

            Item {
                id: body

                width: parent.width
                implicitHeight: Math.max(0, root.popoutHeight - popout.headerHeight -
                    popout.detailsHeight - Theme.spacingXL)
                height: implicitHeight

                DankFlickable {
                    id: viewport

                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: footer.top
                    visible: !root.configOpen
                    clip: true
                    contentWidth: width
                    contentHeight: contentColumn.height + Theme.spacingS + Theme.spacingM

                    Column {
                        id: contentColumn

                        x: Theme.spacingM
                        y: Theme.spacingS
                        width: viewport.width - Theme.spacingM * 2
                        spacing: Theme.spacingM
                        height: childrenRect.height

                        Rectangle {
                            width: parent.width
                            visible: !root.hasPayload && root.errorText.length > 0
                            implicitHeight: errorColumn.height + Theme.spacingM * 2
                            height: visible ? implicitHeight : 0
                            radius: Theme.cornerRadius
                            color: Theme.withAlpha(Theme.error, 0.12)
                            border.width: 1
                            border.color: Theme.withAlpha(Theme.error, 0.45)

                            Column {
                                id: errorColumn

                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.top: parent.top
                                anchors.margins: Theme.spacingM
                                spacing: Theme.spacingS

                                Row {
                                    width: parent.width
                                    spacing: Theme.spacingXS

                                    DankIcon {
                                        name: "warning"
                                        size: Theme.iconSizeSmall
                                        color: Theme.error
                                        anchors.verticalCenter: parent.verticalCenter
                                    }

                                    StyledText {
                                        text: root.errorText
                                        width: Math.max(0, parent.width - retryButton.width - Theme.spacingM)
                                        color: Theme.error
                                        font.pixelSize: Theme.fontSizeMedium
                                        font.weight: Font.DemiBold
                                        wrapMode: Text.WordWrap
                                    }

                                    DankButton {
                                        id: retryButton
                                        text: "Retry"
                                        iconName: "refresh"
                                        buttonHeight: 30
                                        horizontalPadding: Theme.spacingS
                                        onClicked: root.refresh(true)
                                    }
                                }
                            }
                        }

                        Item {
                            width: parent.width
                            height: 24

                            Row {
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: Theme.spacingXS

                                Rectangle {
                                    width: 7
                                    height: 7
                                    radius: 3.5
                                    color: root.isBusy || root.lastError.length > 0
                                        ? Theme.warning
                                        : (root.hasPayload ? Theme.success : Theme.error)
                                    anchors.verticalCenter: parent.verticalCenter
                                }

                                StyledText {
                                    text: root.freshnessText()
                                    color: Theme.surfaceVariantText
                                    font.pixelSize: Theme.fontSizeSmall + 1
                                    anchors.verticalCenter: parent.verticalCenter
                                }
                            }

                            DankIcon {
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                name: "sync"
                                size: Theme.iconSizeSmall
                                color: Theme.warning
                                visible: root.isBusy
                            }
                        }

                        Rectangle {
                            width: parent.width
                            height: 36
                            radius: Theme.cornerRadius
                            color: Theme.withAlpha(Theme.surfaceContainerHigh, 0.62)
                            border.width: 1
                            border.color: Theme.outlineLight

                            Row {
                                anchors.fill: parent
                                anchors.leftMargin: Theme.spacingS
                                anchors.rightMargin: Theme.spacingS
                                spacing: Theme.spacingXS

                                DankIcon {
                                    name: "search"
                                    size: Theme.iconSizeSmall
                                    color: Theme.surfaceVariantText
                                    anchors.verticalCenter: parent.verticalCenter
                                }

                                TextInput {
                                    id: searchInput

                                    width: Math.max(0, parent.width - clearSearch.width - Theme.iconSizeSmall - Theme.spacingM)
                                    height: parent.height
                                    text: root.searchText
                                    color: Theme.surfaceText
                                    selectionColor: Theme.primary
                                    selectedTextColor: Theme.primaryText
                                    font.pixelSize: Theme.fontSizeMedium
                                    verticalAlignment: TextInput.AlignVCenter
                                    selectByMouse: true
                                    clip: true
                                    onTextChanged: {
                                        if (root.searchText !== text)
                                            root.searchText = text
                                    }

                                    Text {
                                        anchors.verticalCenter: parent.verticalCenter
                                        text: "Search harness, account, repo…"
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeMedium
                                        visible: searchInput.text.length === 0
                                    }

                                    MouseArea {
                                        anchors.fill: parent
                                        hoverEnabled: true
                                        acceptedButtons: Qt.NoButton
                                        cursorShape: Qt.IBeamCursor
                                    }
                                }

                                DankIcon {
                                    id: clearSearch
                                    name: "close"
                                    size: Theme.iconSizeSmall
                                    color: Theme.surfaceVariantText
                                    visible: root.searchText.length > 0
                                    anchors.verticalCenter: parent.verticalCenter

                                    MouseArea {
                                        anchors.fill: parent
                                        hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: {
                                            root.searchText = ""
                                            searchInput.text = ""
                                        }
                                    }
                                }
                            }
                        }

                        Item {
                            width: parent.width
                            height: 32
                            clip: true

                            Row {
                                anchors.left: parent.left
                                anchors.top: parent.top
                                spacing: Theme.spacingXXS

                                Repeater {
                                    model: root.tabOptions

                                    delegate: Rectangle {
                                        width: tabText.implicitWidth + Theme.spacingS * 2
                                        height: 30
                                        radius: 15
                                        color: root.tabIs(modelData)
                                            ? Theme.primaryContainer
                                            : Theme.withAlpha(Theme.surfaceText, 0.06)

                                        StyledText {
                                            id: tabText
                                            anchors.centerIn: parent
                                            text: root.tabLabel(modelData)
                                            color: root.tabIs(modelData)
                                                ? Theme.primary
                                                : Theme.surfaceVariantText
                                            font.pixelSize: Theme.fontSizeSmall + 1
                                            font.weight: root.tabIs(modelData)
                                                ? Font.DemiBold : Font.Normal
                                        }

                                        MouseArea {
                                            anchors.fill: parent
                                            hoverEnabled: true
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: root.selectedTab = modelData
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "DMS integration"
                            iconName: "settings"
                            visible: root.tabIs("settings")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    StyledText {
                                        width: parent.width
                                        text: "Display settings live in DMS Settings → Plugins. Tokitoki data, budgets, and provider configuration remain in Tokitoki's own config."
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeMedium
                                        wrapMode: Text.WordWrap
                                    }

                                    StyledText {
                                        width: parent.width
                                        text: "Executable override"
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                    }

                                    StyledText {
                                        width: parent.width
                                        text: root.command
                                        color: Theme.primary
                                        font.pixelSize: Theme.fontSizeMedium
                                        isMonospace: true
                                        wrapMode: Text.Wrap
                                    }

                                    StyledText {
                                        width: parent.width
                                        text: "Leave empty to use the default `tokitoki`; set a full path here in the DMS plugin settings for development."
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Activity today"
                            iconName: "analytics"
                            visible: root.tabIs("overview")
                            highlighted: true
                            contentComponent: Component {
                                Item {
                                    width: parent ? parent.width : 0
                                    implicitHeight: 92

                                    Row {
                                        anchors.fill: parent

                                        Item {
                                            width: parent.width * 0.48
                                            height: parent.height

                                            Column {
                                                anchors.left: parent.left
                                                anchors.top: parent.top
                                                spacing: Theme.spacingXXS

                                                Row {
                                                    spacing: Theme.spacingXS

                                                    Rectangle {
                                                        width: 7
                                                        height: 7
                                                        radius: 3.5
                                                        color: Theme.info
                                                        anchors.verticalCenter: parent.verticalCenter
                                                    }

                                                    StyledText {
                                                        text: "Activity today"
                                                        color: Theme.surfaceVariantText
                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                        font.weight: Font.DemiBold
                                                    }
                                                }

                                                StyledText {
                                                    text: root.formatMoney(root.reportFor("today") &&
                                                        root.reportFor("today").total.costUsd)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeXLarge + 8
                                                    font.weight: Font.Bold
                                                    isMonospace: true
                                                }

                                                StyledText {
                                                    text: root.reportFor("today")
                                                        ? root.compactNumber(root.reportFor("today").total.requests) + " requests"
                                                        : "loading…"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                }
                                            }
                                        }

                                        Column {
                                            width: parent.width * 0.52
                                            spacing: Theme.spacingXS

                                            Row {
                                                width: parent.width
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    text: "This week"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                }
                                                Item {
                                                    width: Math.max(0, parent.width - weekValue.width - parent.spacing * 2)
                                                }
                                                StyledText {
                                                    id: weekValue
                                                    text: root.reportFor("week")
                                                        ? root.formatMoney(root.reportFor("week").total.costUsd)
                                                        : "—"
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    font.weight: Font.DemiBold
                                                    isMonospace: true
                                                }
                                            }

                                            Row {
                                                width: parent.width
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    text: "Month to date"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                }
                                                Item {
                                                    width: Math.max(0, parent.width - monthValue.width - parent.spacing * 2)
                                                }
                                                StyledText {
                                                    id: monthValue
                                                    text: root.payload.spendHealth
                                                        ? root.formatMoney(root.payload.spendHealth.monthToDate)
                                                        : "—"
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    font.weight: Font.DemiBold
                                                    isMonospace: true
                                                }
                                            }

                                            Row {
                                                width: parent.width
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    text: "Burn · projected"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                }
                                                Item {
                                                    width: Math.max(0, parent.width - burnValue.width - parent.spacing * 2)
                                                }
                                                StyledText {
                                                    id: burnValue
                                                    text: root.payload.spendHealth
                                                        ? root.formatMoney(root.payload.spendHealth.perDay) +
                                                            " → " + root.formatMoney(root.payload.spendHealth.projected)
                                                        : "—"
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    font.weight: Font.DemiBold
                                                    isMonospace: true
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Needs attention"
                            iconName: "warning"
                            visible: root.tabIs("overview") && root.attentionItems.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.attentionItems

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                DankIcon {
                                                    name: "error"
                                                    size: Theme.iconSizeSmall
                                                    color: Theme.warning
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    text: modelData.title
                                                    width: Math.max(0, parent.width - detail.width - Theme.spacingM)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: detail
                                                    text: modelData.detail
                                                    color: Theme.warning
                                                    font.pixelSize: Theme.fontSizeSmall - 1
                                                    isMonospace: true
                                                    horizontalAlignment: Text.AlignRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Usage limits"
                            iconName: "speed"
                            visible: root.tabIs("quotas") && root.filteredLimits().length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    Repeater {
                                        model: root.filteredLimits()

                                        delegate: Rectangle {
                                            id: accountCard

                                            property var account: modelData
                                            property var accountWindows: root.orderedWindows(account.windows)
                                            width: parent.width
                                            implicitHeight: accountContent.childrenRect.height + Theme.spacingS * 2
                                            height: implicitHeight
                                            radius: Theme.cornerRadius
                                            color: Theme.withAlpha(Theme.surfaceContainer, 0.58)
                                            border.width: 1
                                            border.color: Theme.outlineLight

                                            Column {
                                                id: accountContent

                                                anchors.left: parent.left
                                                anchors.right: parent.right
                                                anchors.top: parent.top
                                                anchors.margins: Theme.spacingS
                                                spacing: Theme.spacingS

                                                Row {
                                                    id: accountHeader

                                                    width: parent.width
                                                    height: 30
                                                    spacing: Theme.spacingXS

                                                    TokitokiProviderLogo {
                                                        provider: accountCard.account.provider
                                                        size: Theme.iconSizeLarge
                                                        showBackground: true
                                                        fallbackIcon: "account_circle"
                                                        fallbackColor: Theme.primary
                                                        anchors.verticalCenter: parent.verticalCenter
                                                    }

                                                    Column {
                                                        width: Math.max(0, accountHeader.width - planBadge.width -
                                                            hideButton.width - 36 - Theme.spacingM * 2)
                                                        spacing: 0
                                                        anchors.verticalCenter: parent.verticalCenter

                                                        StyledText {
                                                            width: parent.width
                                                            text: root.accountPrimaryLabel(accountCard.account)
                                                            color: Theme.surfaceText
                                                            font.pixelSize: Theme.fontSizeMedium
                                                            font.weight: Font.Medium
                                                            elide: Text.ElideRight
                                                        }

                                                        StyledText {
                                                            width: parent.width
                                                            text: root.accountSecondaryLabel(accountCard.account)
                                                            color: Theme.surfaceVariantText
                                                            font.pixelSize: Theme.fontSizeSmall + 1
                                                            elide: Text.ElideRight
                                                        }
                                                    }

                                                    Rectangle {
                                                        id: planBadge
                                                        width: accountCard.account.planLabel
                                                            ? planText.implicitWidth + Theme.spacingS * 2
                                                            : 0
                                                        height: accountCard.account.planLabel ? 22 : 0
                                                        radius: 11
                                                        color: Theme.withAlpha(Theme.surfaceText, 0.08)
                                                        visible: accountCard.account.planLabel
                                                        anchors.verticalCenter: parent.verticalCenter

                                                        StyledText {
                                                            id: planText
                                                            anchors.centerIn: parent
                                                            text: accountCard.account.planLabel
                                                                ? String(accountCard.account.planLabel).toUpperCase()
                                                                : ""
                                                            color: Theme.surfaceVariantText
                                                            font.pixelSize: Theme.fontSizeSmall
                                                            font.weight: Font.DemiBold
                                                        }
                                                    }

                                                    DankActionButton {
                                                        id: hideButton
                                                        buttonSize: 26
                                                        iconSize: 16
                                                        iconName: "visibility_off"
                                                        iconColor: Theme.surfaceVariantText
                                                        tooltipText: "Hide this account"
                                                        anchors.verticalCenter: parent.verticalCenter
                                                        onClicked: root.setAccountHidden(
                                                            accountCard.account.provider,
                                                            accountCard.account.accountKey,
                                                            true
                                                        )
                                                    }
                                                }

                                                Column {
                                                    id: quotaRows
                                                    width: parent.width
                                                    height: childrenRect.height
                                                    spacing: 0

                                                    Repeater {
                                                        model: accountCard.accountWindows.length

                                                        delegate: TokitokiListRow {
                                                            property var windowData: accountCard.accountWindows[index]
                                                            width: parent.width
                                                            rowHeight: windowContent.implicitHeight + 5
                                                            verticalPadding: 0
                                                            showSurface: false

                                                            Column {
                                                                id: windowContent
                                                                anchors.fill: parent
                                                                spacing: Theme.spacingXXS

                                                                Row {
                                                                    width: parent.width
                                                                    spacing: Theme.spacingXS

                                                                    StyledText {
                                                                        text: root.windowName(windowData.kind)
                                                                        color: Theme.surfaceVariantText
                                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                                        font.weight: Font.Medium
                                                                        anchors.verticalCenter: parent.verticalCenter
                                                                    }

                                                                    Item {
                                                                        width: Math.max(0, parent.width - valueText.width - parent.spacing)
                                                                    }

                                                                    StyledText {
                                                                        id: valueText
                                                                        text: root.limitValueLabel(windowData)
                                                                        color: root.hasUsedPercent(windowData)
                                                                            ? root.limitColor(windowData)
                                                                            : Theme.surfaceVariantText
                                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                                        font.weight: Font.DemiBold
                                                                        isMonospace: true
                                                                        anchors.verticalCenter: parent.verticalCenter
                                                                    }
                                                                }

                                                                Rectangle {
                                                                    id: limitTrack
                                                                    width: parent.width
                                                                    height: 5
                                                                    radius: 2.5
                                                                    color: Theme.withAlpha(Theme.surfaceText, 0.12)

                                                                    Rectangle {
                                                                        width: limitTrack.width * root.limitFraction(windowData)
                                                                        height: parent.height
                                                                        radius: parent.radius
                                                                        color: root.limitColor(windowData)
                                                                    }
                                                                }

                                                                StyledText {
                                                                    width: parent.width
                                                                    text: root.resetLabel(windowData.resetsAt)
                                                                    color: Theme.surfaceVariantText
                                                                    font.pixelSize: Theme.fontSizeSmall
                                                                    horizontalAlignment: Text.AlignRight
                                                                    visible: text.length > 0
                                                                }
                                                            }
                                                        }
                                                    }
                                                }

                                                StyledText {
                                                    text: accountCard.account.bankedResets > 0
                                                        ? accountCard.account.bankedResets + " banked reset" +
                                                            (accountCard.account.bankedResets === 1 ? "" : "s")
                                                        : ""
                                                    color: Theme.success
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    visible: accountCard.account.bankedResets > 0
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Usage distribution"
                            iconName: "pie_chart"
                            visible: (root.tabIs("overview") || root.tabIs("tokens")) &&
                                root.distributionSlices.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    Row {
                                        width: parent.width
                                        spacing: Theme.spacingXXS

                                        Repeater {
                                            model: root.periodOptions

                                            delegate: Rectangle {
                                                width: periodText.implicitWidth + Theme.spacingS * 2
                                                height: 26
                                                radius: 13
                                                color: root.selectedPeriod === modelData
                                                    ? Theme.primaryContainer
                                                    : Theme.withAlpha(Theme.surfaceText, 0.06)

                                                StyledText {
                                                    id: periodText
                                                    anchors.centerIn: parent
                                                    text: root.periodLabel(modelData)
                                                    color: root.selectedPeriod === modelData
                                                        ? Theme.primary
                                                        : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    font.weight: root.selectedPeriod === modelData
                                                        ? Font.DemiBold : Font.Normal
                                                }

                                                MouseArea {
                                                    anchors.fill: parent
                                                    hoverEnabled: true
                                                    cursorShape: Qt.PointingHandCursor
                                                    onClicked: root.selectedPeriod = modelData
                                                }
                                            }
                                        }

                                        Item {
                                            width: Theme.spacingS
                                            height: 1
                                        }

                                        Rectangle {
                                            id: metricSeparator
                                            width: 2
                                            height: 20
                                            radius: 1
                                            color: Theme.primary
                                            opacity: 0.8
                                            anchors.verticalCenter: parent.verticalCenter
                                        }

                                        Item {
                                            width: Theme.spacingS
                                            height: 1
                                        }

                                        Row {
                                            id: metricGroup
                                            spacing: Theme.spacingXXS

                                            Repeater {
                                                model: ["cost", "tokens"]

                                                delegate: Rectangle {
                                                    width: metricText.implicitWidth + Theme.spacingS * 2
                                                    height: 26
                                                    radius: 13
                                                    color: root.selectedMetric === modelData
                                                        ? Theme.primaryContainer
                                                        : Theme.withAlpha(Theme.surfaceText, 0.06)

                                                    StyledText {
                                                        id: metricText
                                                        anchors.centerIn: parent
                                                        text: root.metricLabel(modelData)
                                                        color: root.selectedMetric === modelData
                                                            ? Theme.primary
                                                            : Theme.surfaceVariantText
                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                        font.weight: root.selectedMetric === modelData
                                                            ? Font.DemiBold : Font.Normal
                                                    }

                                                    MouseArea {
                                                        anchors.fill: parent
                                                        hoverEnabled: true
                                                        cursorShape: Qt.PointingHandCursor
                                                        onClicked: root.selectedMetric = modelData
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    Row {
                                        width: parent.width
                                        height: 122
                                        spacing: Theme.spacingM

                                        TokitokiDonutChart {
                                            width: 116
                                            height: 116
                                            slices: root.distributionSlices
                                            centerLabel: root.selectedMetric === "cost"
                                                ? root.formatMoney(root.metricTotal(
                                                    root.selectedPeriod, root.selectedMetric
                                                ))
                                                : root.compactNumber(root.metricTotal(
                                                    root.selectedPeriod, root.selectedMetric
                                                ))
                                            centerUnit: root.metricLabel(root.selectedMetric)
                                        }

                                        Column {
                                            width: Math.max(0, parent.width - 116 - parent.spacing)
                                            spacing: Theme.spacingXXS
                                            anchors.verticalCenter: parent.verticalCenter

                                            Repeater {
                                                model: root.distributionSlices.slice(0, 6)

                                                delegate: Row {
                                                    width: parent.width
                                                    spacing: Theme.spacingXXS

                                                    Rectangle {
                                                        width: 7
                                                        height: 7
                                                        radius: 3.5
                                                        color: modelData.color
                                                        anchors.verticalCenter: parent.verticalCenter
                                                    }

                                                    StyledText {
                                                        text: modelData.name
                                                        width: Math.max(0, parent.width - value.width - 11)
                                                        color: Theme.surfaceText
                                                        font.pixelSize: Theme.fontSizeMedium
                                                        elide: Text.ElideRight
                                                    }

                                                    StyledText {
                                                        id: value
                                                        text: root.selectedMetric === "cost"
                                                            ? root.formatMoney(modelData.value)
                                                            : root.compactNumber(modelData.value)
                                                        color: Theme.surfaceVariantText
                                                        font.pixelSize: Theme.fontSizeMedium
                                                        isMonospace: true
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Token composition · " + root.compositionRangeLabel(root.compositionPeriod)
                            iconName: "data_usage"
                            visible: root.tabIs("tokens") && (root.hasTokenMixReport("day") ||
                                root.hasTokenMixReport("week") || root.hasTokenMixReport("month") ||
                                root.hasTokenMixReport("year"))
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    Row {
                                        width: parent.width
                                        height: 26
                                        spacing: Theme.spacingXXS

                                        Repeater {
                                            model: root.historyPeriodOptions

                                            delegate: Rectangle {
                                                width: compositionPeriodText.implicitWidth + Theme.spacingS * 2
                                                height: 26
                                                radius: 13
                                                color: root.compositionPeriod === modelData
                                                    ? Theme.primaryContainer
                                                    : Theme.withAlpha(Theme.surfaceText, 0.06)

                                                StyledText {
                                                    id: compositionPeriodText
                                                    anchors.centerIn: parent
                                                    text: root.historyRangeLabel(modelData)
                                                    color: root.compositionPeriod === modelData
                                                        ? Theme.primary
                                                        : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    font.weight: root.compositionPeriod === modelData
                                                        ? Font.DemiBold : Font.Normal
                                                }

                                                MouseArea {
                                                    anchors.fill: parent
                                                    hoverEnabled: true
                                                    cursorShape: Qt.PointingHandCursor
                                                    onClicked: root.compositionPeriod = modelData
                                                }
                                            }
                                        }
                                    }

                                    Item {
                                        width: parent.width
                                        height: 122

                                        Row {
                                            anchors.fill: parent
                                            spacing: Theme.spacingM

                                            TokitokiDonutChart {
                                                width: 116
                                                height: 116
                                                slices: root.tokenMixSlices
                                                centerLabel: root.compactNumber(root.tokenMixTotal())
                                                centerUnit: "Tokens"
                                            }

                                            Column {
                                                width: Math.max(0, parent.width - 116 - parent.spacing)
                                                spacing: Theme.spacingXS
                                                anchors.verticalCenter: parent.verticalCenter

                                                Repeater {
                                                    model: root.tokenMixSlices

                                                    delegate: Row {
                                                        width: parent.width
                                                        spacing: Theme.spacingXXS

                                                        Rectangle {
                                                            width: 7
                                                            height: 7
                                                            radius: 3.5
                                                            color: modelData.color
                                                            anchors.verticalCenter: parent.verticalCenter
                                                        }

                                                        StyledText {
                                                            text: modelData.name
                                                            width: Math.max(0, parent.width - value.width - 11)
                                                            color: Theme.surfaceText
                                                            font.pixelSize: Theme.fontSizeMedium
                                                            elide: Text.ElideRight
                                                        }

                                                        StyledText {
                                                            id: value
                                                            text: root.compactNumber(modelData.value)
                                                            color: Theme.surfaceVariantText
                                                            font.pixelSize: Theme.fontSizeMedium
                                                            isMonospace: true
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Usage history · " + root.historyRangeLabel(root.historyPeriod)
                            iconName: "analytics"
                            visible: root.tabIs("tokens") && root.hasHistoryData
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    Row {
                                        width: parent.width
                                        spacing: Theme.spacingXXS

                                        Repeater {
                                            model: root.historyPeriodOptions

                                            delegate: Rectangle {
                                                width: historyPeriodText.implicitWidth + Theme.spacingS * 2
                                                height: 26
                                                radius: 13
                                                color: root.historyPeriod === modelData
                                                    ? Theme.primaryContainer
                                                    : Theme.withAlpha(Theme.surfaceText, 0.06)

                                                StyledText {
                                                    id: historyPeriodText
                                                    anchors.centerIn: parent
                                                    text: root.historyRangeLabel(modelData)
                                                    color: root.historyPeriod === modelData
                                                        ? Theme.primary
                                                        : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    font.weight: root.historyPeriod === modelData
                                                        ? Font.DemiBold : Font.Normal
                                                }

                                                MouseArea {
                                                    anchors.fill: parent
                                                    hoverEnabled: true
                                                    cursorShape: Qt.PointingHandCursor
                                                    onClicked: root.historyPeriod = modelData
                                                }
                                            }
                                        }
                                    }

                                    TokitokiHistoryChart {
                                        width: parent.width
                                        history: root.payload.history
                                        extendedHistory: root.payload.historyYear
                                        period: root.historyPeriod
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Activity · last year"
                            iconName: "calendar_month"
                            visible: root.tabIs("reports") && root.hasActivityGrid
                            contentComponent: Component {
                                TokitokiActivityGrid {
                                    width: parent ? parent.width : 0
                                    payload: root.payload.activityGrid
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Today by harness"
                            iconName: "apps"
                            visible: (root.tabIs("overview") || root.tabIs("sources")) &&
                                root.rowsForPeriod("today").length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    Repeater {
                                        model: root.rowsForPeriod("today").slice(0, 7)

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                TokitokiProviderLogo {
                                                    provider: modelData.bucket
                                                    size: Theme.iconSizeSmall
                                                    fallbackIcon: root.harnessIcon(modelData.bucket)
                                                    fallbackColor: root.paletteColor(modelData.bucket)
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    text: root.providerName(modelData.bucket)
                                                    width: Math.max(0, parent.width - requests.width - cost.width - Theme.spacingM * 2)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: requests
                                                    text: root.compactNumber(modelData.requests) + " req"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: cost
                                                    text: root.formatMoney(modelData.costUsd)
                                                    color: root.safeNumber(modelData.costUsd) > 0
                                                        ? Theme.surfaceText : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    isMonospace: true
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Top repos this month"
                            iconName: "folder"
                            visible: (root.tabIs("overview") || root.tabIs("reports") ||
                                root.tabIs("sources")) && root.hasPayload &&
                                root.rowsFromReport(root.payload.reposMonth).length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    Repeater {
                                        model: root.rowsFromReport(root.payload.reposMonth).slice(0, 6)

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                StyledText {
                                                    text: root.privacyHideRepoSessionNames
                                                        ? "Private repository"
                                                        : String(modelData.bucket || "").split("/").pop()
                                                    width: Math.max(0, parent.width - usage.width)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: usage
                                                    text: root.safeNumber(modelData.costUsd) >= 0.01
                                                        ? root.formatMoney(modelData.costUsd) + " · " +
                                                            root.compactNumber(root.totalTokens(modelData))
                                                        : root.compactNumber(root.totalTokens(modelData)) + " tokens"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Top tools today"
                            iconName: "build"
                            visible: (root.tabIs("overview") || root.tabIs("sources") ||
                                root.tabIs("mcp")) && root.hasPayload && root.payload.topTools &&
                                Array.isArray(root.payload.topTools.tools) &&
                                root.payload.topTools.tools.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    Repeater {
                                        model: root.hasPayload && root.payload.topTools
                                            ? root.payload.topTools.tools.slice(0, 6)
                                            : []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                StyledText {
                                                    text: modelData.tool
                                                    width: Math.max(0, parent.width - toolValue.width)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: toolValue
                                                    text: root.safeNumber(modelData.costUsd) >= 0.01
                                                        ? root.formatMoney(modelData.costUsd)
                                                        : root.compactNumber(modelData.tokens)
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Budget status"
                            iconName: "speed"
                            visible: root.tabIs("reports") && root.hasPayload &&
                                Array.isArray(root.payload.budgets) &&
                                root.payload.budgets.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.budgets || []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                DankIcon {
                                                    name: modelData.state === "exceeded" ? "error" : "speed"
                                                    size: Theme.iconSizeSmall
                                                    color: root.stateColor(modelData.state)
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    text: modelData.label
                                                    width: Math.max(0, parent.width - budgetValue.width - Theme.spacingM)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: budgetValue
                                                    text: root.formatMoney(modelData.used) + " / " +
                                                        root.formatMoney(modelData.cap)
                                                    color: root.stateColor(modelData.state)
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Anomalies"
                            iconName: "warning"
                            visible: (root.tabIs("overview") || root.tabIs("reports")) &&
                                root.hasPayload && root.payload.anomalies &&
                                Array.isArray(root.payload.anomalies.anomalies) &&
                                root.payload.anomalies.anomalies.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.anomalies ? root.payload.anomalies.anomalies.slice(0, 4) : []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            rowHeight: 32

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                DankIcon {
                                                    name: "warning"
                                                    size: Theme.iconSizeSmall
                                                    color: Theme.warning
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    text: modelData.day + " · " + root.compactNumber(modelData.value) + " " +
                                                        root.displayLabel(modelData.metric)
                                                    width: Math.max(0, parent.width - ratio.width - parent.spacing)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    id: ratio
                                                    text: root.safeNumber(modelData.ratio).toFixed(1) + "× baseline"
                                                    width: Math.min(implicitWidth, parent.width * 0.42)
                                                    color: Theme.warning
                                                    font.pixelSize: Theme.fontSizeSmall - 1
                                                    isMonospace: true
                                                    horizontalAlignment: Text.AlignRight
                                                    elide: Text.ElideRight
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Statusline preview"
                            iconName: "terminal"
                            visible: root.tabIs("reports") && root.hasPayload &&
                                root.payload.statuslinePreview
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    StyledText {
                                        width: parent.width
                                        text: root.payload.statuslinePreview.preview
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeMedium
                                        isMonospace: true
                                        elide: Text.ElideRight
                                    }

                                    StyledText {
                                        width: parent.width
                                        text: root.payload.statuslinePreview.command
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        isMonospace: true
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Billing blocks · active timeline"
                            iconName: "schedule"
                            visible: root.tabIs("reports") && root.hasPayload && root.payload.blocks &&
                                Array.isArray(root.payload.blocks.rows) &&
                                root.payload.blocks.rows.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.blocks ? root.payload.blocks.rows.slice(0, 6) : []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            rowHeight: 44

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                Rectangle {
                                                    width: 7
                                                    height: 7
                                                    radius: 3.5
                                                    color: modelData.isActive ? Theme.success : Theme.surfaceVariantText
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                Column {
                                                    width: Math.max(0, parent.width - blockValue.width - Theme.spacingM)
                                                    spacing: 0
                                                    anchors.verticalCenter: parent.verticalCenter

                                                StyledText {
                                                    text: root.privacyHideIdentities
                                                        ? "Private account" + (modelData.isActive ? " · active" : "")
                                                        : String(modelData.accountKey || "default") +
                                                            (modelData.isActive ? " · active" : "")
                                                    width: parent.width
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                }

                                                    StyledText {
                                                        text: root.relativeAge(modelData.startIso) + " · " +
                                                            root.compactNumber(modelData.requests) + " requests"
                                                        color: Theme.surfaceVariantText
                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                    }
                                                }

                                                StyledText {
                                                    id: blockValue
                                                    text: modelData.isActive
                                                        ? "active" : root.compactNumber(modelData.tokens)
                                                    color: modelData.isActive ? Theme.success : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Other machines"
                            iconName: "lan"
                            visible: root.tabIs("reports") && root.hasPayload &&
                                Array.isArray(root.payload.presence) &&
                                root.payload.presence.some(function(machine) {
                                    return (Date.now() - root.safeNumber(machine.ts) * 1000) < 600000
                                })
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.presence || []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            visible: (Date.now() - root.safeNumber(modelData.ts) * 1000) < 600000
                                            height: visible ? rowHeight : 0

                                            Row {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                Rectangle {
                                                    width: 7
                                                    height: 7
                                                    radius: 3.5
                                                    color: Theme.success
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    text: modelData.host || modelData.machineId
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }

                                                StyledText {
                                                    text: "Active · " + root.relativeAge(new Date(root.safeNumber(modelData.ts) * 1000).toISOString())
                                                    color: Theme.success
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    anchors.verticalCenter: parent.verticalCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Recent sessions"
                            iconName: "chat_bubble"
                            visible: root.tabIs("sources") && root.hasPayload && root.payload.recentSessions &&
                                Array.isArray(root.payload.recentSessions.rows) &&
                                root.payload.recentSessions.rows.length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    Repeater {
                                        model: root.payload.recentSessions
                                            ? root.payload.recentSessions.rows.slice(0, 5)
                                            : []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            rowHeight: 48

                                            Column {
                                                anchors.fill: parent
                                                spacing: 1

                                                Row {
                                                    width: parent.width
                                                    spacing: Theme.spacingXS

                                                StyledText {
                                                    text: root.privacyHideRepoSessionNames
                                                        ? "Private session"
                                                        : modelData.title || "(no title)"
                                                    width: Math.max(0, parent.width - sessionValue.width)
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    font.weight: Font.Medium
                                                    elide: Text.ElideRight
                                                    }

                                                    StyledText {
                                                        id: sessionValue
                                                        text: root.compactNumber(modelData.totalTokens) + " · " +
                                                            root.compactNumber(modelData.requests) + " req"
                                                        color: Theme.surfaceVariantText
                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                        isMonospace: true
                                                    }
                                                }

                                                StyledText {
                                                    width: parent.width
                                                    text: (modelData.provider || "provider") + " · " +
                                                        root.relativeAge(modelData.lastRequestAt)
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall - 2
                                                    elide: Text.ElideRight
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                DankFlickable {
                    id: settingsViewport

                    anchors.fill: parent
                    visible: root.configOpen
                    clip: true
                    contentWidth: width
                    contentHeight: settingsLoader.height + Theme.spacingS + Theme.spacingM

                    Loader {
                        id: settingsLoader

                        x: Theme.spacingM
                        y: Theme.spacingS
                        width: settingsViewport.width - Theme.spacingM * 2
                        height: item ? item.implicitHeight : 0
                        source: Qt.resolvedUrl("TokitokiSettings.qml")

                        onLoaded: {
                            if (item) {
                                item.width = settingsLoader.width
                                item.pluginService = root.pluginService
                            }
                        }
                    }
                }

                Connections {
                    target: root
                    function onSelectedTabChanged() {
                        viewport.contentY = 0
                    }
                }

                Connections {
                    target: root.pluginService
                    enabled: root.pluginService !== null

                    function onPluginDataChanged(changedPluginId) {
                        if (changedPluginId === root.pluginId && autoRefreshTimer.running)
                            autoRefreshTimer.restart()
                    }
                }

                Rectangle {
                    id: footer

                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    height: 52
                    visible: !root.configOpen
                    color: Theme.withAlpha(Theme.surfaceContainer, 0.96)
                    border.width: 1
                    border.color: Theme.outlineLight

                    Row {
                        anchors.fill: parent
                        anchors.leftMargin: Theme.spacingM
                        anchors.rightMargin: Theme.spacingM
                        spacing: Theme.spacingS

                        DankButton {
                            id: refreshButton
                            text: root.isBusy
                                ? (root.scanNextRefresh ? "Scanning…" : "Refreshing…")
                                : "Refresh & scan"
                            iconName: root.isBusy ? "sync" : "refresh"
                            buttonHeight: 34
                            horizontalPadding: Theme.spacingM
                            enabled: !root.isBusy
                            anchors.verticalCenter: parent.verticalCenter
                            onClicked: root.refresh(true)
                        }

                        Item { width: Math.max(0, parent.width - refreshButton.width - openButton.width - parent.spacing * 2) }

                        DankButton {
                            id: openButton
                            text: "Dashboard"
                            iconName: "open_in_new"
                            buttonHeight: 34
                            horizontalPadding: Theme.spacingS
                            anchors.verticalCenter: parent.verticalCenter
                            onClicked: root.openDashboard()
                        }
                    }
                }
            }
        }
    }

    function stateColor(state) {
        switch (state) {
        case "exceeded": return Theme.error
        case "warn": return Theme.warning
        default: return Theme.success
        }
    }

    Process {
        id: visibilityProcess

        command: [root.command, "ui", root.visibilityHide ? "--hide" : "--show",
            root.visibilityTarget, "--surface", "widget"]

        onExited: function(exitCode, exitStatus) {
            if (exitCode === 0)
                root.refresh(false)
            else
                root.lastError = "could not update card visibility (exit " + exitCode + ")"
        }
    }

    Process {
        id: statusProcess

        command: root.scanNextRefresh
            ? [root.command, "widget-payload", "--json"]
            : [root.command, "widget-payload", "--cached", "--json"]
        running: true

        stdout: StdioCollector {
            id: statusOutput
            onStreamFinished: root.accept(statusOutput.text)
        }

        stderr: StdioCollector {
            id: errorOutput
            onStreamFinished: {
                if (errorOutput.text.trim().length > 0) {
                    if (root.hasPayload)
                        root.lastError = errorOutput.text.trim()
                    else
                        root.errorText = errorOutput.text.trim()
                }
            }
        }

        onExited: function(exitCode, exitStatus) {
            root.scanNextRefresh = false
            if (exitCode !== 0) {
                if (root.hasPayload)
                    root.lastError = "tokitoki unavailable (exit " + exitCode + ")"
                else
                    root.errorText = "tokitoki unavailable (exit " + exitCode + ")"
            }
            if (root.pendingRefresh) {
                root.pendingRefresh = false
                root.refresh(false)
            }
        }
    }

    Timer {
        id: autoRefreshTimer
        interval: root.autoRefreshIntervalMs
        running: root.autoRefreshEnabled
        repeat: true
        onTriggered: root.refresh(root.autoRefreshScansSources)
    }
}
