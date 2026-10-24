import QtQuick
import QtQuick.Layouts
import QtQml
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PC
import org.kde.plasma.plasmoid
import "QuotaModel.js" as Model

PlasmoidItem {
    id: root
    property var payload: ({})
    property var limits: ({})
    property string errorText: ""
    property double now: Date.now()
    property int generation: 0
    property bool refreshing: false
    readonly property var accounts: Model.accounts(limits, Plasmoid.configuration.accounts, Plasmoid.configuration.hideIdentities, payload.uiPreview)
    readonly property var stats: payload.stats || ({})
    readonly property string barText: Model.bar(accounts, Plasmoid.configuration.displayMode, stats, now)
    toolTipMainText: "Tokitoki"
    toolTipSubText: (errorText ? errorText + "\n" : "") + Model.tooltip(accounts, now)
    Plasmoid.icon: "view-statistics"

    function refresh() {
        // Generation guards discard callbacks from a previous endpoint/settings value.
        var token = ++generation
        var base = String(Plasmoid.configuration.endpoint).replace(/\/+$/, "")
        var pending = 2
        var nextStatus = null
        var nextLimits = null
        var errors = []
        refreshing = true
        function load(route, accept) {
            var request = new XMLHttpRequest()
            var finished = false
            function finish(message) {
                if (finished || token !== generation) return
                finished = true
                if (message) errors.push(message)
                if (--pending === 0) {
                    if (!errors.length) {
                        payload = nextStatus
                        limits = nextLimits
                    }
                    errorText = errors.join(" · ")
                    refreshing = false
                }
            }
            request.onreadystatechange = function() {
                if (request.readyState !== XMLHttpRequest.DONE) return
                if (request.status < 200 || request.status >= 300) { finish("Tokitoki unavailable · HTTP " + request.status); return }
                try { accept(JSON.parse(request.responseText)); finish("") }
                catch (error) { finish("Unsupported Tokitoki response") }
            }
            request.open("GET", base + route)
            request.send()
            // Qt's XMLHttpRequest has no browser-style timeout property.
            timeoutFactory.createObject(root, { request: request, finishRequest: finish })
        }
        load("/v1/status?last=day", function(value) {
            if (value.schema !== 1 || value.app !== "tokitoki") throw new Error("schema")
            nextStatus = value
        })
        load("/v1/limits", function(value) {
            if (value.version !== 1 || !Array.isArray(value.accounts)) throw new Error("schema")
            nextLimits = value
        })
    }
    Component {
        id: timeoutFactory
        Timer {
            property var request
            property var finishRequest
            interval: 10000
            running: true
            onTriggered: { finishRequest("Tokitoki request timed out"); request.abort(); destroy() }
        }
    }
    Component.onCompleted: refresh()
    Connections {
        target: Plasmoid.configuration
        function onEndpointChanged() { root.refresh() }
    }
    Timer { interval: 30000; running: true; repeat: true; onTriggered: root.refresh() }
    Timer { interval: 1000; running: true; repeat: true; onTriggered: root.now = Date.now() }

    compactRepresentation: Item {
        implicitWidth: compactRow.implicitWidth + 12
        implicitHeight: Kirigami.Units.iconSizes.smallMedium
        Layout.minimumWidth: implicitWidth
        Layout.preferredWidth: implicitWidth
        RowLayout {
            id: compactRow
            anchors.centerIn: parent
            spacing: 6
            Kirigami.Icon { source: "view-statistics"; implicitWidth: 18; implicitHeight: 18 }
            Repeater {
                model: !root.errorText && (Plasmoid.configuration.displayMode === "shortest" || Plasmoid.configuration.displayMode === "quotas") ? root.accounts : []
                delegate: RowLayout {
                    required property var modelData
                    spacing: 6
                    Kirigami.Separator { Layout.preferredHeight: 18; Layout.preferredWidth: 1 }
                    Kirigami.Icon {
                        source: Model.logo(modelData) ? Qt.resolvedUrl("../images/" + Model.logo(modelData) + ".svg") : "view-statistics"
                        implicitWidth: 16; implicitHeight: 16
                    }
                    PC.Label { text: Model.accountBar(modelData, root.accounts, Plasmoid.configuration.displayMode, root.now) }
                }
            }
            PC.Label {
                text: root.errorText ? "Tokitoki ?" : root.barText
                visible: root.errorText || Plasmoid.configuration.displayMode === "total" || root.accounts.length === 0
            }
        }
        MouseArea { anchors.fill: parent; onClicked: root.expanded = !root.expanded }
    }
    fullRepresentation: ColumnLayout {
        Layout.minimumWidth: 340
        Layout.minimumHeight: 280
        Layout.preferredWidth: 480
        Layout.preferredHeight: 650
        spacing: 12
        RowLayout {
            Layout.fillWidth: true
            Kirigami.Heading { text: "Tokitoki"; level: 2; Layout.fillWidth: true }
            PC.ToolButton { icon.name: "view-refresh"; text: "Refresh"; display: PC.AbstractButton.IconOnly; enabled: !root.refreshing; onClicked: root.refresh() }
            PC.ToolButton { icon.name: "configure"; text: "Settings"; display: PC.AbstractButton.IconOnly; onClicked: root.Plasmoid.internalAction("configure").trigger() }
        }
        PC.Label { Layout.fillWidth: true; text: root.errorText; visible: text.length > 0; wrapMode: Text.Wrap; color: Kirigami.Theme.negativeTextColor }
        PC.Label { text: (root.payload.window ? root.payload.window.label : "Usage") + " · $" + Number(root.stats.costUsd || 0).toFixed(2) + " · " + Model.compact(root.stats.tokens) + " tokens" }
        PC.ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentWidth: availableWidth
            ColumnLayout {
                width: parent.width
                spacing: 12
                Repeater {
                    model: root.accounts
                    delegate: Kirigami.AbstractCard {
                        required property var modelData
                        Layout.fillWidth: true
                        contentItem: ColumnLayout {
                            spacing: 8
                            PC.Label { text: modelData.vendorName + " · " + modelData.name; font.bold: true }
                            Repeater {
                                model: Model.windows(modelData, false, root.now)
                                delegate: ColumnLayout {
                                    required property var modelData
                                    Layout.fillWidth: true
                                    RowLayout {
                                        Layout.fillWidth: true
                                        PC.Label { text: Model.label(modelData); Layout.fillWidth: true }
                                        PC.Label { text: Model.value(modelData, root.now); font.bold: true }
                                        PC.Label { text: Model.countdown(modelData, root.now); opacity: 0.7 }
                                    }
                                    PC.ProgressBar {
                                        Layout.fillWidth: true
                                        from: 0; to: 100
                                        value: Model.remaining(modelData, root.now) || 0
                                        visible: Model.remaining(modelData, root.now) !== null && modelData.amountUsd === undefined
                                    }
                                    PC.Label { text: "Observed · " + (modelData.observedAt || "unknown"); opacity: 0.65; font.pixelSize: 11 }
                                }
                            }
                            PC.Label { text: "No provider quota"; visible: !(modelData.windows || []).length; opacity: 0.7 }
                            PC.Label { text: "Local usage / budget pace"; font.bold: true; visible: (modelData.budgetWindows || []).length > 0 }
                            Repeater {
                                model: modelData.budgetWindows || []
                                delegate: PC.Label {
                                    required property var modelData
                                    text: modelData.label + " · $" + Number(modelData.costUsd || 0).toFixed(2) + " · " + Model.compact(modelData.tokens) + " tokens"
                                    opacity: 0.7
                                }
                            }
                        }
                    }
                }
                PC.Label { text: "No selected accounts. Check the service and widget settings."; visible: root.accounts.length === 0; wrapMode: Text.Wrap; Layout.fillWidth: true }
                Kirigami.AbstractCard {
                    visible: root.payload.t3codeActivity !== undefined && Number((root.payload.t3codeActivity || {}).requests || 0) > 0
                    Layout.fillWidth: true
                    contentItem: ColumnLayout {
                        PC.Label { text: "Via T3 Code"; font.bold: true }
                        PC.Label { text: Number((root.payload.t3codeActivity || {}).requests || 0) + " requests · $" + Number((root.payload.t3codeActivity || {}).costUsd || 0).toFixed(2) + " observed / estimated" }
                        PC.Label { text: "Activity only · excluded from usage totals"; opacity: 0.7 }
                    }
                }
            }
        }
    }
}
