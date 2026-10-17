import QtQuick
import Quickshell.Io
import qs.Common
import qs.Modules.Plugins
import qs.Widgets

PluginSettings {
    id: root
    pluginId: "tokitoki"

    property string shellName: "DMS"
    property var accounts: []
    property var hiddenEntries: []
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
        if (accountsProcess.running) {
            pendingReload = true
            return
        }
        root.pendingPayload = ""
        accountsProcess.running = true
    }

    function acceptPayload(raw) {
        try {
            const parsed = JSON.parse(String(raw || ""))
            if (!parsed || parsed.app !== "tokitoki" || parsed.schema !== 1 || !Array.isArray(parsed.limits))
                throw new Error("Unsupported widget payload")
            if (!parsed || !Array.isArray(parsed.limits) || !parsed.uiPreview ||
                    !Array.isArray(parsed.uiPreview.menubarHidden))
                throw new Error("payload is missing account visibility data")
            root.accounts = parsed.limits
            root.hiddenEntries = parsed.uiPreview.menubarHidden
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
            onStreamFinished: root.pendingPayload = text
        }
        onExited: function(exitCode, exitStatus) {
            if (exitCode === 0)
                root.acceptPayload(root.pendingPayload)
            else
                root.loadError = "Could not load Tokitoki account settings (exit code " + exitCode + ")."
            root.pendingPayload = ""
            if (root.pendingReload) {
                root.pendingReload = false
                root.reload()
            }
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

    Timer {
        running: true
        interval: 0
        onTriggered: root.reload()
    }

    Connections {
        target: root

        function onPluginServiceChanged() {
            root.reload()
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
        description: "Choose a compact summary, aggregate usage totals, or the icon only."
        options: [
            { label: "Compact summary", value: "summary" },
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

            DankToggle {
                required property var modelData

                width: parent.width
                text: root.accountLabel(modelData)
                description: root.accountDescription(modelData)
                checked: !root.isAccountHidden(modelData)
                onToggled: isChecked => root.setAccountHidden(modelData, !isChecked)
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
