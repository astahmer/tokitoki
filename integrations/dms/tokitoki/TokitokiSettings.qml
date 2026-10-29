import QtQuick
import Quickshell.Io
import qs.Common
import qs.Modules.Plugins
import qs.DCommon.Widgets

PluginSettings {
    id: root
    pluginId: "tokitoki"

    property string shellName: "DMS"
    property var accounts: []
    property var providerRegistry: ({})
    property var hiddenBarWindows: ({})
    readonly property var barWindowGroups: root.buildBarWindowGroups()
    property var hiddenEntries: []
    property var barHiddenEntries: []
    property var pendingBarHidden: []
    property bool accountsExited: false
    property bool accountsLoading: false
    property bool accountsStdoutDone: false
    property int accountsExitCode: 0
    property string visibilityTarget: ""
    property bool visibilityHide: true
    property bool pendingReload: false
    property var pendingVisibilityChanges: []
    property string pendingPayload: ""
    property string loadError: ""
    property string visibilityError: ""
    readonly property bool hideIdentities: Boolean(root.loadValue("privacyHideIdentities", false))

    readonly property string tokitokiCommand: {
        const override = String(root.loadValue("executablePath", ""))
        return override.length > 0 ? override : "tokitoki"
    }

    function accountTarget(account) {
        return String(account.provider || "") + ":" + String(account.accountKey || "")
    }

    function barWindowKey(windowData) {
        var scope = String(windowData.scope || windowData.kind || "other").toLowerCase()
        var bucket = String(windowData.bucketId || "").toLowerCase()
        var model = String(windowData.model || "").toLowerCase()
        var label = String(windowData.label || "").toLowerCase()
        var scopes = { day: "daily", daily: "daily", week: "weekly", weekly: "weekly", month: "monthly", monthly: "monthly", session: "session" }
        scope = scopes[scope] || scope
        if ((scope === "other" || scope === "unknown") && scopes[label])
            scope = scopes[label]
        if (bucket === "codex" || bucket === "claude")
            bucket = ""
        if (!bucket && !model && label && !/^(session|daily|weekly|monthly|limit)$/.test(label))
            bucket = label
        var aliases = { "cursor models": "cursor-models", "other models": "other-models", "on demand": "on-demand" }
        bucket = aliases[bucket] || bucket
        if (["cursor-models", "other-models", "on-demand"].indexOf(bucket) >= 0)
            scope = "monthly"
        return JSON.stringify([scope, bucket, model])
    }

    function normalizeBarWindowKey(key) {
        try {
            var parts = JSON.parse(String(key))
            if (!Array.isArray(parts) || parts.length !== 3)
                return String(key)
            return barWindowKey({ scope: parts[0], bucketId: parts[1], model: parts[2] })
        } catch (error) {
            return String(key)
        }
    }

    function barWindowVisible(hidden, provider, windowData) {
        var entries = hidden && hidden[provider]
        var key = barWindowKey(windowData)
        return !Array.isArray(entries) || !entries.some(function(entry) { return normalizeBarWindowKey(entry) === key })
    }

    function buildBarWindowGroups() {
        const groups = []
        for (const account of root.accounts) {
            const entry = root.providerRegistry[account.provider] || ({})
            const provider = String(account.vendor || entry.vendor || account.provider || "")
            if (!provider) continue
            let group = groups.find(value => value.provider === provider)
            if (!group) {
                const vendorEntry = root.providerRegistry[provider] || ({})
                group = { provider: provider, label: String(vendorEntry.displayName || provider), windows: [] }
                groups.push(group)
            }
            for (const windowData of (Array.isArray(account.windows) ? account.windows : [])) {
                const id = root.barWindowKey(windowData)
                if (group.windows.some(value => value.id === id)) continue
                let label = String(windowData.label || windowData.model || windowData.scope || windowData.kind || "Limit")
                const minutes = Number(windowData.windowMinutes)
                if (/^session$/i.test(label) && Number.isFinite(minutes) && minutes > 0 && minutes % 60 === 0)
                    label += " (" + minutes / 60 + "h)"
                group.windows.push({ id: id, label: label, window: windowData })
            }
        }
        return groups.filter(value => value.windows.length > 0)
    }

    function setBarWindowVisible(provider, windowData, visible) {
        const next = Object.assign({}, root.hiddenBarWindows)
        const id = root.barWindowKey(windowData)
        const entries = Array.isArray(next[provider]) ? next[provider].filter(value => root.normalizeBarWindowKey(value) !== id) : []
        if (!visible) entries.push(id)
        if (entries.length) next[provider] = entries
        else delete next[provider]
        root.hiddenBarWindows = next
        root.saveValue("hiddenBarWindows", next)
    }

    function accountLabel(account) {
        if (root.hideIdentities)
            return "Private account"
        if (account.email)
            return String(account.email)
        if (account.label)
            return String(account.label)
        if (account.credential)
            return String(account.credential)
        return String(account.accountKey || "default")
    }

    function accountDescription(account) {
        if (root.hideIdentities)
            return String(account.provider || "provider") + " · identities hidden"
        const parts = [String(account.provider || "provider"), String(account.accountKey || "default")]
        if (account.planLabel)
            parts.push(String(account.planLabel))
        return parts.join(" · ")
    }

    function isAccountHidden(account) {
        return root.hiddenEntries.some(entry => root.hiddenEntryMatches(entry, account))
    }

    // "provider" hides the whole provider, "provider:accountKey" one account;
    // the account half is a suffix match, mirroring uiToggles.matches.
    function hiddenEntryMatches(entry, account) {
        const text = String(entry || "")
        const at = text.indexOf(":")
        const provider = String(account.provider || "")
        if (at <= 0)
            return text === provider
        return text.slice(0, at) === provider &&
            String(account.accountKey || "").endsWith(text.slice(at + 1))
    }

    function setAccountHidden(account, hidden) {
        root.visibilityError = ""
        const change = { target: root.accountTarget(account), hide: Boolean(hidden) }
        if (visibilityProcess.running) {
            const changes = root.pendingVisibilityChanges.slice()
            let queuedIndex = -1
            for (let i = 0; i < changes.length; i++) {
                if (changes[i].target === change.target) {
                    queuedIndex = i
                    break
                }
            }
            if (queuedIndex >= 0)
                changes[queuedIndex] = change
            else
                changes.push(change)
            root.pendingVisibilityChanges = changes
            return
        }
        root.startVisibilityChange(change)
    }

    function isBarAccountHidden(account) {
        return root.barHiddenEntries.indexOf(account.provider + "@" + account.accountKey) >= 0
    }

    function setBarAccountHidden(account, hidden) {
        if (barVisibilityProcess.running) return
        const id = account.provider + "@" + account.accountKey
        const next = root.barHiddenEntries.filter(value => value !== id)
        if (hidden) next.push(id)
        root.pendingBarHidden = next
        root.visibilityError = ""
        barVisibilityProcess.running = true
    }

    function startVisibilityChange(change) {
        root.visibilityTarget = change.target
        root.visibilityHide = change.hide
        visibilityProcess.running = true
    }

    function runNextVisibilityChange() {
        const changes = root.pendingVisibilityChanges.slice()
        if (changes.length === 0) {
            root.reload()
            return
        }
        const change = changes.shift()
        root.pendingVisibilityChanges = changes
        root.startVisibilityChange(change)
    }

    function reload() {
        if (accountsProcess.running || root.accountsLoading) {
            pendingReload = true
            return
        }
        root.pendingPayload = ""
        root.accountsLoading = true
        root.accountsExited = false
        root.accountsStdoutDone = false
        accountsProcess.running = true
    }

    function finishReload() {
        if (!root.accountsLoading || !root.accountsExited || !root.accountsStdoutDone) return
        root.accountsLoading = false
        if (root.accountsExitCode === 0) root.acceptPayload(root.pendingPayload)
        else root.loadError = "Could not load Tokitoki account settings (exit code " + root.accountsExitCode + ")."
        root.pendingPayload = ""
        if (root.pendingReload) {
            root.pendingReload = false
            root.reload()
        }
    }

    function acceptPayload(raw) {
        try {
            const parsed = JSON.parse(String(raw || ""))
            if (!parsed || parsed.app !== "tokitoki" || parsed.schema !== 1 || !Array.isArray(parsed.limits))
                throw new Error("Unsupported widget payload")
            if (!parsed.uiPreview || !Array.isArray(parsed.uiPreview.menubarHidden))
                throw new Error("payload is missing account visibility data")
            root.accounts = parsed.limits
            root.providerRegistry = parsed.providerRegistry || ({})
            root.hiddenEntries = parsed.uiPreview.menubarHidden
            root.barHiddenEntries = parsed.uiPreview.barHiddenAccounts || []
            root.loadError = ""
        } catch (error) {
            root.loadError = "Could not read Tokitoki account settings: " + String(error)
        }
    }

    // The payload always carries every account and the current hide list, so
    // this page and the widget render from the same source.
    Process {
        id: accountsProcess
        command: [root.tokitokiCommand, "widget-payload", "--cached", "--json"]
        stdout: StdioCollector {
            onStreamFinished: {
                root.pendingPayload = text
                root.accountsStdoutDone = true
                root.finishReload()
            }
        }
        stderr: StdioCollector {}
        onExited: function(exitCode, exitStatus) {
            root.accountsExitCode = exitCode
            root.accountsExited = true
            root.finishReload()
        }
    }

    Process {
        id: visibilityProcess
        command: [root.tokitokiCommand, "ui", root.visibilityHide ? "--hide" : "--show",
            root.visibilityTarget, "--surface", "widget"]
        onExited: function(exitCode, exitStatus) {
            if (exitCode !== 0)
                root.visibilityError = "Could not save account visibility (exit code " + exitCode + ")."
            root.runNextVisibilityChange()
        }
    }

    Process {
        id: barVisibilityProcess
        command: [root.tokitokiCommand, "config", "set", "ui.previewHiddenAccounts", JSON.stringify(root.pendingBarHidden)]
        onExited: function(exitCode, exitStatus) {
            if (exitCode === 0) {
                root.barHiddenEntries = root.pendingBarHidden.slice()
                root.reload()
            } else root.visibilityError = "Could not save bar visibility (exit code " + exitCode + ")."
        }
    }

    Component.onCompleted: {
        root.hiddenBarWindows = root.loadValue("hiddenBarWindows", ({})) || ({})
        Qt.callLater(root.reload)
    }

    Connections {
        target: root

        function onPluginServiceChanged() {
            Qt.callLater(root.reload)
        }
    }

    StyledText {
        width: parent.width
        text: "Tokitoki widget settings"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.Bold
    }

    StyledText {
        width: parent.width
        text: "These settings affect the " + root.shellName + " widget only. Tokitoki data and provider configuration remain in Tokitoki's own config."
        color: Theme.surfaceVariantText
        font.pixelSize: Theme.fontSizeSmall + 1
        wrapMode: Text.WordWrap
    }

    StyledText {
        visible: root.loadError.length > 0
        width: parent.width
        text: root.loadError
        color: Theme.error
        font.pixelSize: Theme.fontSizeSmall + 1
        wrapMode: Text.WordWrap
    }

    StyledText {
        width: parent.width
        text: "Refresh"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    ToggleSetting {
        settingKey: "autoRefreshEnabled"
        label: "Automatic refresh"
        description: "Keep the widget up to date in the background."
        defaultValue: true
    }

    SelectionSetting {
        settingKey: "autoRefreshIntervalMinutes"
        label: "Refresh interval"
        description: "How often the widget reads its payload."
        options: [
            { label: "1 minute", value: "1" },
            { label: "5 minutes", value: "5" },
            { label: "15 minutes", value: "15" },
            { label: "30 minutes", value: "30" }
        ]
        defaultValue: "5"
    }

    ToggleSetting {
        settingKey: "autoRefreshScansSources"
        label: "Scan sources automatically"
        description: "Include a source scan during automatic refreshes; manual Refresh & scan is always available."
        defaultValue: false
    }

    StyledText {
        width: parent.width
        text: "Widget behavior"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    SelectionSetting {
        settingKey: "openingTab"
        label: "Default tab"
        description: "The initial tab; later tab selections are remembered."
        options: [
            { label: "Overview", value: "overview" },
            { label: "Quotas", value: "quotas" },
            { label: "Tokens", value: "tokens" },
            { label: "Reports", value: "reports" },
            { label: "Sessions", value: "sessions" },
            { label: "Sources", value: "sources" },
            { label: "MCP", value: "mcp" },
            { label: "Settings", value: "settings" }
        ]
        defaultValue: "overview"
    }

    SelectionSetting {
        id: barSummaryModeSetting
        settingKey: "barSummaryMode"
        label: "Bar item content"
        description: "Show all quotas, the shortest window for each selected account, usage totals, or the icon only. The hover card keeps all windows."
        options: [
            { label: "Quotas", value: "summary" },
            { label: "Shortest window per account", value: "lowest-session" },
            { label: "Total usage", value: "total" },
            { label: "Icon only", value: "icon" }
        ]
        defaultValue: "summary"
    }

    SelectionSetting {
        visible: barSummaryModeSetting.value === "total"
        settingKey: "barTotalPeriod"
        label: "Total usage period"
        description: "Choose the period for aggregate token and cost totals."
        options: [
            { label: "Day", value: "day" },
            { label: "Week", value: "week" },
            { label: "Month", value: "month" }
        ]
        defaultValue: "day"
    }

    StyledText {
        width: parent.width
        text: "Bar quota windows"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    StyledText {
        width: parent.width
        text: "Choose the windows shown in the bar for each provider. Quota cards and hover details still show all windows."
        color: Theme.surfaceVariantText
        font.pixelSize: Theme.fontSizeSmall + 1
        wrapMode: Text.WordWrap
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS
        Repeater {
            model: root.barWindowGroups
            Column {
                id: barWindowGroup
                required property var modelData
                width: parent.width
                StyledText {
                    width: parent.width
                    text: parent.modelData.label
                    color: Theme.surfaceText
                    font.weight: Font.DemiBold
                }
                Repeater {
                    model: parent.modelData.windows
                    DToggle {
                        required property var modelData
                        property string providerId: barWindowGroup.modelData.provider
                        width: parent.width
                        text: modelData.label
                        checked: root.barWindowVisible(root.hiddenBarWindows, providerId, modelData.window)
                        onToggled: isChecked => root.setBarWindowVisible(providerId, modelData.window, isChecked)
                    }
                }
            }
        }
    }

    SelectionSetting {
        id: providerVisibilitySetting
        settingKey: "providerVisibility"
        label: "Provider visibility"
        description: "Show all providers, or only the ids listed below."
        options: [
            { label: "All providers", value: "all" },
            { label: "Selected providers", value: "selected" }
        ]
        defaultValue: "all"
    }

    StringSetting {
        visible: providerVisibilitySetting.value === "selected"
        settingKey: "selectedProviders"
        label: "Selected providers"
        description: "Comma-separated upstream provider ids, for example openai,claude,cursor."
        placeholder: "openai,claude"
        defaultValue: ""
    }

    StyledText {
        width: parent.width
        text: "Usage cards"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    StyledText {
        width: parent.width
        text: "Turn an account off to drop its card and its widget marks. The eye button on a card hides it here too."
        color: Theme.surfaceVariantText
        font.pixelSize: Theme.fontSizeSmall + 1
        wrapMode: Text.WordWrap
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS

        Repeater {
            model: root.accounts

            Column {
                required property var modelData
                width: parent.width
                DToggle {
                    width: parent.width
                    text: root.accountLabel(parent.modelData)
                    description: root.accountDescription(parent.modelData)
                    checked: !root.isAccountHidden(parent.modelData)
                    onToggled: isChecked => root.setAccountHidden(parent.modelData, !isChecked)
                }
                DToggle {
                    width: parent.width
                    text: "Show in bar"
                    description: "Independent from the Quotas card; reorder directly in Quotas."
                    checked: !root.isBarAccountHidden(parent.modelData)
                    enabled: !barVisibilityProcess.running && !root.isAccountHidden(parent.modelData)
                    onToggled: isChecked => root.setBarAccountHidden(parent.modelData, !isChecked)
                }
            }
        }
    }

    StyledText {
        visible: root.visibilityError.length > 0
        width: parent.width
        text: root.visibilityError
        color: Theme.error
        font.pixelSize: Theme.fontSizeSmall + 1
        wrapMode: Text.WordWrap
    }

    StyledText {
        width: parent.width
        text: "Privacy"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    ToggleSetting {
        settingKey: "privacyHideIdentities"
        label: "Mask account identities"
        description: "Hide account emails, keys, and credentials in the " + root.shellName + " widget."
        defaultValue: false
    }

    ToggleSetting {
        settingKey: "privacyHideRepoSessionNames"
        label: "Hide repository and session names"
        description: "Replace repository and session titles with private labels."
        defaultValue: false
    }

    StyledText {
        width: parent.width
        text: "Advanced"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    StringSetting {
        settingKey: "executablePath"
        label: "Tokitoki executable"
        description: "Leave empty to use tokitoki from PATH. Set a full path for development checkouts."
        placeholder: "/path/to/tokitoki"
        defaultValue: ""
    }
}
