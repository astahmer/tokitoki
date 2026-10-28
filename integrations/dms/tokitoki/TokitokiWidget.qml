import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import "."
import qs.Common
import qs.Modules.Plugins
import qs.DCommon.Widgets

PluginComponent {
    id: root

    property string shellName: "DMS"
    property string settingsLocation: "DMS Settings → Plugins"
    property var payload: ({})
    property string errorText: "Waiting for Tokitoki"
    property string lastError: ""
    property bool scanNextRefresh: false
    property bool cachedFirstRead: true
    property string searchText: ""
    property string selectedTab: "overview"
    property string selectedPeriod: "today"
    property string selectedMetric: "cost"
    property string historyPeriod: "month"
    property string compositionPeriod: "day"
    property bool stateReady: false
    property bool configOpen: false
    property double barNow: Date.now()
    property string visibilityTarget: ""
    property bool visibilityHide: true
    property bool pendingRefresh: false
    property bool pendingScan: false
    property bool statusExited: false
    property bool refreshActive: true
    property bool statusStdoutDone: false
    property bool statusStderrDone: false
    property int statusExitCode: 0
    property string statusStdout: ""
    property string statusStderr: ""
    // The plugin can run ahead of the installed CLI (e.g. a linked checkout);
    // drop --notify for this session instead of failing every refresh.
    property bool notifySupported: true
    property var accountOrderOverride: null
    property var barAccountOrderOverride: null
    property var barHiddenOverride: null
    property var pendingBarHidden: []
    property bool hiddenAccountsExpanded: false
    property string pendingOrderSurface: "quotas"
    property var pendingAccountOrder: []
    property var pendingBarOrderSeed: []
    readonly property bool accountOrderBusy: accountOrderProcess.running
    readonly property string barSummaryMode: root.pluginSetting("barSummaryMode", "summary")
    readonly property var hiddenBarWindows: root.pluginSetting("hiddenBarWindows", ({}))
    readonly property string barTotalPeriod: root.normalizeChoice(
        root.pluginSetting("barTotalPeriod", "day"),
        ["day", "week", "month"],
        "day"
    )
    readonly property string providerVisibility: root.pluginSetting("providerVisibility", "all")
    readonly property string selectedProviders: root.pluginSetting("selectedProviders", "")
    readonly property var tabOptions: ["overview", "quotas", "tokens", "reports", "sessions", "sources", "mcp", "settings"]
    readonly property var periodOptions: ["today", "yesterday", "week", "month", "year"]
    readonly property var historyPeriodOptions: ["day", "week", "month", "year"]
    readonly property var openingTabOptions: root.tabOptions
    readonly property string openingTab: normalizeChoice(
        root.pluginSetting("openingTab", "overview"),
        root.openingTabOptions,
        "overview"
    )

    readonly property bool hasPayload: payload && payload.schema === 1 && payload.app === "tokitoki"
    readonly property bool isBusy: refreshActive
    readonly property bool hasLimits: hasPayload && Array.isArray(payload.limits) && payload.limits.length > 0
    readonly property bool hasHistory: Boolean(hasPayload && payload.history &&
        Array.isArray(payload.history.days) && payload.history.days.length > 0)
    readonly property bool hasHistoryYear: Boolean(hasPayload && payload.historyYear &&
        Array.isArray(payload.historyYear.days) && payload.historyYear.days.length > 0)
    readonly property bool hasHistoryData: hasHistory || hasHistoryYear
    readonly property bool hasActivityGrid: Boolean(hasPayload && payload.activityGrid &&
        Array.isArray(payload.activityGrid.cells))
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
    readonly property var trackingReport: root.trackingForPeriod(root.compositionPeriod)
    readonly property var providerSlices: root.buildPeriodSlices(root.payload.providerPeriods, root.selectedPeriod, root.selectedMetric)
    readonly property var modelSlices: root.buildPeriodSlices(root.payload.modelPeriods, root.selectedPeriod, root.selectedMetric)
    readonly property var t3codeReport: root.t3codeActivityForPeriod(root.selectedPeriod)
    readonly property var attentionItems: root.buildAttentionItems()
    readonly property var quotaStripGroups: root.buildStatusStripGroups()
    readonly property var statusStripGroups: root.barSummaryMode === "icon" ||
        root.barSummaryMode === "total"
        ? [] : root.isShortestWindowMode()
            ? root.shortestWindowGroups(root.quotaStripGroups) : root.quotaStripGroups

    layerNamespacePlugin: "tokitoki"

    // Shared donut + legend for the by-provider / by-model cards.
    component BreakdownPie: Row {
        id: pie

        property var slices: []
        property string centerLabel: ""
        property string centerUnit: ""

        width: parent ? parent.width : 0
        height: Math.max(122, breakdownLegend.implicitHeight)
        spacing: Theme.spacingM

        TokitokiDonutChart {
            width: 116
            height: 116
            slices: pie.slices
            centerLabel: pie.centerLabel
            centerUnit: pie.centerUnit
        }

        Column {
            id: breakdownLegend
            width: Math.max(0, pie.width - 116 - pie.spacing)
            spacing: Theme.spacingXXS
            anchors.verticalCenter: parent.verticalCenter

            Repeater {
                model: root.legendSlices(pie.slices)

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
                        width: Math.max(0, parent.width - sliceValue.width - 7 - parent.spacing * 2)
                        color: Theme.surfaceText
                        font.pixelSize: Theme.fontSizeMedium
                        elide: Text.ElideRight
                    }

                    StyledText {
                        id: sliceValue
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

    component ReportControls: Flow {
        property bool showMetric: true
        width: parent ? parent.width : 0
        spacing: Theme.spacingS
        Row {
            spacing: Theme.spacingXXS
            Repeater {
                model: root.periodOptions
                delegate: Rectangle {
                    width: periodText.implicitWidth + Theme.spacingS * 2
                    activeFocusOnTab: true
                    Accessible.role: Accessible.Button
                    Accessible.name: periodText.text
                    Keys.onSpacePressed: root.selectedPeriod = modelData
                    Keys.onReturnPressed: root.selectedPeriod = modelData
                    height: 26
                    radius: 13
                    color: root.selectedPeriod === modelData
                        ? Theme.primaryContainer : Theme.withAlpha(Theme.surfaceText, 0.06)
                    StyledText {
                        id: periodText
                        anchors.centerIn: parent
                        text: root.periodLabel(modelData)
                        color: root.selectedPeriod === modelData ? Theme.primary : Theme.surfaceVariantText
                        font.pixelSize: Theme.fontSizeSmall + 1
                        font.weight: root.selectedPeriod === modelData ? Font.DemiBold : Font.Normal
                    }
                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.selectedPeriod = modelData
                    }
                }
            }
        }
        Row {
            visible: parent.showMetric
            spacing: Theme.spacingS
            Rectangle {
                width: 1
                height: 18
                color: Theme.primary
                anchors.verticalCenter: parent.verticalCenter
            }
            Row {
                spacing: Theme.spacingXXS
                Repeater {
                    model: ["cost", "tokens"]
                    delegate: Rectangle {
                        width: metricText.implicitWidth + Theme.spacingS * 2
                        activeFocusOnTab: true
                        Accessible.role: Accessible.Button
                        Accessible.name: metricText.text
                        Keys.onSpacePressed: root.selectedMetric = modelData
                        Keys.onReturnPressed: root.selectedMetric = modelData
                        height: 26
                        radius: 13
                        color: root.selectedMetric === modelData
                            ? Theme.primaryContainer : Theme.withAlpha(Theme.surfaceText, 0.06)
                        StyledText {
                            id: metricText
                            anchors.centerIn: parent
                            text: root.metricLabel(modelData)
                            color: root.selectedMetric === modelData ? Theme.primary : Theme.surfaceVariantText
                            font.pixelSize: Theme.fontSizeSmall + 1
                            font.weight: root.selectedMetric === modelData ? Font.DemiBold : Font.Normal
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
    }

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

    function barWindowKey(windowData) {
        var scope = String(windowData.scope || windowData.kind || "other").toLowerCase()
        var bucket = String(windowData.bucketId || "").toLowerCase()
        var model = String(windowData.model || "").toLowerCase()
        if (!bucket && !model && windowData.label && !/^(session|daily|weekly|monthly|limit)$/i.test(String(windowData.label)))
            bucket = String(windowData.label).toLowerCase()
        return JSON.stringify([scope, bucket, model])
    }

    function barWindowVisible(hidden, provider, windowData) {
        var entries = hidden && hidden[provider]
        return !Array.isArray(entries) || entries.indexOf(barWindowKey(windowData)) < 0
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

    function providerIsSelected(provider, vendor) {
        var list = selectedProviderList()
        var localProvider = String(provider || "").toLowerCase()
        return list.length === 0 || list.indexOf(localProvider) >= 0 ||
            root.vendorKeys(root.vendorFor(provider, vendor)).some(function(key) {
                return list.indexOf(key) >= 0
            })
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
        var rows = report.rows.slice()
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
        var rows = report.rows.slice()
        return rows.sort(function(a, b) {
            if (root.searchIsActive() && !root.privacyHideRepoSessionNames) {
                var aMatches = root.searchMatches(a.bucket)
                var bMatches = root.searchMatches(b.bucket)
                if (aMatches !== bMatches)
                    return aMatches ? -1 : 1
            }
            return safeNumber(b.costUsd) - safeNumber(a.costUsd) ||
                totalTokens(b) - totalTokens(a)
        })
    }

    function legendSlices(slices) {
        var rows = slices.slice()
        if (searchIsActive()) {
            rows.sort(function(a, b) {
                var aMatches = searchMatches(a.name)
                var bMatches = searchMatches(b.name)
                return aMatches === bMatches ? 0 : aMatches ? -1 : 1
            })
        }
        return rows.slice(0, 6)
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

    function buildPeriodSlices(list, period, metric) {
        var rows = []
        var periods = Array.isArray(list) ? list : []
        for (var i = 0; i < periods.length; i++) {
            if (periods[i] && periods[i].key === period) {
                rows = Array.isArray(periods[i].rows) ? periods[i].rows : []
                break
            }
        }
        var values = []
        for (var j = 0; j < rows.length; j++) {
            var value = metric === "cost" ? safeNumber(rows[j].costUsd) : totalTokens(rows[j])
            if (value > 0) {
                values.push({
                    name: displayLabel(rows[j].bucket || "unknown"),
                    value: value,
                    color: paletteColor(rows[j].bucket, j)
                })
            }
        }
        return values.sort(function(a, b) {
            return b.value - a.value
        })
    }

    function slicesTotal(slices) {
        return slices.reduce(function(sum, item) {
            return sum + item.value
        }, 0)
    }

    function privateRepoHistory() {
        var history = payload.repoHistory
        if (!privacyHideRepoSessionNames || !history || !Array.isArray(history.series))
            return history
        return {
            days: history.days,
            series: history.series.map(function(series, index) {
                return { bucket: "Private repository " + (index + 1), values: series.values }
            })
        }
    }

    function tokenPulseTotal() {
        var report = reportFor(selectedPeriod)
        if (!report || !report.total)
            return null
        return {
            tokens: totalTokens(report.total),
            costUsd: safeNumber(report.total.costUsd),
            requests: safeNumber(report.total.requests),
            sessions: selectedPeriod === "today" || selectedPeriod === "week"
                ? safeNumber(report.total.sessions) : null
        }
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

    function trackingForPeriod(period) {
        var periods = payload.trackingPeriods
        var report = periods && periods[period]
        return report && typeof report.requests === "number" ? report : null
    }

    function trackingPercent(value) {
        return typeof value === "number" && isFinite(value) && value >= 0 && value <= 100
            ? value.toFixed(1).replace(/\.0$/, "") + "%" : "Unavailable"
    }

    function trackingSources(report) {
        if (!report)
            return ""
        return "Cost sources: " + compactNumber(safeNumber(report.reportedRequests)) + " reported" +
            " · " + compactNumber(safeNumber(report.estimatedRequests)) + " estimated" +
            " · " + compactNumber(safeNumber(report.unpricedRequests)) + " unpriced" +
            " · " + compactNumber(safeNumber(report.unknownRequests)) + " unknown"
    }

    function trackingTokenSummary(report) {
        if (!report || typeof report.reportedTokens !== "number" ||
                typeof report.estimatedTokens !== "number" || typeof report.unknownTokens !== "number")
            return ""
        return "Token counts: " + compactNumber(report.reportedTokens) + " reported · " +
            compactNumber(report.estimatedTokens) + " estimated" +
            (report.unknownTokens > 0 ? " · " + compactNumber(report.unknownTokens) + " source unknown" : "")
    }

    function trackingModelLabel(value) {
        var name = String(value || "")
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || /^sk-/i.test(name))
            return "other model identifier"
        return name.length > 40 ? name.slice(0, 37) + "…" : name
    }

    function trackingMissingPrices(report) {
        if (!report || !Array.isArray(report.unpricedModels) || report.unpricedModels.length === 0)
            return ""
        if (privacyHideIdentities || privacyHideRepoSessionNames)
            return "Unpriced models hidden for privacy"
        var models = report.unpricedModels
        return "Missing prices: " + models.slice(0, 4).map(trackingModelLabel).join(", ") +
            (models.length > 4 ? " (+" + (models.length - 4) + " more)" : "")
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

    function reportTotal(period) {
        var report = reportFor(period)
        return report && report.total ? report.total : null
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
        var groups = root.buildStatusStripGroups()
        if (root.isShortestWindowMode())
            groups = root.shortestWindowGroups(groups)
        return groups.map(function(group) {
            var text = group.lines.join(" · ")
            return group.label + (text ? " " + text : "")
        }).join(" | ")
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

    function providerIsVisible(provider, accountKey, vendor) {
        var ui = payload.uiPreview || ({})
        var previewHidden = Array.isArray(ui.previewHidden) ? ui.previewHidden : []
        if (root.accountCardHidden(provider, accountKey))
            return false
        if (vendorKeys(vendorFor(provider, vendor)).some(function(key) { return previewHidden.indexOf(key) >= 0 }))
            return false
        return root.providerVisibility !== "selected" || providerIsSelected(provider, vendor)
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
        case "sessions": return "Sessions"
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

    function providerEntry(provider) {
        var registry = payload && payload.providerRegistry ? payload.providerRegistry : null
        var key = String(provider || "")
        return registry && key.length > 0 && registry[key] ? registry[key] : null
    }

    function providerName(provider) {
        var entry = providerEntry(provider)
        return entry && entry.displayName ? entry.displayName : (provider || "Unknown provider")
    }

    function harnessIcon(provider) {
        var entry = providerEntry(provider)
        return entry && entry.icon ? entry.icon : "terminal"
    }

    // Payload vendor first (computed from account identity), then the
    // registry's static vendor; "" when the CLI predates vendor tagging.
    function vendorFor(provider, vendor) {
        if (vendor)
            return String(vendor)
        var entry = providerEntry(provider)
        return entry && entry.vendor ? String(entry.vendor) : ""
    }

    // Vendor id plus legacy upstream aliases (claude, gemini, ...) still
    // used by saved previewHidden / selectedProviders settings.
    function vendorKeys(vendor) {
        if (!vendor)
            return []
        var entry = providerEntry(vendor)
        var aliases = entry && Array.isArray(entry.aliases) ? entry.aliases : []
        return [String(vendor).toLowerCase()].concat(aliases.map(function(alias) {
            return String(alias).toLowerCase()
        }))
    }

    function vendorIncident(vendor) {
        var incidents = payload && payload.statusIncidents ? payload.statusIncidents : null
        var incident = incidents && vendor ? incidents[vendor] : null
        return incident && incident.indicator && incident.indicator !== "none" ? incident : null
    }

    function degradedVendors() {
        var incidents = payload && payload.statusIncidents ? payload.statusIncidents : ({})
        var rank = { minor: 1, major: 2, critical: 3 }
        return Object.keys(incidents).filter(function(vendor) {
            return vendorIncident(vendor) !== null
        }).sort(function(a, b) {
            return (rank[incidents[b].indicator] || 0) - (rank[incidents[a].indicator] || 0)
        })
    }

    function degradedBarVendors() {
        var visible = root.quotaStripGroups.map(function(group) { return group.provider })
        return root.degradedVendors().filter(function(vendor) { return visible.indexOf(vendor) >= 0 })
    }

    function incidentColor(incident) {
        return incident && (incident.indicator === "major" || incident.indicator === "critical")
            ? Theme.error : Theme.warning
    }


    function accountPrimaryLabel(account) {
        if (privacyHideIdentities)
            return "Private account"
        if (account.email)
            return account.email
        if (account.label)
            return account.label
        if (account.credential)
            return providerName(account.provider) + " " + account.credential
        return providerName(account.provider)
    }

    function accountSecondaryLabel(account) {
        if (privacyHideIdentities)
            return providerName(account.provider) + " · identities hidden"
        var label = (!account.email && !account.accountId && !account.credential)
            ? "Identity unverified · " + String(account.accountKey || "default")
            : String(account.accountKey || "default")
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
            privacyHideIdentities ? "" : account.label,
            privacyHideIdentities ? "" : account.credential
        ].some(function(value) {
            return String(value || "").toLowerCase().indexOf(query) >= 0
        })
    }

    function filteredLimits() {
        if (!hasLimits)
            return []
        return orderedAccounts().filter(function(account) {
            return matchesAccount(account) && !root.accountCardHidden(account.provider, account.accountKey)
        })
    }

    function hiddenLimits() {
        return orderedAccounts().filter(function(account) {
            return matchesAccount(account) && root.accountCardHidden(account.provider, account.accountKey)
        })
    }

    function restoreAccountLabel(account) {
        var hidden = (payload.uiPreview || {}).menubarHidden || []
        return hidden.indexOf(account.provider) >= 0
            ? "Restore all " + providerName(account.provider) + " accounts" : "Restore this account"
    }

    function barAccountHidden(account) {
        var hidden = Array.isArray(barHiddenOverride) ? barHiddenOverride : (payload.uiPreview || {}).barHiddenAccounts || []
        return hidden.indexOf(account.provider + "@" + account.accountKey) >= 0
    }

    function setBarAccountHidden(account, hidden) {
        if (barVisibilityProcess.running)
            return
        var ids = Array.isArray(barHiddenOverride) ? barHiddenOverride.slice() : ((payload.uiPreview || {}).barHiddenAccounts || []).slice()
        var id = account.provider + "@" + account.accountKey
        ids = ids.filter(function(value) { return value !== id })
        if (hidden) ids.push(id)
        pendingBarHidden = ids
        barVisibilityProcess.running = true
    }

    function orderedAccounts(surface) {
        var accounts = Array.isArray(payload.limits) ? payload.limits.slice() : []
        var ui = payload.uiPreview || {}
        var override = surface === "bar" ? barAccountOrderOverride : accountOrderOverride
        var saved = Array.isArray(override) ? override : surface === "bar" ? ui.barAccountOrder || ui.accountOrder || [] : ui.accountOrder || []
        var rank = function(account) {
            var index = saved.indexOf(String(account.provider) + "@" + String(account.accountKey))
            return index < 0 ? saved.length : index
        }
        return accounts.sort(function(a, b) { return rank(a) - rank(b) })
    }

    function shiftedAccountOrder(account, direction, surface) {
        if (surface === "bar") return shiftedBarAccountOrder(account, direction)
        var visibleAccounts = surface === "bar" ? orderedAccounts("bar").filter(function(a) {
            return !root.barAccountHidden(a) && root.providerIsVisible(a.provider, a.accountKey, a.vendor)
        }) : filteredLimits()
        var visible = visibleAccounts.map(function(a) { return a.provider + "@" + a.accountKey })
        var id = account.provider + "@" + account.accountKey
        var index = visible.indexOf(id)
        var neighbour = visible[index + direction]
        if (index < 0 || !neighbour)
            return null
        var ui = payload.uiPreview || {}
        var override = surface === "bar" ? barAccountOrderOverride : accountOrderOverride
        var saved = (Array.isArray(override) ? override : surface === "bar" ? ui.barAccountOrder || ui.accountOrder || [] : ui.accountOrder || []).slice()
        orderedAccounts(surface).forEach(function(a) {
            var key = a.provider + "@" + a.accountKey
            if (saved.indexOf(key) < 0) saved.push(key)
        })
        var from = saved.indexOf(id)
        var to = saved.indexOf(neighbour)
        saved[from] = neighbour
        saved[to] = id
        return saved
    }

    function shiftedBarAccountOrder(account, direction) {
        var known = orderedAccounts("bar").map(function(a) { return a.provider + "@" + a.accountKey })
        var groups = buildStatusStripGroups().map(function(group) {
            return group.accounts.map(function(a) { return a.provider + "@" + a.accountKey })
                .filter(function(id) { return known.indexOf(id) >= 0 })
        }).filter(function(group) { return group.length > 0 })
        var original = [].concat.apply([], groups)
        var id = account.provider + "@" + account.accountKey
        var groupIndex = groups.findIndex(function(group) { return group.indexOf(id) >= 0 })
        if (groupIndex < 0) return null
        var group = groups[groupIndex]
        var index = group.indexOf(id)
        if (index + direction >= 0 && index + direction < group.length) {
            group[index] = group[index + direction]
            group[index + direction] = id
        } else {
            if (groupIndex + direction < 0 || groupIndex + direction >= groups.length) return null
            groups[groupIndex] = groups[groupIndex + direction]
            groups[groupIndex + direction] = group
        }
        var desired = [].concat.apply([], groups)
        var ui = payload.uiPreview || {}
        var saved = (Array.isArray(barAccountOrderOverride) ? barAccountOrderOverride : ui.barAccountOrder || ui.accountOrder || []).slice()
        known.forEach(function(key) { if (saved.indexOf(key) < 0) saved.push(key) })
        var next = 0
        return saved.map(function(key) { return original.indexOf(key) >= 0 ? desired[next++] : key })
    }

    function moveAccount(account, direction, surface) {
        if (accountOrderBusy)
            return
        var next = shiftedAccountOrder(account, direction, surface)
        if (!next)
            return
        pendingAccountOrder = next
        pendingBarOrderSeed = orderedAccounts("bar").map(function(a) { return a.provider + "@" + a.accountKey })
        pendingOrderSurface = surface === "bar" ? "bar" : "quotas"
        accountOrderProcess.running = true
    }

    function searchQueryText() {
        return searchText.trim().toLowerCase()
    }

    function searchIsActive() {
        return searchQueryText().length > 0
    }

    function searchMatches(value) {
        return String(value || "").toLowerCase().indexOf(searchQueryText()) >= 0
    }

    function searchMatchesInRows(rows, key) {
        if (!Array.isArray(rows))
            return false
        return rows.some(function(row) {
            return searchMatches(row ? row[key] : "")
        })
    }

    function t3codeActivityForPeriod(key) {
        var periods = payload.t3codeActivity
        if (!hasPayload || !Array.isArray(periods) || !periods.some(function(period) {
            return period.total && Number(period.total.requests) > 0
        }))
            return null
        return periods.find(function(period) {
            return period.key === key && period.total && Array.isArray(period.rows)
        }) || null
    }

    function cardSurvives(id) {
        if (!searchIsActive())
            return true
        var query = searchQueryText()
        if (id === "limits")
            return filteredLimits().length > 0
        if (id === "harness")
            return searchMatchesInRows(payload.today ? payload.today.rows : [], "bucket")
        if (id === "t3code") {
            var activity = t3codeActivityForPeriod(selectedPeriod)
            return searchMatches("Via T3code application activity sessions requests models tokens estimated cost excluded from totals") ||
                Boolean(activity && searchMatchesInRows(activity.rows, "bucket"))
        }
        if (id === "repos")
            return !privacyHideRepoSessionNames &&
                searchMatchesInRows(payload.reposMonth ? payload.reposMonth.rows : [], "bucket")
        if (id === "usage")
            return query === "cost" || query === "tokens" ||
                searchMatchesInRows(root.rowsForPeriod(root.selectedPeriod), "bucket")
        if (id === "tools")
            return Boolean(payload.topTools && searchMatchesInRows(payload.topTools.tools, "tool"))
        if (id === "provider" || id === "model")
            return query === "cost" || query === "tokens" ||
                searchMatchesInRows(id === "provider" ? providerSlices : modelSlices, "name")
        if (id === "repoHistory")
            return !privacyHideRepoSessionNames && Boolean(payload.repoHistory) &&
                searchMatchesInRows(payload.repoHistory.series, "bucket")
        if (id === "recentSessions")
            return !privacyHideRepoSessionNames && Boolean(payload.recentSessions) &&
                searchMatchesInRows(payload.recentSessions.rows, "title")
        if (id === "integration")
            return searchMatches(root.shellName + " integration settings executable configuration")
        if (id === "notifications")
            return searchMatches("notifications alerts quota spend burn budget settings")
        if (id === "tracking")
            return searchMatches("tracking quality pricing cost tokens cache reported estimated unpriced coverage legacy unknown")
        if (id === "pulse" || id === "composition" || id === "history")
            return query === "tokens" || query === "cost" || searchMatches(id)
        return false
    }

    function orderedWindows(windows) {
        if (!windows || windows.length === undefined)
            return []
        var ordered = []
        for (var i = 0; i < windows.length; i++)
            if (windows[i].source !== "derived")
                ordered.push(windows[i])
        return ordered.sort(function(a, b) {
            var rankA = windowOrderMinutes(a)
            var rankB = windowOrderMinutes(b)
            if (rankA !== rankB)
                return rankA < rankB ? -1 : 1
            return (a.model ? 1 : 0) - (b.model ? 1 : 0)
        })
    }

    function windowDurationMinutes(windowData) {
        var minutes = Number(windowData && windowData.windowMinutes)
        if (windowData && windowData.windowMinutes !== undefined)
            return isFinite(minutes) && minutes > 0 ? minutes : NaN
        if (windowData && windowData.source === "derived") {
            var start = Date.parse(String(windowData.windowStart || ""))
            var end = Date.parse(String(windowData.windowEnd || ""))
            if (isFinite(start) && isFinite(end) && end > start)
                return (end - start) / 60000
        }
        return NaN
    }

    function windowOrderMinutes(windowData) {
        var minutes = windowDurationMinutes(windowData)
        return isFinite(minutes) ? minutes : windowRank(windowData && windowData.kind)
    }

    function windowTitle(windowData) {
        if (windowData && windowData.label)
            return String(windowData.label)
        if (windowData && windowData.scope && windowData.scope !== "other")
            return displayLabel(windowData.scope)
        if (windowData && ["day", "week", "month"].indexOf(windowData.kind) >= 0)
            return windowName(windowData.kind)
        var duration = barWindowDuration(windowData || {})
        if (duration)
            return duration + " limit"
        if (!windowData || /^(0min|unknown)$/.test(String(windowData.kind)))
            return "Limit"
        return windowName(windowData && windowData.kind)
    }

    function quotaStatus(windowData) {
        if (!windowData)
            return "unknown"
        if (windowData.status && windowData.status !== "current")
            return windowData.status
        var end = Date.parse(String(windowData.resetsAt || windowData.windowEnd || ""))
        return isFinite(end) && end <= root.barNow ? "expired" : "current"
    }

    function observationLabel(windowData) {
        return windowData && windowData.observedAt
            ? "Observed " + relativeAge(windowData.observedAt) : "Observation time unknown"
    }

    function clockLabel(value) {
        var target = new Date(String(value || ""))
        if (!isFinite(target.getTime()))
            return ""
        var hours = target.getHours()
        var minutes = target.getMinutes()
        var time = (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes
        if (target.toDateString() === new Date().toDateString())
            return time
        return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][target.getDay()] + " " + time
    }

    function paceLabel(windowData) {
        var pace = windowData && windowData.pace
        if (!pace || !hasUsedPercent(windowData))
            return ""
        if (pace.status === "over" && pace.runsOutAt && clockLabel(pace.runsOutAt).length > 0)
            return "Runs out ~" + clockLabel(pace.runsOutAt)
        if (pace.status === "over")
            return "Over pace"
        if (pace.status === "under")
            return "Under pace"
        return "On pace"
    }

    function paceMarkerFraction(windowData) {
        var pace = windowData && windowData.pace
        if (!pace || !hasUsedPercent(windowData) || !isFinite(Number(pace.expectedPercent)))
            return -1
        return Math.max(0, Math.min(1, 1 - Number(pace.expectedPercent) / 100))
    }

    function extraUsageLabel(extraUsage) {
        if (!extraUsage || !extraUsage.enabled)
            return ""
        if (extraUsage.usedUsd === undefined || extraUsage.usedUsd === null)
            return "Extra usage enabled"
        var text = "Extra usage " + formatMoney(extraUsage.usedUsd)
        if (extraUsage.limitUsd !== undefined && extraUsage.limitUsd !== null)
            text += " / " + formatMoney(extraUsage.limitUsd)
        return text
    }

    function balanceAmount(value, currency) {
        var code = String(currency || "USD").toUpperCase()
        return code === "USD" ? formatMoney(value) : safeNumber(value).toFixed(2) + " " + code
    }

    function workspaceCreditsLabel(credits) {
        if (!credits)
            return ""
        if (credits.unlimited === true)
            return "Unlimited workspace credits"
        if (credits.balance === undefined || credits.balance === null)
            return ""
        return "Workspace credits " + String(credits.balance)
    }

    function balanceLabel(balance) {
        if (!balance || balance.remaining === undefined || balance.remaining === null)
            return ""
        var text = "Balance " + balanceAmount(balance.remaining, balance.currency)
        if (balance.total !== undefined && balance.total !== null)
            text += " / " + balanceAmount(balance.total, balance.currency)
        var parts = []
        if (balance.paid !== undefined && balance.paid !== null)
            parts.push("paid " + balanceAmount(balance.paid, balance.currency))
        if (balance.granted !== undefined && balance.granted !== null)
            parts.push("granted " + balanceAmount(balance.granted, balance.currency))
        if (parts.length > 0)
            text += " (" + parts.join(", ") + ")"
        if (balance.available === false)
            text += " · unavailable for API calls"
        return text
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
        return windowData && windowData.source !== "derived" && quotaStatus(windowData) === "current" && windowData.usedPct !== null &&
            windowData.usedPct !== undefined && isFinite(Number(windowData.usedPct))
    }

    function remainingPercent(windowData) {
        if (!hasUsedPercent(windowData))
            return NaN
        return Math.max(0, Math.min(100, 100 - safeNumber(windowData.usedPct)))
    }

    function limitFraction(windowData) {
        if (quotaStatus(windowData) !== "current")
            return 0
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
        if (quotaStatus(windowData) !== "current")
            return displayLabel(quotaStatus(windowData)) + " · " + observationLabel(windowData)
        if (windowData && windowData.amountUsd !== null &&
                windowData.amountUsd !== undefined)
            return sourceLabel(windowData.source) + " · " + formatMoney(windowData.amountUsd)
        if (hasUsedPercent(windowData))
            return sourceLabel(windowData.source) + " · " + Math.round(remainingPercent(windowData)) + "% left"
        if (windowData && safeNumber(windowData.tokens) > 0)
            return "Estimated · " + compactNumber(windowData.tokens) + " tokens"
        return "Usage unknown · " + observationLabel(windowData)
    }

    function resetLabel(value) {
        return barCountdown(value)
    }

    function buildAttentionItems() {
        var items = []
        if (hasLimits) {
            for (var i = 0; i < payload.limits.length; i++) {
                var account = payload.limits[i]
                if (!providerIsVisible(account.provider, account.accountKey, account.vendor))
                    continue
                var windows = orderedWindows(account.windows)
                for (var j = 0; j < windows.length; j++) {
                    var windowData = windows[j]
                    if (hasUsedPercent(windowData) && remainingPercent(windowData) <= 10) {
                        items.push({
                            title: accountPrimaryLabel(account),
                            detail: windowTitle(windowData) + " · " +
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

    function otherActiveMachines(presence) {
        if (!Array.isArray(presence))
            return []
        var now = Date.now()
        return presence.filter(function(machine) {
            return machine && machine.local !== true && (now - safeNumber(machine.ts)) < 600000
        })
    }

    function relativeAge(value) {
        var timestamp = Date.parse(String(value || ""))
        if (!isFinite(timestamp))
            return "unknown"
        var seconds = Math.max(0, (root.barNow - timestamp) / 1000)
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

    function providerShortName(provider) {
        var entry = providerEntry(provider)
        return entry && entry.shortName ? entry.shortName : displayLabel(provider)
    }

    function barWindowDuration(windowData) {
        var minutes = windowDurationMinutes(windowData)
        if (windowData.windowMinutes !== undefined && (!isFinite(minutes) || minutes <= 0))
            return ""
        if (isFinite(minutes) && minutes > 0) {
            if (minutes >= 28 * 1440 && minutes <= 31 * 1440)
                return "1mo"
            if (minutes % 1440 === 0)
                return minutes / 1440 + "d"
            if (minutes % 60 === 0)
                return minutes / 60 + "h"
            return minutes + "m"
        }
        var kind = String(windowData.kind || "").toLowerCase()
        var durations = { week: "7d", weekly: "7d", month: "1mo", monthly: "1mo", "5h": "5h" }
        if (durations[kind])
            return durations[kind]
        var match = kind.match(/^(\d+(?:\.\d+)?)(min|h|d|w|mo)$/)
        if (!match || Number(match[1]) <= 0)
            return ""
        return match[1] + (match[2] === "min" ? "m" : match[2])
    }

    function barWindowBucket(windowData) {
        if (windowData.model)
            return displayLabel(windowData.model)
        var label = String(windowData.label || "")
        var aliases = { "cursor models": "", "other models": "API", "on-demand": "OD" }
        if (aliases[label.toLowerCase()] !== undefined)
            return aliases[label.toLowerCase()]
        return /^(session|daily|weekly|monthly|limit)$/i.test(label) ? "" : label
    }

    function barCountdown(value) {
        var timestamp = Date.parse(String(value || ""))
        if (!isFinite(timestamp))
            return ""
        var minutes = Math.max(0, Math.ceil((timestamp - (root.barNow || Date.now())) / 60000))
        if (minutes < 60)
            return minutes + "m"
        if (minutes < 1440)
            return Math.floor(minutes / 60) + "h " + minutes % 60 + "m"
        return Math.floor(minutes / 1440) + "d " + Math.floor(minutes % 1440 / 60) + "h"
    }

    function barProfileName(account, index) {
        if (privacyHideIdentities)
            return "P" + (index + 1)
        return String(account.label || account.email || account.accountKey || "Profile").split("@")[0]
    }

    function windowRank(kind) {
        var text = String(kind || "").toLowerCase()
        if (text === "day" || text === "session" || text === "5h")
            return text === "day" ? 1440 : 300
        if (text === "week" || text === "weekly" || text === "7d")
            return 10080
        if (text === "month" || text === "monthly" || text === "30d")
            return 43200

        var match = text.match(/^(\d+(?:\.\d+)?)\s*(min|h|d|w|mo)$/)
        if (!match)
            return Infinity
        var value = Number(match[1])
        if (value <= 0)
            return Infinity
        switch (match[2]) {
        case "min": return value
        case "h": return value * 60
        case "d": return value * 1440
        case "w": return value * 10080
        case "mo": return value * 43200
        default: return Infinity
        }
    }

    function isShortestWindowMode() {
        return root.barSummaryMode === "shortest-window" || root.barSummaryMode === "lowest-session"
    }

    function shortestWindowGroups(groups) {
        return groups.map(function(group) {
            return Object.assign({}, group, { lines: group.profiles.map(function(profile) {
                return profile.prefix + (profile.shortest ? profile.shortest.text : "—")
            }) })
        })
    }

    function buildStatusStripGroups() {
        if (!hasPayload)
            return []
        var groups = []
        var accounts = hasLimits ? orderedAccounts("bar") : []
        var usageRows = payload.today && Array.isArray(payload.today.rows) ? payload.today.rows : []
        for (var usageIndex = 0; usageIndex < usageRows.length; usageIndex++) {
            var harness = String(usageRows[usageIndex].bucket || "")
            var usageVendor = vendorFor(harness, usageRows[usageIndex].vendor) || harness
            if (!accounts.some(function(account) {
                return (vendorFor(account.provider, account.vendor) || account.provider) === usageVendor
            }))
                accounts.push({ provider: harness, accountKey: "", vendor: usageRows[usageIndex].vendor, windows: [] })
        }
        for (var i = 0; i < accounts.length; i++) {
            var account = accounts[i]
            var provider = vendorFor(account.provider, account.vendor) || String(account.provider || "")
            if (!provider || barAccountHidden(account) || !providerIsVisible(account.provider, account.accountKey, account.vendor))
                continue
            var group = groups.find(function(item) { return item.provider === provider })
            if (!group) {
                group = { provider: provider, label: providerShortName(provider), accounts: [], profiles: [], lines: [] }
                groups.push(group)
            }
            group.accounts.push(account)
        }
        for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            var currentGroup = groups[groupIndex]
            var initials = currentGroup.accounts.map(function(account, index) {
                return barProfileName(account, index).slice(0, 2).toUpperCase()
            })
            for (var accountIndex = 0; accountIndex < currentGroup.accounts.length; accountIndex++) {
                var currentAccount = currentGroup.accounts[accountIndex]
                var prefix = initials[accountIndex]
                if (initials.filter(function(value) { return value === prefix }).length > 1)
                    prefix += accountIndex + 1
                var parts = []
                var profile = { name: barProfileName(currentAccount, accountIndex), rows: [],
                    prefix: currentGroup.accounts.length > 1 ? prefix + ": " : "", shortest: null }
                var lastDuration = ""
                var windows = orderedWindows(currentAccount.windows)
                for (var windowIndex = 0; windowIndex < windows.length; windowIndex++) {
                    var windowData = windows[windowIndex]
                    if (quotaStatus(windowData) !== "current") {
                        profile.rows.push({ label: windowTitle(windowData),
                            value: displayLabel(quotaStatus(windowData)) + " · " + observationLabel(windowData),
                            resetsAt: "", color: Theme.primary, icon: "history" })
                        continue
                    }
                    if (quotaStatus(windowData) !== "current" || (!hasUsedPercent(windowData) && (windowData.amountUsd === undefined || windowData.amountUsd === null)))
                        continue
                    var duration = barWindowDuration(windowData)
                    if (!duration)
                        continue
                    var hasAmount = windowData.amountUsd !== undefined && windowData.amountUsd !== null
                    var value = hasAmount ? formatMoney(windowData.amountUsd)
                        : Math.round(remainingPercent(windowData)) + "%"
                    var bucket = barWindowBucket(windowData)
                    var fullBucket = String(windowData.label || windowData.model || "")
                    if (/^(session|daily|weekly|monthly|limit)$/i.test(fullBucket))
                        fullBucket = ""
                    profile.rows.push({ label: duration + (fullBucket ? " · " + fullBucket : ""),
                        value: value, resetsAt: String(windowData.resetsAt || ""),
                        color: hasAmount ? Theme.primary : limitColor(windowData),
                        icon: hasAmount ? "payments" : "hourglass_empty" })
                    if (!root.barWindowVisible(root.hiddenBarWindows, currentGroup.provider, windowData))
                        continue
                    parts.push((duration !== lastDuration ? duration + " " : "") +
                        (bucket ? bucket + " " : "") + value)
                    lastDuration = duration
                    var minutes = windowOrderMinutes(windowData)
                    if (!profile.shortest || minutes < profile.shortest.minutes) {
                        var shortDuration = duration === "1mo" ? Math.round(minutes / 1440) + "d" : duration
                        profile.shortest = { minutes: minutes,
                            text: shortDuration + (bucket ? " " + bucket : "") + " " + value }
                    }
                }
                if (parts.length > 0)
                    currentGroup.lines.push((currentGroup.accounts.length > 1 ? prefix + ": " : "") + parts.join(" · "))
                currentGroup.profiles.push(profile)
            }
        }
        return groups
    }

    function refresh(scan) {
        if (statusProcess.running || refreshActive) {
            pendingRefresh = true
            pendingScan = pendingScan || Boolean(scan)
            return
        }
        scanNextRefresh = Boolean(scan)
        cachedFirstRead = false
        refreshActive = true
        statusExited = false
        statusStdoutDone = false
        statusStderrDone = false
        statusStdout = ""
        statusStderr = ""
        statusProcess.running = true
    }

    function statusTimedOut() {
        refreshActive = false
        statusProcess.running = false
        scanNextRefresh = false
        pendingRefresh = false
        pendingScan = false
        var message = "Quota refresh timed out; retrying on next automatic refresh"
        if (hasPayload) lastError = message
        else errorText = message
        console.warn("[Tokitoki] " + message)
    }

    function statusStartFailed() {
        var message = "could not start " + root.command + " (check the " + root.shellName + " PATH or executable setting)"
        refreshActive = false
        scanNextRefresh = false
        pendingRefresh = false
        pendingScan = false
        if (hasPayload)
            lastError = message
        else
            errorText = message
    }

    function finishStatus() {
        if (!refreshActive || !statusExited || !statusStdoutDone || !statusStderrDone)
            return
        var retryNotify = notifySupported && statusStderr.indexOf("unknown flag '--notify'") >= 0
        var scan = pendingScan || (retryNotify && scanNextRefresh)
        var again = pendingRefresh || retryNotify
        refreshActive = false
        scanNextRefresh = false
        pendingRefresh = false
        pendingScan = false
        if (retryNotify) notifySupported = false
        else if (statusExitCode === 0) accept(statusStdout)
        else {
            var message = statusStderr.trim() || "tokitoki unavailable (exit " + statusExitCode + ")"
            if (hasPayload) lastError = message
            else errorText = message
        }
        if (again) refresh(scan)
    }

    function accept(raw) {
        if (raw.trim().length === 0) {
            if (hasPayload)
                lastError = "tokitoki returned an empty widget payload"
            else
                errorText = "tokitoki unavailable (check the " + root.shellName + " PATH)"
            return
        }
        try {
            var next = JSON.parse(raw)
            if (next.schema !== 1 || next.app !== "tokitoki")
                throw new Error("unsupported widget payload")
            if ((next.recentSessions === null || next.recentSessions === undefined) && hasPayload)
                next.recentSessions = payload.recentSessions
            var quotaWarning = ""
            if (!Array.isArray(next.limits) && hasPayload && Array.isArray(payload.limits)) {
                next.limits = payload.limits.map(function(account) {
                    var saved = Object.assign({}, account)
                    saved.windows = (account.windows || []).map(function(windowData) {
                        return Object.assign({}, windowData, { status: "stale" })
                    })
                    return saved
                })
                quotaWarning = "Quota refresh incomplete; showing last observations"
            }
            payload = next
            if (Array.isArray(accountOrderOverride) && JSON.stringify((next.uiPreview || {}).accountOrder || []) === JSON.stringify(accountOrderOverride))
                accountOrderOverride = null
            if (Array.isArray(barAccountOrderOverride) && JSON.stringify((next.uiPreview || {}).barAccountOrder || []) === JSON.stringify(barAccountOrderOverride))
                barAccountOrderOverride = null
            if (Array.isArray(barHiddenOverride) && JSON.stringify((next.uiPreview || {}).barHiddenAccounts || []) === JSON.stringify(barHiddenOverride))
                barHiddenOverride = null
            errorText = ""
            lastError = quotaWarning
        } catch (error) {
            if (hasPayload)
                lastError = String(error)
            else
                errorText = String(error)
        }
    }

    Component.onCompleted: Qt.callLater(root.restoreSelections)

    onSelectedTabChanged: saveState("selectedTab", selectedTab)
    onOpeningTabChanged: {
        if (stateReady)
            selectedTab = openingTab
    }
    onSelectedPeriodChanged: saveState("selectedPeriod", selectedPeriod)
    onSelectedMetricChanged: saveState("selectedMetric", selectedMetric)
    onHistoryPeriodChanged: saveState("historyPeriod", historyPeriod)
    onCompositionPeriodChanged: saveState("compositionPeriod", compositionPeriod)

    Timer {
        interval: 60000
        running: true
        repeat: true
        onTriggered: root.barNow = Date.now()
    }

    horizontalBarPill: Component {
        Row {
            spacing: Theme.spacingS

            DIcon {
                name: "warning"
                size: root.iconSize
                color: root.incidentColor(root.vendorIncident(root.degradedBarVendors()[0]))
                anchors.verticalCenter: parent.verticalCenter
                visible: root.degradedBarVendors().length > 0
            }

            DIcon {
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
                    id: providerGroup
                    property var groupData: modelData
                    property bool tooltipOpen: false

                    HoverHandler {
                        id: providerHover
                        onHoveredChanged: {
                            if (hovered) {
                                tooltipClose.stop()
                                providerGroup.tooltipOpen = true
                            } else {
                                tooltipClose.restart()
                            }
                        }
                    }

                    Timer {
                        id: tooltipClose
                        interval: 180
                        onTriggered: {
                            if (!providerHover.hovered && !cardHover.hovered)
                                providerGroup.tooltipOpen = false
                        }
                    }

                    PopupWindow {
                        anchor.item: providerGroup
                        anchor.rect.y: providerGroup.height + 8
                        visible: providerGroup.tooltipOpen
                        implicitWidth: 350
                        implicitHeight: Math.min(tooltipContent.implicitHeight + 24,
                            (root.parentScreen ? root.parentScreen.height : 1000) - 80)
                        color: "transparent"

                        Rectangle {
                            anchors.fill: parent
                            radius: 10
                            color: Theme.surfaceContainerHigh
                            border.color: Theme.outlineLight

                            HoverHandler {
                                id: cardHover
                                onHoveredChanged: {
                                    if (hovered)
                                        tooltipClose.stop()
                                    else
                                        tooltipClose.restart()
                                }
                            }
                        }

                        Flickable {
                            anchors.fill: parent
                            anchors.margins: 12
                            contentHeight: tooltipContent.implicitHeight
                            clip: true

                            Column {
                                id: tooltipContent
                                x: 0
                                y: 0
                                width: 326
                                spacing: 10

                                Row {
                                    spacing: 8
                                    TokitokiProviderLogo {
                                        provider: providerGroup.groupData.provider
                                        registry: root.payload.providerRegistry || ({})
                                        size: 18
                                    }
                                    StyledText {
                                        text: providerGroup.groupData.label
                                        color: Theme.surfaceText
                                        font.weight: Font.DemiBold
                                        font.pixelSize: Theme.fontSizeSmall
                                    }
                                }

                                Repeater {
                                    model: providerGroup.groupData.profiles
                                    delegate: Column {
                                        required property var modelData
                                        required property int index
                                        width: tooltipContent.width
                                        spacing: 6

                                        Rectangle {
                                            width: parent.width
                                            height: 1
                                            color: Theme.withAlpha(Theme.outlineLight, 0.5)
                                            visible: index > 0
                                        }

                                        Row {
                                            spacing: 6
                                            DIcon {
                                                name: "account_circle"
                                                size: 14
                                                color: Theme.surfaceVariantText
                                            }
                                            StyledText {
                                                text: modelData.name
                                                width: tooltipContent.width - 22
                                                elide: Text.ElideRight
                                                color: Theme.surfaceVariantText
                                                font.pixelSize: Theme.fontSizeSmall
                                            }
                                        }

                                        Repeater {
                                            model: modelData.rows
                                            delegate: RowLayout {
                                                id: quotaTooltipRow
                                                required property var modelData
                                                readonly property string countdown: root.barCountdown(modelData.resetsAt)
                                                width: tooltipContent.width
                                                spacing: 6

                                                DIcon {
                                                    name: modelData.icon
                                                    size: 14
                                                    color: Theme.surfaceVariantText
                                                }
                                                StyledText {
                                                    text: modelData.label
                                                    Layout.fillWidth: true
                                                    elide: Text.ElideRight
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeSmall
                                                }
                                                StyledText {
                                                    text: modelData.value
                                                    color: modelData.color
                                                    font.weight: Font.DemiBold
                                                    font.pixelSize: Theme.fontSizeSmall
                                                }
                                                Rectangle {
                                                    width: 1
                                                    height: 12
                                                    color: Theme.outlineLight
                                                    visible: quotaTooltipRow.countdown.length > 0
                                                }
                                                DIcon {
                                                    name: "schedule"
                                                    size: 14
                                                    color: Theme.surfaceVariantText
                                                    visible: quotaTooltipRow.countdown.length > 0
                                                }
                                                StyledText {
                                                    text: quotaTooltipRow.countdown
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall
                                                    visible: text.length > 0
                                                }
                                            }
                                        }

                                        StyledText {
                                            text: "Quota unavailable"
                                            visible: modelData.rows.length === 0
                                            color: Theme.surfaceVariantText
                                            font.pixelSize: Theme.fontSizeSmall
                                        }
                                    }
                                }
                            }
                        }
                    }

                    spacing: Theme.spacingXS

                    Item {
                        width: 9
                        height: Math.max(8, root.iconSize - Theme.spacingXXS)
                        anchors.verticalCenter: parent.verticalCenter
                        visible: index > 0

                        Rectangle {
                            anchors.centerIn: parent
                            width: 1
                            height: parent.height
                            radius: 0.5
                            color: Theme.primary
                        }
                    }

                    TokitokiProviderLogo {
                        provider: groupData.provider
                        registry: root.payload.providerRegistry || ({})
                        size: root.iconSize
                        fallbackIcon: "monitoring"
                        fallbackColor: Theme.widgetIconColor
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    Row {
                        spacing: Theme.spacingXS
                        anchors.verticalCenter: parent.verticalCenter

                        Repeater {
                            model: providerGroup.groupData.lines
                            delegate: Row {
                                required property string modelData
                                required property int index
                                spacing: Theme.spacingXS

                                Rectangle {
                                    width: 1
                                    height: Math.max(8, root.iconSize - Theme.spacingXXS)
                                    radius: 0.5
                                    color: Theme.withAlpha("#a0a0a0", 0.35)
                                    anchors.verticalCenter: parent.verticalCenter
                                    visible: index > 0
                                }

                                StyledText {
                                    text: modelData
                                    color: Theme.widgetTextColor
                                    font.pixelSize: Theme.barTextSize(
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
        }
    }

    verticalBarPill: Component {
        Column {
            spacing: Theme.spacingXXS

            DIcon {
                name: "warning"
                size: root.iconSize
                color: root.incidentColor(root.vendorIncident(root.degradedBarVendors()[0]))
                anchors.horizontalCenter: parent.horizontalCenter
                visible: root.degradedBarVendors().length > 0
            }

            DIcon {
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

            headerActions: Component {
                Row {
                    spacing: Theme.spacingXXS

                    DActionButton {
                        buttonSize: 32
                        iconName: root.configOpen ? "arrow_back" : "more_vert"
                        iconSize: 18
                        iconColor: Theme.surfaceText
                        tooltipText: root.configOpen ? "Back to usage" : "Tokitoki settings"
                        onClicked: root.configOpen = !root.configOpen
                    }

                    DActionButton {
                        buttonSize: 32
                        iconName: "close"
                        iconSize: 18
                        iconColor: Theme.surfaceText
                        tooltipText: "Close Tokitoki"
                        onClicked: {
                            if (popout.closePopout)
                                popout.closePopout()
                        }
                    }
                }
            }

            Item {
                id: body

                width: parent.width
                implicitHeight: Math.max(0, root.popoutHeight - popout.headerHeight -
                    popout.detailsHeight - Theme.spacingXL)
                height: implicitHeight

                DFlickable {
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

                                    DIcon {
                                        name: "warning"
                                        size: Theme.iconSizeSmall
                                        color: Theme.error
                                        anchors.verticalCenter: parent.verticalCenter
                                    }

                                    StyledText {
                                        text: root.errorText
                                        width: Math.max(0, parent.width - retryButton.width - Theme.iconSizeSmall - parent.spacing * 2)
                                        color: Theme.error
                                        font.pixelSize: Theme.fontSizeMedium
                                        font.weight: Font.DemiBold
                                        wrapMode: Text.WordWrap
                                    }

                                    DButton {
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

                            DIcon {
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

                                DIcon {
                                    name: "search"
                                    size: Theme.iconSizeSmall
                                    color: Theme.surfaceVariantText
                                    anchors.verticalCenter: parent.verticalCenter
                                }

                                TextInput {
                                    id: searchInput
                                    Accessible.name: root.tabIs("sessions") ? "Search conversations" : "Search usage cards"

                                    width: Math.max(0, parent.width - (clearSearch.visible ? clearSearch.width + parent.spacing : 0) - Theme.iconSizeSmall - parent.spacing)
                                    height: parent.height
                                    text: root.searchText
                                    color: Theme.surfaceText
                                    selectionColor: Theme.primary
                                    selectedTextColor: Theme.primaryText
                                    font.family: Theme.fontFamily
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
                                        text: root.tabIs("sessions") ? "Search conversations…" : "Search harness, account, repo…"
                                        color: Theme.surfaceVariantText
                                        font.family: searchInput.font.family
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

                                DIcon {
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

                        Flow {
                            width: parent.width
                            spacing: Theme.spacingXXS

                                Repeater {
                                    model: root.tabOptions

                                    delegate: Rectangle {
                                        width: tabText.implicitWidth + Theme.spacingS * 2
                                        activeFocusOnTab: true
                                        Accessible.role: Accessible.Button
                                        Accessible.name: tabText.text
                                        Keys.onSpacePressed: root.selectedTab = modelData
                                        Keys.onReturnPressed: root.selectedTab = modelData
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

                        TokitokiCard {
                            title: "Service alerts"
                            iconName: "warning"
                            visible: root.tabIs("overview") && root.hasPayload && (root.degradedVendors().length > 0 || root.lastError.length > 0)
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    StyledText {
                                        width: parent.width
                                        visible: root.lastError.length > 0
                                        text: root.lastError
                                        color: Theme.warning
                                        wrapMode: Text.Wrap
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                    }

                                    Repeater {
                                        model: root.degradedVendors()
                                        Column {
                                            required property string modelData
                                            property var incident: root.vendorIncident(modelData)
                                            width: parent.width
                                            spacing: Theme.spacingXXS
                                            StyledText {
                                                width: parent.width
                                                text: root.providerShortName(parent.modelData) + " · " + root.displayLabel(parent.incident.indicator)
                                                color: root.incidentColor(parent.incident)
                                                font.weight: Font.DemiBold
                                            }
                                            StyledText {
                                                width: parent.width
                                                text: parent.incident.description || "See the provider status page"
                                                color: Theme.surfaceText
                                                wrapMode: Text.Wrap
                                                font.pixelSize: Theme.fontSizeSmall + 1
                                            }
                                            DButton {
                                                visible: Boolean(parent.incident.url)
                                                text: "View status"
                                                iconName: "open_in_new"
                                                buttonHeight: 28
                                                onClicked: Qt.openUrlExternally(parent.incident.url)
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Sessions"
                            iconName: "forum"
                            visible: root.tabIs("sessions")
                            contentComponent: Component {
                                TokitokiSessionsView {
                                    width: parent ? parent.width : 0
                                    command: root.command
                                    query: root.searchText
                                    privacyHideNames: root.privacyHideRepoSessionNames
                                    privacyHideIdentities: root.privacyHideIdentities
                                    active: root.tabIs("sessions") && !root.configOpen
                                }
                            }
                        }

                        TokitokiCard {
                            title: root.shellName + " integration"
                            iconName: "settings"
                            visible: root.tabIs("settings") && root.cardSurvives("integration")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    StyledText {
                                        width: parent.width
                                        text: "Display settings live in " + root.settingsLocation + ". Tokitoki data, budgets, and provider configuration remain in Tokitoki's own config."
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
                                        text: "Leave empty to use the default `tokitoki`; set a full path in the widget settings for development."
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Notifications & spend guard"
                            iconName: "notifications"
                            visible: root.tabIs("settings") && root.cardSurvives("notifications")
                            contentComponent: Component {
                                TokitokiNotifications {
                                    width: parent ? parent.width : 0
                                    command: root.command
                                    shellName: root.shellName
                                    settings: root.payload.notifications || ({})
                                    spendHealth: root.payload.spendHealth || null
                                    enabled: root.hasPayload
                                    onRefreshRequested: root.refresh(false)
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Activity today"
                            iconName: "analytics"
                            visible: root.tabIs("overview") && root.hasPayload && root.cardSurvives("spend")
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
                                                    text: root.formatMoney(root.metricTotal("today", "cost"))
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeXLarge + 8
                                                    font.weight: Font.Bold
                                                    isMonospace: true
                                                }

                                                StyledText {
                                                    text: root.reportTotal("today")
                                                        ? root.compactNumber(root.reportTotal("today").requests) + " requests"
                                                        : "loading…"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                }
                                            }
                                        }

                                        Column {
                                            width: parent.width * 0.52
                                            spacing: Theme.spacingXS

                                            RowLayout {
                                                width: parent.width
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    text: "This week"
                                                    Layout.fillWidth: true
                                                    elide: Text.ElideRight
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                }
                                                StyledText {
                                                    id: weekValue
                                                    text: root.reportTotal("week")
                                                        ? root.formatMoney(root.reportTotal("week").costUsd)
                                                        : "—"
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    font.weight: Font.DemiBold
                                                    isMonospace: true
                                                }
                                            }

                                            RowLayout {
                                                width: parent.width
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    text: "Month to date"
                                                    Layout.fillWidth: true
                                                    elide: Text.ElideRight
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
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

                                            RowLayout {
                                                width: parent.width
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    text: "Burn · projected"
                                                    Layout.fillWidth: true
                                                    elide: Text.ElideRight
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
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
                            visible: root.tabIs("overview") && root.attentionItems.length > 0 &&
                                root.cardSurvives("spend")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.attentionItems

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                DIcon {
                                                    name: "error"
                                                    size: Theme.iconSizeSmall
                                                    color: Theme.warning
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    text: modelData.title
                                                    Layout.fillWidth: true
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    id: detail
                                                    text: modelData.detail
                                                    Layout.maximumWidth: parent.width * 0.68
                                                    elide: Text.ElideRight
                                                    color: Theme.warning
                                                    font.pixelSize: Theme.fontSizeSmall - 1
                                                    isMonospace: true
                                                    horizontalAlignment: Text.AlignRight
                                                    Layout.alignment: Qt.AlignVCenter
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        StyledText {
                            width: parent.width
                            visible: root.tabIs("quotas") && root.hasPayload && root.filteredLimits().length === 0
                            text: root.searchIsActive() ? "No matching quota accounts."
                                : "No visible quota accounts. Scan sources or manage account visibility in the settings menu."
                            color: Theme.surfaceVariantText
                            font.pixelSize: Theme.fontSizeMedium
                            wrapMode: Text.WordWrap
                        }

                        TokitokiCard {
                            title: "Usage limits"
                            iconName: "speed"
                            visible: root.tabIs("quotas") && root.filteredLimits().length > 0 &&
                                root.cardSurvives("limits")
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

                                                RowLayout {
                                                    id: accountHeader

                                                    width: parent.width
                                                    height: 30
                                                    spacing: Theme.spacingXS

                                                    TokitokiProviderLogo {
                                                        provider: accountCard.account.provider
                                                        registry: root.payload.providerRegistry || ({})
                                                        size: Theme.iconSizeLarge
                                                        showBackground: true
                                                        fallbackIcon: root.providerEntry(accountCard.account.provider) ? root.harnessIcon(accountCard.account.provider) : "account_circle"
                                                        fallbackColor: Theme.primary
                                                        Layout.alignment: Qt.AlignVCenter
                                                    }

                                                    Column {
                                                        Layout.fillWidth: true
                                                        spacing: 0
                                                        Layout.alignment: Qt.AlignVCenter

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
                                                        id: incidentBadge
                                                        property var incident: root.vendorIncident(root.vendorFor(accountCard.account.provider, accountCard.account.vendor))
                                                        width: incident ? incidentRow.implicitWidth + Theme.spacingS * 2 : 0
                                                        height: incident ? 22 : 0
                                                        radius: 11
                                                        color: Theme.withAlpha(root.incidentColor(incident), 0.16)
                                                        visible: incident !== null
                                                        Layout.alignment: Qt.AlignVCenter

                                                        Row {
                                                            id: incidentRow
                                                            anchors.centerIn: parent
                                                            spacing: Theme.spacingXXS

                                                            DIcon {
                                                                name: "warning"
                                                                size: 14
                                                                color: root.incidentColor(incidentBadge.incident)
                                                                anchors.verticalCenter: parent.verticalCenter
                                                            }

                                                            StyledText {
                                                                text: incidentBadge.incident ? String(incidentBadge.incident.indicator).toUpperCase() : ""
                                                                color: root.incidentColor(incidentBadge.incident)
                                                                font.pixelSize: Theme.fontSizeSmall
                                                                font.weight: Font.DemiBold
                                                                anchors.verticalCenter: parent.verticalCenter
                                                            }
                                                        }

                                                        MouseArea {
                                                            anchors.fill: parent
                                                            cursorShape: Qt.PointingHandCursor
                                                            enabled: incidentBadge.incident !== null && Boolean(incidentBadge.incident.url)
                                                            onClicked: Qt.openUrlExternally(incidentBadge.incident.url)
                                                        }
                                                    }

                                                    Rectangle {
                                                        id: planBadge
                                                        property string plan: accountCard.account.planLabel || accountCard.account.plan || ""
                                                        width: plan.length > 0
                                                            ? planText.implicitWidth + Theme.spacingS * 2
                                                            : 0
                                                        height: plan.length > 0 ? 22 : 0
                                                        radius: 11
                                                        color: Theme.withAlpha(Theme.surfaceText, 0.08)
                                                        visible: plan.length > 0
                                                        Layout.alignment: Qt.AlignVCenter

                                                        StyledText {
                                                            id: planText
                                                            anchors.centerIn: parent
                                                            text: planBadge.plan.toUpperCase()
                                                            color: Theme.surfaceVariantText
                                                            font.pixelSize: Theme.fontSizeSmall
                                                            font.weight: Font.DemiBold
                                                        }
                                                    }

                                                    DActionButton {
                                                        buttonSize: 24
                                                        iconSize: 16
                                                        iconName: "arrow_upward"
                                                        tooltipText: "Move up in Quotas"
                                                        enabled: !root.accountOrderBusy && root.shiftedAccountOrder(accountCard.account, -1) !== null
                                                        onClicked: root.moveAccount(accountCard.account, -1)
                                                    }

                                                    DActionButton {
                                                        buttonSize: 24
                                                        iconSize: 16
                                                        iconName: "arrow_downward"
                                                        tooltipText: "Move down in Quotas"
                                                        enabled: !root.accountOrderBusy && root.shiftedAccountOrder(accountCard.account, 1) !== null
                                                        onClicked: root.moveAccount(accountCard.account, 1)
                                                    }

                                                    DActionButton {
                                                        id: hideButton
                                                        buttonSize: 26
                                                        iconSize: 16
                                                        iconName: "visibility_off"
                                                        iconColor: Theme.surfaceVariantText
                                                        tooltipText: "Hide this account everywhere"
                                                        enabled: !visibilityProcess.running
                                                        Layout.alignment: Qt.AlignVCenter
                                                        onClicked: root.setAccountHidden(
                                                            accountCard.account.provider,
                                                            accountCard.account.accountKey,
                                                            true
                                                        )
                                                    }
                                                }

                                                RowLayout {
                                                    width: parent.width
                                                    spacing: Theme.spacingXS
                                                    Item {
                                                        Layout.fillWidth: true
                                                    }
                                                    DActionButton {
                                                        buttonSize: 24
                                                        iconSize: 16
                                                        iconName: "arrow_back"
                                                        tooltipText: "Move earlier in the bar"
                                                        enabled: !root.accountOrderBusy && root.shiftedAccountOrder(accountCard.account, -1, "bar") !== null
                                                        onClicked: root.moveAccount(accountCard.account, -1, "bar")
                                                    }
                                                    DActionButton {
                                                        buttonSize: 24
                                                        iconSize: 16
                                                        iconName: "arrow_forward"
                                                        tooltipText: "Move later in the bar"
                                                        enabled: !root.accountOrderBusy && root.shiftedAccountOrder(accountCard.account, 1, "bar") !== null
                                                        onClicked: root.moveAccount(accountCard.account, 1, "bar")
                                                    }
                                                    DActionButton {
                                                        buttonSize: 24
                                                        iconSize: 16
                                                        iconName: root.barAccountHidden(accountCard.account) ? "visibility_off" : "visibility"
                                                        tooltipText: root.barAccountHidden(accountCard.account) ? "Show in bar" : "Hide from bar only"
                                                        enabled: !barVisibilityProcess.running
                                                        onClicked: root.setBarAccountHidden(accountCard.account, !root.barAccountHidden(accountCard.account))
                                                    }
                                                }

                                                Column {
                                                    id: quotaRows
                                                    width: parent.width
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

                                                                RowLayout {
                                                                    width: parent.width
                                                                    spacing: Theme.spacingXS

                                                                    StyledText {
                                                                        text: root.windowTitle(windowData)
                                                                        Layout.fillWidth: true
                                                                        color: Theme.surfaceVariantText
                                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                                        font.weight: Font.Medium
                                                                        Layout.alignment: Qt.AlignVCenter
                                                                    }

                                                                    StyledText {
                                                                        id: valueText
                                                                        text: root.limitValueLabel(windowData)
                                                                        Layout.maximumWidth: parent.width * 0.8
                                                                        elide: Text.ElideRight
                                                                        color: root.hasUsedPercent(windowData)
                                                                            ? root.limitColor(windowData)
                                                                            : Theme.surfaceVariantText
                                                                        font.pixelSize: Theme.fontSizeSmall + 1
                                                                        font.weight: Font.DemiBold
                                                                        isMonospace: true
                                                                        Layout.alignment: Qt.AlignVCenter
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

                                                                    Rectangle {
                                                                        property real fraction: root.paceMarkerFraction(windowData)
                                                                        visible: fraction >= 0
                                                                        x: Math.max(0, limitTrack.width * fraction - width / 2)
                                                                        y: -2
                                                                        width: 2
                                                                        height: parent.height + 4
                                                                        radius: 1
                                                                        color: Theme.surfaceText
                                                                        opacity: 0.7
                                                                    }
                                                                }

                                                                RowLayout {
                                                                    width: parent.width
                                                                    spacing: Theme.spacingXS
                                                                    visible: paceText.text.length > 0 || resetText.text.length > 0

                                                                    StyledText {
                                                                        id: paceText
                                                                        text: root.paceLabel(windowData)
                                                                        color: windowData.pace && windowData.pace.status === "over"
                                                                            ? Theme.warning
                                                                            : Theme.surfaceVariantText
                                                                        font.pixelSize: Theme.fontSizeSmall
                                                                        Layout.fillWidth: true
                                                                        elide: Text.ElideRight
                                                                    }

                                                                    StyledText {
                                                                        id: resetText
                                                                        text: root.quotaStatus(windowData) === "current"
                                                                            ? root.resetLabel(windowData.resetsAt) : "Awaiting fresh observation"
                                                                        color: Theme.surfaceVariantText
                                                                        font.pixelSize: Theme.fontSizeSmall
                                                                        horizontalAlignment: Text.AlignRight
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }

                                                StyledText {
                                                    text: root.extraUsageLabel(accountCard.account.extraUsage)
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    visible: text.length > 0
                                                }

                                                StyledText {
                                                    text: root.workspaceCreditsLabel(accountCard.account.credits)
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    visible: text.length > 0
                                                }

                                                StyledText {
                                                    width: parent.width
                                                    text: root.balanceLabel(accountCard.account.balance)
                                                    color: accountCard.account.balance && accountCard.account.balance.available === false
                                                        ? Theme.warning : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    elide: Text.ElideRight
                                                    visible: text.length > 0
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
                            title: "Hidden accounts · " + root.hiddenLimits().length
                            iconName: "visibility_off"
                            visible: root.tabIs("quotas") && root.hiddenLimits().length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS
                                    Rectangle {
                                        width: parent.width
                                        height: 28
                                        radius: Theme.cornerRadius
                                        color: Theme.withAlpha(Theme.surfaceText, 0.06)
                                        StyledText {
                                            anchors.centerIn: parent
                                            text: root.hiddenAccountsExpanded ? "Collapse hidden accounts" : "Show hidden accounts"
                                            color: Theme.surfaceText
                                            font.pixelSize: Theme.fontSizeSmall
                                        }
                                        MouseArea {
                                            anchors.fill: parent
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: root.hiddenAccountsExpanded = !root.hiddenAccountsExpanded
                                        }
                                    }
                                    Repeater {
                                        model: root.hiddenAccountsExpanded ? root.hiddenLimits() : []
                                        delegate: RowLayout {
                                            width: parent.width
                                            StyledText {
                                                Layout.fillWidth: true
                                                text: root.accountPrimaryLabel(modelData)
                                                elide: Text.ElideRight
                                                color: Theme.surfaceVariantText
                                                font.pixelSize: Theme.fontSizeSmall
                                            }
                                            DActionButton {
                                                buttonSize: 28
                                                iconSize: 18
                                                iconName: "visibility"
                                                tooltipText: root.restoreAccountLabel(modelData)
                                                enabled: !visibilityProcess.running
                                                onClicked: root.setAccountHidden(modelData.provider, modelData.accountKey, false)
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
                                root.hasPayload && root.cardSurvives("usage")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    ReportControls { }
                                    BreakdownPie {
                                        slices: root.distributionSlices
                                        centerLabel: root.selectedMetric === "cost"
                                            ? root.formatMoney(root.metricTotal(root.selectedPeriod, root.selectedMetric))
                                            : root.compactNumber(root.metricTotal(root.selectedPeriod, root.selectedMetric))
                                        centerUnit: root.metricLabel(root.selectedMetric)
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Token composition · " + root.compositionRangeLabel(root.compositionPeriod)
                            iconName: "data_usage"
                            visible: root.tabIs("tokens") && root.cardSurvives("composition") && (root.hasTokenMixReport("day") ||
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
                                                activeFocusOnTab: true
                                                Accessible.role: Accessible.Button
                                                Accessible.name: compositionPeriodText.text
                                                Keys.onSpacePressed: root.compositionPeriod = modelData
                                                Keys.onReturnPressed: root.compositionPeriod = modelData
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
                                                            width: Math.max(0, parent.width - value.width - 7 - parent.spacing * 2)
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
                            title: "Tracking quality · " + root.compositionRangeLabel(root.compositionPeriod)
                            iconName: "fact_check"
                            visible: root.tabIs("tokens") && root.cardSurvives("tracking") && root.trackingReport !== null
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    StyledText {
                                        width: parent.width
                                        text: root.trackingReport ? root.compactNumber(root.trackingReport.totalTokens) + " tokens · " +
                                            root.compactNumber(root.trackingReport.requests) + " requests" : ""
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeMedium
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: root.trackingReport ? "Pricing coverage: " + root.trackingPercent(root.trackingReport.pricingCoveragePercent) +
                                            " · Cached input: " + root.trackingPercent(root.trackingReport.cachedInputPercent) : ""
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: root.trackingSources(root.trackingReport)
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: root.trackingTokenSummary(root.trackingReport)
                                        visible: text.length > 0
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: "Estimated from visible text (characters ÷ 4); hidden context is not counted."
                                        visible: Boolean(root.trackingReport && root.trackingReport.estimatedTokens > 0)
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: root.trackingReport ? "Known usage value: " + root.formatMoney(root.trackingReport.costUsd) : ""
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeMedium
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: "Harness costs and API-rate estimates, not a subscription bill. Unpriced usage is excluded."
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: root.trackingMissingPrices(root.trackingReport)
                                        visible: text.length > 0
                                        color: Theme.warning
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WrapAnywhere
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Usage history · " + root.historyRangeLabel(root.historyPeriod)
                            iconName: "analytics"
                            visible: root.tabIs("tokens") && root.hasHistoryData && root.cardSurvives("history")
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
                                                activeFocusOnTab: true
                                                Accessible.role: Accessible.Button
                                                Accessible.name: historyPeriodText.text
                                                Keys.onSpacePressed: root.historyPeriod = modelData
                                                Keys.onReturnPressed: root.historyPeriod = modelData
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
                            title: "Token pulse"
                            iconName: "monitor_heart"
                            visible: (root.tabIs("overview") || root.tabIs("tokens")) &&
                                root.tokenPulseTotal() !== null && root.cardSurvives("pulse")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS
                                    RowLayout {
                                        width: parent.width
                                        Column {
                                            Layout.fillWidth: true
                                            StyledText {
                                                text: root.compactNumber(root.tokenPulseTotal() ? root.tokenPulseTotal().tokens : 0)
                                                color: Theme.surfaceText
                                                font.pixelSize: Theme.fontSizeXLarge
                                                font.weight: Font.DemiBold
                                            }
                                            StyledText {
                                                text: "Tokens · " + root.periodLabel(root.selectedPeriod)
                                                color: Theme.surfaceVariantText
                                                font.pixelSize: Theme.fontSizeSmall + 1
                                            }
                                        }
                                        Column {
                                            StyledText {
                                                text: root.compactNumber(root.tokenPulseTotal() ? root.tokenPulseTotal().requests : 0) + " requests"
                                                color: Theme.surfaceVariantText
                                                font.pixelSize: Theme.fontSizeSmall + 1
                                            }
                                            StyledText {
                                                text: root.compactNumber(root.tokenPulseTotal() ? root.tokenPulseTotal().sessions : 0) + " sessions"
                                                visible: root.tokenPulseTotal() !== null && root.tokenPulseTotal().sessions !== null
                                                color: Theme.surfaceVariantText
                                                font.pixelSize: Theme.fontSizeSmall + 1
                                            }
                                            StyledText {
                                                text: root.formatMoney(root.tokenPulseTotal() ? root.tokenPulseTotal().costUsd : 0)
                                                color: Theme.surfaceText
                                                font.pixelSize: Theme.fontSizeMedium
                                                isMonospace: true
                                            }
                                        }
                                    }
                                    ReportControls { }
                                    TokitokiSparkline {
                                        width: parent.width
                                        history: root.payload.history
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: "Daily tokens · last 30 days"
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "By provider · " + root.metricLabel(root.selectedMetric)
                            iconName: "hub"
                            visible: (root.tabIs("overview") || root.tabIs("tokens")) &&
                                root.providerSlices.length > 0 && root.cardSurvives("provider")
                            contentComponent: Component {
                                BreakdownPie {
                                    slices: root.providerSlices
                                    centerLabel: root.selectedMetric === "cost"
                                        ? root.formatMoney(root.slicesTotal(root.providerSlices))
                                        : root.compactNumber(root.slicesTotal(root.providerSlices))
                                    centerUnit: root.metricLabel(root.selectedMetric)
                                }
                            }
                        }

                        TokitokiCard {
                            title: "By model · " + root.metricLabel(root.selectedMetric)
                            iconName: "deployed_code"
                            visible: (root.tabIs("overview") || root.tabIs("tokens")) &&
                                root.modelSlices.length > 0 && root.cardSurvives("model")
                            contentComponent: Component {
                                BreakdownPie {
                                    slices: root.modelSlices
                                    centerLabel: root.selectedMetric === "cost"
                                        ? root.formatMoney(root.slicesTotal(root.modelSlices))
                                        : root.compactNumber(root.slicesTotal(root.modelSlices))
                                    centerUnit: root.metricLabel(root.selectedMetric)
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Repo activity · 30 days"
                            iconName: "bar_chart"
                            visible: (root.tabIs("reports") || root.tabIs("overview")) && root.hasPayload &&
                                Boolean(root.payload.repoHistory) &&
                                Array.isArray(root.payload.repoHistory.days) &&
                                root.payload.repoHistory.days.length > 0 && root.cardSurvives("repoHistory")
                            contentComponent: Component {
                                TokitokiHistoryChart {
                                    width: parent ? parent.width : 0
                                    history: root.privateRepoHistory()
                                    period: "month"
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Activity · last year"
                            iconName: "calendar_month"
                            visible: root.tabIs("reports") && root.hasActivityGrid && root.cardSurvives("activity")
                            contentComponent: Component {
                                TokitokiActivityGrid {
                                    width: parent ? parent.width : 0
                                    payload: root.payload.activityGrid
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Via T3code"
                            iconName: "apps"
                            visible: (root.tabIs("overview") || root.tabIs("sources")) &&
                                Boolean(root.t3codeReport) && root.cardSurvives("t3code")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingS

                                    ReportControls { showMetric: false }

                                    StyledText {
                                        width: parent.width
                                        text: root.t3codeReport
                                            ? root.compactNumber(root.t3codeReport.total.sessions) + " sessions · " +
                                                root.compactNumber(root.t3codeReport.total.requests) + " requests · " +
                                                root.compactNumber(root.totalTokens(root.t3codeReport.total)) + " tokens · " +
                                                root.formatMoney(root.t3codeReport.total.costUsd) + " estimated"
                                            : ""
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeMedium
                                        wrapMode: Text.WordWrap
                                    }

                                    StyledText {
                                        width: parent.width
                                        text: root.trackingTokenSummary(root.t3codeReport ? root.t3codeReport.total : null)
                                        visible: text.length > 0
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }
                                    StyledText {
                                        width: parent.width
                                        text: "Observed application activity. Excluded from totals; may already be included in harnesses. Costs are estimated."
                                        color: Theme.surfaceVariantText
                                        font.pixelSize: Theme.fontSizeSmall + 1
                                        wrapMode: Text.WordWrap
                                    }

                                    Repeater {
                                        model: root.t3codeReport ? root.t3codeReport.rows : []
                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            rowHeight: t3codeModelDetails.implicitHeight + verticalPadding * 2
                                            Column {
                                                id: t3codeModelDetails
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS
                                                StyledText {
                                                    width: parent.width
                                                    text: modelData.bucket
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                }
                                                StyledText {
                                                    width: parent.width
                                                    text: root.compactNumber(modelData.sessions) + " sess · " +
                                                        root.compactNumber(modelData.requests) + " req · " +
                                                        root.compactNumber(root.totalTokens(modelData)) + " tok · " +
                                                        root.formatMoney(modelData.costUsd) + " est."
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    wrapMode: Text.WordWrap
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        TokitokiCard {
                            title: "Today by harness"
                            iconName: "apps"
                            visible: (root.tabIs("overview") || root.tabIs("sources")) &&
                                root.rowsForPeriod("today").length > 0 &&
                                root.cardSurvives("harness")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    Repeater {
                                        model: root.rowsForPeriod("today").slice(0, 7)

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                TokitokiProviderLogo {
                                                    provider: modelData.bucket
                                                    registry: root.payload.providerRegistry || ({})
                                                    size: Theme.iconSizeSmall
                                                    fallbackIcon: root.harnessIcon(modelData.bucket)
                                                    fallbackColor: root.paletteColor(modelData.bucket)
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    text: root.providerName(modelData.bucket)
                                                    Layout.fillWidth: true
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    id: requests
                                                    text: root.compactNumber(modelData.requests) + " req"
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    id: cost
                                                    text: root.formatMoney(modelData.costUsd)
                                                    color: root.safeNumber(modelData.costUsd) > 0
                                                        ? Theme.surfaceText : Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    isMonospace: true
                                                    Layout.alignment: Qt.AlignVCenter
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
                                root.rowsFromReport(root.payload.reposMonth).length > 0 &&
                                root.cardSurvives("repos")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    Repeater {
                                        model: root.rowsFromReport(root.payload.reposMonth).slice(0, 6)

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                StyledText {
                                                    text: root.privacyHideRepoSessionNames
                                                        ? "Private repository"
                                                        : String(modelData.bucket || "").split("/").pop()
                                                    Layout.fillWidth: true
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    Layout.alignment: Qt.AlignVCenter
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
                                                    Layout.alignment: Qt.AlignVCenter
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
                                root.tabIs("mcp")) && root.hasPayload && Boolean(root.payload.topTools) &&
                                Array.isArray(root.payload.topTools.tools) &&
                                root.payload.topTools.tools.length > 0 &&
                                root.cardSurvives("tools")
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

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                StyledText {
                                                    text: modelData.tool
                                                    Layout.fillWidth: true
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    id: toolValue
                                                    text: root.safeNumber(modelData.costUsd) >= 0.01
                                                        ? root.formatMoney(modelData.costUsd)
                                                        : root.compactNumber(modelData.tokens)
                                                    color: Theme.surfaceVariantText
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    Layout.alignment: Qt.AlignVCenter
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
                                root.payload.budgets.length > 0 && root.cardSurvives("budgets")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.budgets || []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                DIcon {
                                                    name: modelData.state === "exceeded" ? "error" : "speed"
                                                    size: Theme.iconSizeSmall
                                                    color: root.stateColor(modelData.state)
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    text: modelData.label
                                                    Layout.fillWidth: true
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    id: budgetValue
                                                    text: root.formatMoney(modelData.used) + " / " +
                                                        root.formatMoney(modelData.cap)
                                                    color: root.stateColor(modelData.state)
                                                    font.pixelSize: Theme.fontSizeSmall + 1
                                                    isMonospace: true
                                                    Layout.alignment: Qt.AlignVCenter
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
                                root.hasPayload && Boolean(root.payload.anomalies) &&
                                Array.isArray(root.payload.anomalies.anomalies) &&
                                root.payload.anomalies.anomalies.length > 0 &&
                                root.cardSurvives("anomalies")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.anomalies ? root.payload.anomalies.anomalies.slice(0, 4) : []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            rowHeight: 32

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                DIcon {
                                                    name: "warning"
                                                    size: Theme.iconSizeSmall
                                                    color: Theme.warning
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                StyledText {
                                                    text: modelData.day + " · " + root.compactNumber(modelData.value) + " " +
                                                        root.displayLabel(modelData.metric)
                                                    Layout.fillWidth: true
                                                    color: Theme.surfaceText
                                                    font.pixelSize: Theme.fontSizeMedium
                                                    elide: Text.ElideRight
                                                    Layout.alignment: Qt.AlignVCenter
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
                                                    Layout.alignment: Qt.AlignVCenter
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
                                Boolean(root.payload.statuslinePreview) && root.cardSurvives("statusline")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXXS

                                    StyledText {
                                        width: parent.width
                                        text: root.payload.statuslinePreview
                                            ? String(root.payload.statuslinePreview.preview || "") : ""
                                        color: Theme.surfaceText
                                        font.pixelSize: Theme.fontSizeMedium
                                        isMonospace: true
                                        elide: Text.ElideRight
                                    }

                                    StyledText {
                                        width: parent.width
                                        text: root.payload.statuslinePreview
                                            ? String(root.payload.statuslinePreview.command || "") : ""
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
                            visible: root.tabIs("reports") && root.hasPayload && Boolean(root.payload.blocks) &&
                                Array.isArray(root.payload.blocks.rows) &&
                                root.payload.blocks.rows.length > 0 && root.cardSurvives("blocks")
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.payload.blocks ? root.payload.blocks.rows.slice(0, 6) : []

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1
                                            rowHeight: 44

                                            RowLayout {
                                                anchors.fill: parent
                                                spacing: Theme.spacingXS

                                                Rectangle {
                                                    width: 7
                                                    height: 7
                                                    radius: 3.5
                                                    color: modelData.isActive ? Theme.success : Theme.surfaceVariantText
                                                    Layout.alignment: Qt.AlignVCenter
                                                }

                                                Column {
                                                    Layout.fillWidth: true
                                                    spacing: 0
                                                    Layout.alignment: Qt.AlignVCenter

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
                                                    Layout.alignment: Qt.AlignVCenter
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
                                root.cardSurvives("activity") &&
                                root.otherActiveMachines(root.payload.presence).length > 0
                            contentComponent: Component {
                                Column {
                                    width: parent ? parent.width : 0
                                    spacing: Theme.spacingXS

                                    Repeater {
                                        model: root.otherActiveMachines(root.payload.presence)

                                        delegate: TokitokiListRow {
                                            alternate: index % 2 === 1

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
                                                    text: "Active · " + root.relativeAge(new Date(root.safeNumber(modelData.ts)).toISOString())
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
                            visible: root.tabIs("sources") && root.hasPayload && Boolean(root.payload.recentSessions) &&
                                Array.isArray(root.payload.recentSessions.rows) &&
                                root.payload.recentSessions.rows.length > 0 && root.cardSurvives("recentSessions")
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

                                                RowLayout {
                                                    width: parent.width
                                                    spacing: Theme.spacingXS

                                                StyledText {
                                                    text: root.privacyHideRepoSessionNames
                                                        ? "Private session"
                                                        : modelData.title || "(no title)"
                                                    Layout.fillWidth: true
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

                DFlickable {
                    id: settingsViewport

                    anchors.fill: parent
                    visible: root.configOpen
                    clip: true
                    contentWidth: width
                    contentHeight: settingsLoader.height + Theme.spacingS + Theme.spacingM

                    Loader {
                        id: settingsLoader
                        property bool opened: false
                        active: root.configOpen || opened

                        x: Theme.spacingM
                        y: Theme.spacingS
                        width: settingsViewport.width - Theme.spacingM * 2
                        height: item ? item.implicitHeight : 0
                        source: Qt.resolvedUrl("TokitokiSettings.qml")

                        onLoaded: {
                            opened = true
                            if (item) {
                                item.shellName = root.shellName
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

                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: Theme.spacingM
                        anchors.rightMargin: Theme.spacingM
                        spacing: Theme.spacingS

                        DButton {
                            id: refreshButton
                            text: root.isBusy
                                ? (root.scanNextRefresh ? "Scanning…" : "Refreshing…")
                                : "Refresh & scan"
                            iconName: root.isBusy ? "sync" : "refresh"
                            buttonHeight: 34
                            horizontalPadding: Theme.spacingM
                            enabled: !root.isBusy
                            Layout.alignment: Qt.AlignVCenter
                            onClicked: root.refresh(true)
                        }

                        Item { Layout.fillWidth: true }

                        DButton {
                            id: openButton
                            text: "Dashboard"
                            iconName: "open_in_new"
                            buttonHeight: 34
                            horizontalPadding: Theme.spacingS
                            Layout.alignment: Qt.AlignVCenter
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
        id: accountOrderProcess
        command: [root.command, "ui", root.pendingOrderSurface === "bar" ? "--bar-account-order" : "--account-order", root.pendingAccountOrder.join(",")]
            .concat(root.pendingOrderSurface === "bar" ? [] : ["--bar-account-order", root.pendingBarOrderSeed.join(",")])
        onExited: function(exitCode, exitStatus) {
            if (exitCode === 0) {
                if (root.pendingOrderSurface === "bar") root.barAccountOrderOverride = root.pendingAccountOrder.slice()
                else {
                    root.accountOrderOverride = root.pendingAccountOrder.slice()
                }
                root.refresh(false)
            } else {
                root.lastError = "Could not save account order (exit " + exitCode + ")"
            }
        }
    }

    Process {
        id: barVisibilityProcess
        command: [root.command, "config", "set", "ui.previewHiddenAccounts", JSON.stringify(root.pendingBarHidden)]
        onExited: function(exitCode, exitStatus) {
            if (exitCode === 0) {
                root.barHiddenOverride = root.pendingBarHidden.slice()
                root.refresh(false)
            } else root.lastError = "Could not save bar visibility (exit " + exitCode + ")"
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

        command: [root.command, "widget-payload"]
            .concat(root.cachedFirstRead ? ["--cached"] : root.scanNextRefresh ? [] : ["--skip-scan"])
            .concat(root.notifySupported ? ["--notify"] : [])
            .concat(["--json"])
        running: true

        stdout: StdioCollector {
            id: statusOutput
            onStreamFinished: {
                root.statusStdout = statusOutput.text
                root.statusStdoutDone = true
                root.finishStatus()
            }
        }

        stderr: StdioCollector {
            id: errorOutput
            onStreamFinished: {
                root.statusStderr = errorOutput.text
                root.statusStderrDone = true
                root.finishStatus()
            }
        }

        onExited: function(exitCode, exitStatus) {
            root.statusExited = true
            root.statusExitCode = exitCode
            root.finishStatus()
        }

        onRunningChanged: {
            if (!running && !root.statusExited) statusFailureTimer.restart()
        }
    }

    Timer {
        interval: 180000
        running: root.refreshActive
        onTriggered: root.statusTimedOut()
    }

    Timer {
        id: statusFailureTimer
        interval: 100
        onTriggered: {
            if (!statusProcess.running && !root.statusExited && root.refreshActive)
                root.statusStartFailed()
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
