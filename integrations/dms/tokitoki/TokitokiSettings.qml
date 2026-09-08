import QtQuick
import qs.Common
import qs.Modules.Plugins
import qs.Widgets

PluginSettings {
    id: root
    pluginId: "tokitoki"

    StyledText {
        width: parent.width
        text: "Tokitoki widget settings"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.Bold
    }

    StyledText {
        width: parent.width
        text: "These settings affect the DMS widget only. Tokitoki data and provider configuration remain in Tokitoki's own config."
        color: Theme.surfaceVariantText
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
        description: "The tab shown when the widget opens."
        options: [
            { label: "Overview", value: "overview" },
            { label: "Quotas", value: "quotas" },
            { label: "Tokens", value: "tokens" }
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
        text: "Privacy"
        color: Theme.surfaceText
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.DemiBold
    }

    ToggleSetting {
        settingKey: "privacyHideIdentities"
        label: "Mask account identities"
        description: "Hide account emails, keys, and credentials in the DMS widget."
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
