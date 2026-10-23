pragma ComponentBehavior: Bound

import QtQuick
import Quickshell.Io
import qs.Common
import qs.DCommon.Widgets

Item {
    id: root

    property string command: "tokitoki"
    property string shellName: "DMS"
    property var settings: ({})
    property var spendHealth: null
    property var notificationSettings: ({
        enabled: false,
        resetAware: false,
        quotaCriticalPercent: 10,
        burnWarnings: false,
        burnWarningRatio: 0.8,
        disabledNotifications: []
    })
    property var optimisticSettings: ({})
    property var writeQueue: []
    property var activeWrite: null
    property var failedPaths: []

    signal refreshRequested()

    readonly property var categories: [
        { id: "quotaCritical", label: "Critical quota", description: "When a provider reports very little quota remaining." },
        { id: "quotaReset", label: "Quota reset / recovery", description: "When exhausted or critical quota becomes available again." },
        { id: "quotaPace", label: "Runs out before reset", description: "When the current burn rate exhausts a quota window before it resets." },
        { id: "burnRate", label: "Burn-rate", description: "When projected monthly spend reaches the configured warning ratio." },
        { id: "budget", label: "Budget threshold", description: "When spend crosses a configured budget threshold." }
    ]
    readonly property var criticalOptions: root.optionsWithCurrent([5, 10, 20], root.notificationSettings.quotaCriticalPercent)
    readonly property var burnRatioOptions: root.optionsWithCurrent([0.8, 0.9, 1], root.notificationSettings.burnWarningRatio)
    readonly property bool isWriting: writeProcess.running || root.activeWrite !== null || root.writeQueue.length > 0
    readonly property bool hasMonthlyCap: root.spendHealth !== null &&
        typeof root.spendHealth === "object" && Number(root.spendHealth.monthlyCap) > 0

    width: parent ? parent.width : implicitWidth
    implicitWidth: 360
    implicitHeight: content.implicitHeight

    Component.onCompleted: root.mergeIncomingSettings()
    onSettingsChanged: root.mergeIncomingSettings()

    component ChoiceChip: Rectangle {
        id: chip

        property string label: ""
        property bool selected: false
        signal activated()
        activeFocusOnTab: true
        Accessible.role: Accessible.Button
        Accessible.name: label
        Keys.onSpacePressed: activated()
        Keys.onReturnPressed: activated()

        height: 30
        radius: height / 2
        color: selected ? Theme.primaryContainer : Theme.withAlpha(Theme.surfaceText, 0.06)
        border.width: 1
        border.color: selected ? Theme.primary : Theme.outlineLight
        opacity: enabled ? 1 : 0.5

        StyledText {
            anchors.fill: parent
            anchors.leftMargin: Theme.spacingXXS
            anchors.rightMargin: Theme.spacingXXS
            text: chip.label
            color: chip.selected ? Theme.primary : Theme.surfaceText
            font.pixelSize: Theme.fontSizeSmall + 1
            font.weight: chip.selected ? Font.DemiBold : Font.Normal
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }

        MouseArea {
            anchors.fill: parent
            enabled: chip.enabled
            cursorShape: chip.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: chip.activated()
        }
    }

    component SettingToggle: DToggle {
        property string label: ""
        property bool toggleEnabled: true
        text: label
        enabled: toggleEnabled
    }

    function normalizeSettings(source) {
        var value = source && typeof source === "object" ? source : ({})
        var disabled = Array.isArray(value.disabledNotifications)
            ? value.disabledNotifications
            : Array.isArray(value.disabled) ? value.disabled : []
        return {
            enabled: value.enabled === true,
            resetAware: value.resetAware === true,
            quotaCriticalPercent: root.clampNumber(value.quotaCriticalPercent, 0, 100, 10),
            burnWarnings: value.burnWarnings === true,
            burnWarningRatio: root.clampNumber(value.burnWarningRatio, 0, 1, 0.8),
            disabledNotifications: disabled.slice()
        }
    }

    function clampNumber(value, minimum, maximum, fallback) {
        var number = Number(value)
        return isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
    }

    function optionsWithCurrent(defaults, current) {
        var options = defaults.slice()
        var value = Number(current)
        if (isFinite(value) && options.indexOf(value) < 0)
            options.push(value)
        return options
    }

    function copySettings(source) {
        return {
            enabled: source.enabled,
            resetAware: source.resetAware,
            quotaCriticalPercent: source.quotaCriticalPercent,
            burnWarnings: source.burnWarnings,
            burnWarningRatio: source.burnWarningRatio,
            disabledNotifications: source.disabledNotifications.slice()
        }
    }

    function copyValue(key, value) {
        return key === "disabledNotifications" && Array.isArray(value) ? value.slice() : value
    }

    function sameValue(left, right) {
        return JSON.stringify(left) === JSON.stringify(right)
    }

    function hasPendingWrite(key) {
        if (root.activeWrite !== null && root.activeWrite.key === key)
            return true
        for (var i = 0; i < root.writeQueue.length; i++) {
            if (root.writeQueue[i].key === key)
                return true
        }
        return false
    }

    function mergeIncomingSettings() {
        var incoming = root.normalizeSettings(root.settings)
        var merged = root.copySettings(incoming)
        var nextOptimistic = ({})
        var keys = Object.keys(root.optimisticSettings)
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i]
            var desired = root.optimisticSettings[key]
            if (root.hasPendingWrite(key) || !root.sameValue(incoming[key], desired)) {
                merged[key] = root.copyValue(key, desired)
                nextOptimistic[key] = root.copyValue(key, desired)
            }
        }
        root.optimisticSettings = nextOptimistic
        root.notificationSettings = merged
    }

    function setSetting(key, configPath, value) {
        var fullPath = "notifications." + configPath
        var retrying = root.failedPaths.indexOf(fullPath) >= 0
        if (!retrying && root.sameValue(root.notificationSettings[key], value))
            return

        var nextSettings = root.copySettings(root.notificationSettings)
        nextSettings[key] = root.copyValue(key, value)
        root.notificationSettings = nextSettings

        var nextOptimistic = ({})
        var optimisticKeys = Object.keys(root.optimisticSettings)
        for (var i = 0; i < optimisticKeys.length; i++)
            nextOptimistic[optimisticKeys[i]] = root.copyValue(optimisticKeys[i], root.optimisticSettings[optimisticKeys[i]])
        nextOptimistic[key] = root.copyValue(key, value)
        root.optimisticSettings = nextOptimistic

        var nextQueue = root.writeQueue.slice()
        nextQueue.push({ key: key, path: fullPath, json: JSON.stringify(value) })
        root.writeQueue = nextQueue
        root.startNextWrite()
    }

    function setCategoryEnabled(category, enabled) {
        var disabled = root.notificationSettings.disabledNotifications.slice()
        var index = disabled.indexOf(category)
        if (enabled && index >= 0)
            disabled.splice(index, 1)
        else if (!enabled && index < 0)
            disabled.push(category)
        root.setSetting("disabledNotifications", "disabled", disabled)
    }

    function categoryEnabled(category) {
        return root.notificationSettings.disabledNotifications.indexOf(category) < 0
    }

    function numberIsEqual(left, right) {
        return Math.abs(Number(left) - Number(right)) < 0.000001
    }

    function startNextWrite() {
        if (writeProcess.running || root.activeWrite !== null || root.writeQueue.length === 0)
            return
        var nextWrite = root.writeQueue[0]
        root.activeWrite = nextWrite
        root.writeQueue = root.writeQueue.slice(1)
        writeProcess.running = true
    }

    function finishWrite(path, succeeded) {
        if (succeeded) {
            root.failedPaths = root.failedPaths.filter(item => item !== path)
            root.refreshRequested()
        } else if (root.failedPaths.indexOf(path) < 0) {
            var failures = root.failedPaths.slice()
            failures.push(path)
            root.failedPaths = failures
        }

        root.activeWrite = null
        root.startNextWrite()
    }

    function writeStatus() {
        if (root.failedPaths.length > 0)
            return "A notification setting could not be saved. Change that setting again to retry."
        if (root.isWriting)
            return "Saving settings to Tokitoki config…"
        return ""
    }

    Process {
        id: writeProcess

        command: [
            root.command,
            "config",
            "set",
            root.activeWrite !== null ? root.activeWrite.path : "notifications.enabled",
            root.activeWrite !== null ? root.activeWrite.json : "false"
        ]

        onExited: function(exitCode, exitStatus) {
            if (root.activeWrite !== null)
                root.finishWrite(root.activeWrite.path, exitCode === 0)
        }

        onRunningChanged: {
            if (!running && root.activeWrite !== null)
                root.finishWrite(root.activeWrite.path, false)
        }
    }

    Column {
        id: content

        width: root.width > 0 ? root.width : root.implicitWidth
        spacing: Theme.spacingS

        StyledText {
            width: parent.width
            text: "Preferences are stored in Tokitoki config and shared with the menubar app. The " + root.shellName + " widget does not send desktop notifications."
            color: Theme.surfaceVariantText
            font.pixelSize: Theme.fontSizeSmall + 1
            wrapMode: Text.WordWrap
        }

        SettingToggle {
            width: parent.width
            label: "Allow notifications"
            description: "Enable Tokitoki's quota, reset, and spend alerts."
            checked: root.notificationSettings.enabled
            onToggled: isChecked => root.setSetting("enabled", "enabled", isChecked)
        }

        SettingToggle {
            width: parent.width
            label: "Notify when an exhausted quota resets"
            description: "Alert when a provider reports usable capacity again."
            checked: root.notificationSettings.resetAware
            toggleEnabled: root.notificationSettings.enabled
            onToggled: isChecked => root.setSetting("resetAware", "resetAware", isChecked)
        }

        Column {
            width: parent.width
            spacing: Theme.spacingXS

            StyledText {
                width: parent.width
                text: "Critical quota threshold · percent remaining"
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeSmall + 1
                wrapMode: Text.WordWrap
            }

            Row {
                width: parent.width
                spacing: Theme.spacingXS

                Repeater {
                    model: root.criticalOptions

                    delegate: ChoiceChip {
                        required property var modelData

                        width: Math.max(0, (parent.width - Theme.spacingXS * (root.criticalOptions.length - 1)) / root.criticalOptions.length)
                        label: String(modelData) + "%"
                        selected: root.numberIsEqual(modelData, root.notificationSettings.quotaCriticalPercent)
                        enabled: root.notificationSettings.enabled
                        onActivated: root.setSetting("quotaCriticalPercent", "quotaCriticalPercent", Number(modelData))
                    }
                }
            }
        }

        Column {
            width: parent.width
            spacing: Theme.spacingXS

            StyledText {
                width: parent.width
                text: "Spend guard"
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.DemiBold
            }

            SettingToggle {
                width: parent.width
                label: "Warn when projected spend reaches the cap"
                description: "Use the month-end projection and configured monthly cap."
                checked: root.notificationSettings.burnWarnings
                toggleEnabled: root.notificationSettings.enabled
                onToggled: isChecked => root.setSetting("burnWarnings", "burnWarnings", isChecked)
            }

            StyledText {
                width: parent.width
                text: root.hasMonthlyCap
                    ? "A monthly spend cap is configured for the burn guard."
                    : "Add a monthly spend cap to use burn-rate warnings."
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
            }

            StyledText {
                width: parent.width
                text: "Warn at"
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeSmall + 1
            }

            Row {
                width: parent.width
                spacing: Theme.spacingXS

                Repeater {
                    model: root.burnRatioOptions

                    delegate: ChoiceChip {
                        required property var modelData

                        width: Math.max(0, (parent.width - Theme.spacingXS * (root.burnRatioOptions.length - 1)) / root.burnRatioOptions.length)
                        label: String(Math.round(Number(modelData) * 100)) + "%"
                        selected: root.numberIsEqual(modelData, root.notificationSettings.burnWarningRatio)
                        enabled: root.notificationSettings.enabled && root.notificationSettings.burnWarnings
                        onActivated: root.setSetting("burnWarningRatio", "burnWarningRatio", Number(modelData))
                    }
                }
            }
        }

        Column {
            width: parent.width
            spacing: Theme.spacingXS

            StyledText {
                width: parent.width
                text: "Alert categories"
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.DemiBold
            }

            Repeater {
                model: root.categories

                delegate: SettingToggle {
                    required property var modelData

                    width: parent.width
                    label: modelData.label
                    description: modelData.description
                    checked: root.categoryEnabled(modelData.id)
                    toggleEnabled: root.notificationSettings.enabled
                    onToggled: isChecked => root.setCategoryEnabled(modelData.id, isChecked)
                }
            }
        }

        StyledText {
            width: parent.width
            visible: root.writeStatus().length > 0
            text: root.writeStatus()
            color: root.failedPaths.length > 0 ? Theme.error : Theme.surfaceVariantText
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }
    }
}
