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
    property bool orderSaving: false
    property var accountOrderOverride: null
    readonly property var orderedDocument: Object.assign({}, limits, {accountOrder: accountOrderOverride || limits.accountOrder || []})
    property bool showHidden: false
    readonly property var accounts: Model.accounts(orderedDocument, Plasmoid.configuration.accounts, Plasmoid.configuration.hideIdentities, payload.uiPreview, "cards")
    readonly property var barAccounts: Model.accounts(orderedDocument, Plasmoid.configuration.accounts, Plasmoid.configuration.hideIdentities, payload.uiPreview, "bar")
    readonly property var hiddenAccounts: Model.accounts(orderedDocument, Plasmoid.configuration.accounts, Plasmoid.configuration.hideIdentities, payload.uiPreview, "all").filter(function(a) { return Model.globallyHidden(a, payload.uiPreview) })
    readonly property var stats: payload.stats || ({})
    readonly property string barText: Model.bar(barAccounts, Plasmoid.configuration.displayMode, stats, now)
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
                        if (accountOrderOverride && JSON.stringify(accountOrderOverride) === JSON.stringify(nextLimits.accountOrder || []))
                            accountOrderOverride = null
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
    function moveAccount(id, direction, bar) {
        if (orderSaving) return
        var order = Model.moveOrder(bar ? Object.assign({}, orderedDocument, {accountOrder: (payload.uiPreview || {}).barAccountOrder || orderedDocument.accountOrder}) : orderedDocument, bar ? barAccounts : accounts, id, direction)
        if (!order) return
        orderSaving = true
        var finished = false
        function finish(message) {
            if (finished) return
            finished = true
            root.orderSaving = false
            if (message) root.errorText = message
        }
        var request = new XMLHttpRequest()
        request.onreadystatechange = function() {
            if (request.readyState !== XMLHttpRequest.DONE || finished) return
            if (request.status < 200 || request.status >= 300) { finish("Could not save account order · HTTP " + request.status); return }
            try {
                var response = JSON.parse(request.responseText)
                if (response.ok !== true) throw new Error("unsupported response")
                if (!bar) root.accountOrderOverride = order
                finish("")
                root.refresh()
            } catch (error) { finish("Could not save account order · unsupported response") }
        }
        request.open("POST", String(Plasmoid.configuration.endpoint).replace(/\/+$/, "") + (bar ? "/v1/ui/bar-account-order" : "/v1/ui/account-order"))
        request.setRequestHeader("Content-Type", "application/json")
        var seed = (((payload.uiPreview || {}).barAccountOrder) || orderedDocument.accountOrder || []).slice()
        ;(orderedDocument.accounts || []).forEach(function(a) { if (seed.indexOf(a.id) < 0) seed.push(a.id) })
        request.send(JSON.stringify(bar ? {ids: order} : {ids: order, barIds: seed}))
        timeoutFactory.createObject(root, {request: request, finishRequest: finish})
    }
    function setVisibility(id, preference) {
        if (orderSaving) return
        orderSaving = true
        var request = new XMLHttpRequest()
        var finished = false
        function finish(message) {
            if (finished) return
            finished = true
            root.orderSaving = false
            if (message) root.errorText = message
        }
        request.onreadystatechange = function() {
            if (request.readyState !== XMLHttpRequest.DONE || finished) return
            if (request.status < 200 || request.status >= 300) { finish("Could not save account visibility · HTTP " + request.status); return }
            finish("")
            root.refresh()
        }
        request.open("POST", String(Plasmoid.configuration.endpoint).replace(/\/+$/, "") + "/v1/ui/account-visibility")
        request.setRequestHeader("Content-Type", "application/json")
        request.send(JSON.stringify(Object.assign({id: id}, preference)))
        timeoutFactory.createObject(root, {request: request, finishRequest: finish})
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
                model: !root.errorText && (Plasmoid.configuration.displayMode === "shortest" || Plasmoid.configuration.displayMode === "quotas") ? root.barAccounts : []
                delegate: RowLayout {
                    required property var modelData
                    spacing: 6
                    Kirigami.Separator { Layout.preferredHeight: 18; Layout.preferredWidth: 1 }
                    Kirigami.Icon {
                        source: Model.logo(modelData) ? Qt.resolvedUrl("../images/" + Model.logo(modelData) + ".svg") : "view-statistics"
                        implicitWidth: 16; implicitHeight: 16
                    }
                    PC.Label { text: Model.accountBar(modelData, root.barAccounts, Plasmoid.configuration.displayMode, root.now) }
                }
            }
            PC.Label {
                text: root.errorText ? "Tokitoki ?" : root.barText
                visible: root.errorText || Plasmoid.configuration.displayMode === "total" || root.barAccounts.length === 0
            }
        }
        MouseArea { anchors.fill: parent; onClicked: root.expanded = !root.expanded }
    }
    // Popout palette: the neutral macOS-menubar look by default, or Plasma's colors.
    readonly property bool followPlasmaTheme: Plasmoid.configuration.appearance === "plasma"
    readonly property var ui: followPlasmaTheme ? ({
        window: Kirigami.Theme.backgroundColor,
        card: Qt.tint(Kirigami.Theme.backgroundColor, Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.05)),
        cardBorder: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.12),
        control: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.08),
        selected: Qt.rgba(Kirigami.Theme.highlightColor.r, Kirigami.Theme.highlightColor.g, Kirigami.Theme.highlightColor.b, 0.3),
        text: Kirigami.Theme.textColor,
        secondary: Kirigami.Theme.disabledTextColor,
        separator: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.12),
        track: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.15),
        green: Kirigami.Theme.positiveTextColor,
        amber: Kirigami.Theme.neutralTextColor,
        rose: Kirigami.Theme.negativeTextColor,
        neutral: Kirigami.Theme.highlightColor,
        mint: Kirigami.Theme.positiveTextColor,
        orange: Kirigami.Theme.neutralTextColor,
        badge: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.1)
    }) : ({
        window: "#1e1e1e", card: "#2a2a2a", cardBorder: "#333333", control: "#383838", selected: "#3e3e3e",
        text: "#ececec", secondary: "#8e8e8e", separator: "#333333", track: "#3a3a3a",
        green: "#29c778", amber: "#ff9e0a", rose: "#f04259", neutral: "#549ef5", mint: "#63d9d0", orange: "#ff9f0a",
        badge: "#3a3a3a"
    })
    property bool layoutMode: false
    property var collapsed: ({})
    readonly property string dashboardUrl: /:7788\/?$/.test(String(Plasmoid.configuration.endpoint)) ? String(Plasmoid.configuration.endpoint) : "http://127.0.0.1:7788/"

    component PaletteButton: Rectangle {
        id: button
        property string text
        property string iconName
        property bool highlighted: false
        signal clicked()
        implicitWidth: buttonRow.implicitWidth + 20
        implicitHeight: 28
        radius: 7
        color: highlighted ? root.ui.selected : buttonArea.containsMouse ? Qt.lighter(root.ui.control, 1.15) : root.ui.control
        border.width: 1
        border.color: root.ui.cardBorder
        opacity: enabled ? 1 : 0.5
        Accessible.role: Accessible.Button
        Accessible.name: text
        RowLayout {
            id: buttonRow
            anchors.centerIn: parent
            spacing: 6
            Kirigami.Icon { source: button.iconName; implicitWidth: 14; implicitHeight: 14; color: root.ui.text; isMask: true; visible: button.iconName.length > 0 }
            PC.Label { text: button.text; color: root.ui.text; font.pixelSize: 12 }
        }
        MouseArea { id: buttonArea; anchors.fill: parent; hoverEnabled: true; enabled: button.enabled; cursorShape: Qt.PointingHandCursor; onClicked: button.clicked() }
    }

    component IconButton: PC.ToolButton {
        display: PC.AbstractButton.IconOnly
        icon.color: root.ui.text
        implicitWidth: 26
        implicitHeight: 26
        Accessible.name: text
        PC.ToolTip.text: text
        PC.ToolTip.visible: hovered
    }

    function toggleCollapsed(id) {
        var next = Object.assign({}, collapsed)
        next[id] = !next[id]
        collapsed = next
    }

    fullRepresentation: Rectangle {
        Layout.minimumWidth: 340
        Layout.minimumHeight: 280
        Layout.preferredWidth: 480
        Layout.preferredHeight: 650
        color: root.ui.window
        radius: 10

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 12
            spacing: 10

            RowLayout {
                Layout.fillWidth: true
                PC.Label {
                    text: (root.payload.window ? root.payload.window.label : "Usage") + " · $" + Number(root.stats.costUsd || 0).toFixed(2) + " · " + Model.compact(root.stats.tokens) + " tokens"
                    color: root.ui.secondary
                    font.pixelSize: 12
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }
            }
            PC.Label { Layout.fillWidth: true; text: root.errorText; visible: text.length > 0; wrapMode: Text.Wrap; color: root.ui.rose }

            PC.ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentWidth: availableWidth
                ColumnLayout {
                    width: parent.width
                    spacing: 10
                    Repeater {
                        model: root.accounts
                        delegate: Rectangle {
                            id: card
                            required property var modelData
                            required property int index
                            readonly property bool folded: root.collapsed[modelData.id] === true
                            readonly property bool barHidden: ((root.payload.uiPreview || {}).barHiddenAccounts || []).indexOf(modelData.id) >= 0
                            readonly property var issue: Model.issue(modelData)
                            Layout.fillWidth: true
                            implicitHeight: cardColumn.implicitHeight + 24
                            radius: 10
                            color: root.ui.card
                            border.width: 1
                            border.color: root.ui.cardBorder

                            ColumnLayout {
                                id: cardColumn
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.top: parent.top
                                anchors.margins: 12
                                spacing: 10

                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: 8
                                    IconButton {
                                        text: card.folded ? "Expand account" : "Collapse account"
                                        icon.name: card.folded ? "arrow-right" : "arrow-down"
                                        implicitWidth: 20; implicitHeight: 20
                                        onClicked: root.toggleCollapsed(card.modelData.id)
                                    }
                                    Kirigami.Icon {
                                        source: Model.logo(card.modelData) ? Qt.resolvedUrl("../images/" + Model.logo(card.modelData) + ".svg") : "view-statistics"
                                        implicitWidth: 20; implicitHeight: 20
                                    }
                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 0
                                        PC.Label { text: card.modelData.name; color: root.ui.text; font.bold: true; font.pixelSize: 14; elide: Text.ElideRight; Layout.fillWidth: true }
                                        PC.Label {
                                            text: card.modelData.vendorName + (card.modelData.name !== card.modelData.accountKey && card.modelData.name !== card.modelData.vendorName ? " · " + card.modelData.accountKey : "")
                                            color: root.ui.secondary; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true
                                        }
                                    }
                                    IconButton {
                                        text: "Move account up"; icon.name: "go-up"; visible: root.layoutMode
                                        enabled: !root.orderSaving && card.index > 0
                                        onClicked: root.moveAccount(card.modelData.id, -1)
                                    }
                                    IconButton {
                                        text: "Move account down"; icon.name: "go-down"; visible: root.layoutMode
                                        enabled: !root.orderSaving && card.index < root.accounts.length - 1
                                        onClicked: root.moveAccount(card.modelData.id, 1)
                                    }
                                    IconButton {
                                        text: card.barHidden ? "Show on bar" : "Hide from bar"
                                        icon.name: card.barHidden ? "view-hidden" : "view-visible"
                                        visible: root.layoutMode; enabled: !root.orderSaving
                                        onClicked: root.setVisibility(card.modelData.id, {barHidden: !card.barHidden})
                                    }
                                    IconButton {
                                        text: "Hide everywhere"; icon.name: "edit-delete-remove"
                                        visible: root.layoutMode; enabled: !root.orderSaving
                                        onClicked: root.setVisibility(card.modelData.id, {hidden: true})
                                    }
                                    Rectangle {
                                        visible: Model.plan(card.modelData).length > 0
                                        implicitWidth: planLabel.implicitWidth + 14; implicitHeight: 20; radius: 6
                                        color: root.ui.badge
                                        PC.Label { id: planLabel; anchors.centerIn: parent; text: Model.plan(card.modelData); color: root.ui.text; font.pixelSize: 11 }
                                    }
                                }

                                RowLayout {
                                    visible: card.issue !== null && !card.folded
                                    Layout.fillWidth: true
                                    spacing: 6
                                    Kirigami.Icon { source: "dialog-warning"; implicitWidth: 14; implicitHeight: 14; color: root.ui.orange; isMask: true }
                                    PC.Label { text: card.issue ? card.issue.title : ""; color: root.ui.orange; font.pixelSize: 12; font.bold: true }
                                    PC.Label { text: card.issue ? card.issue.reason : ""; color: root.ui.secondary; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                                }

                                Repeater {
                                    model: card.folded ? [] : Model.windows(card.modelData, false, root.now)
                                    delegate: ColumnLayout {
                                        id: windowRow
                                        required property var modelData
                                        readonly property var remaining: Model.remaining(modelData, root.now)
                                        Layout.fillWidth: true
                                        spacing: 5
                                        RowLayout {
                                            Layout.fillWidth: true
                                            spacing: 6
                                            PC.Label { text: Model.title(modelData); color: root.ui.secondary; font.pixelSize: 13; Layout.fillWidth: true; elide: Text.ElideRight }
                                            PC.Label { text: Model.sourceText(modelData, root.now); color: root.ui.secondary; font.pixelSize: 12; visible: text.length > 0 }
                                            PC.Label { text: Model.valueText(modelData, root.now); color: root.ui[Model.tone(modelData, root.now)]; font.pixelSize: 13; font.bold: true }
                                        }
                                        Rectangle {
                                            visible: windowRow.remaining !== null
                                            Layout.fillWidth: true
                                            implicitHeight: 6; radius: 3
                                            color: root.ui.track
                                            Rectangle {
                                                width: parent.width * (windowRow.remaining || 0) / 100
                                                height: parent.height; radius: 3
                                                color: root.ui[Model.tone(windowRow.modelData, root.now)]
                                            }
                                        }
                                        PC.Label { text: Model.resetText(modelData, root.now); color: root.ui.secondary; font.pixelSize: 11; visible: text.length > 0 }
                                    }
                                }
                                PC.Label { text: "No provider quota"; visible: !card.folded && !(card.modelData.windows || []).length; color: root.ui.secondary; font.pixelSize: 12 }

                                RowLayout {
                                    visible: !card.folded && Model.banked(card.modelData, root.now).length > 0
                                    spacing: 6
                                    Kirigami.Icon { source: "view-refresh"; implicitWidth: 14; implicitHeight: 14; color: root.ui.mint; isMask: true }
                                    PC.Label { text: Model.banked(card.modelData, root.now); color: root.ui.mint; font.pixelSize: 12 }
                                }

                                ColumnLayout {
                                    visible: !card.folded && (card.modelData.budgetWindows || []).length > 0
                                    Layout.fillWidth: true
                                    spacing: 3
                                    Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: root.ui.separator }
                                    PC.Label { text: "Local usage / budget pace"; color: root.ui.secondary; font.pixelSize: 12; font.bold: true }
                                    Repeater {
                                        model: card.modelData.budgetWindows || []
                                        delegate: RowLayout {
                                            required property var modelData
                                            Layout.fillWidth: true
                                            PC.Label { text: Model.capitalize(modelData.label || modelData.kind || "Usage"); color: root.ui.secondary; font.pixelSize: 12; Layout.fillWidth: true }
                                            PC.Label { text: "$" + Number(modelData.costUsd || 0).toFixed(2) + " · " + Model.compact(modelData.tokens) + " tokens"; color: root.ui.text; font.pixelSize: 12 }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    PC.Label { text: "No selected accounts. Check the service and widget settings."; visible: root.accounts.length === 0; wrapMode: Text.Wrap; Layout.fillWidth: true; color: root.ui.secondary }

                    Rectangle {
                        visible: root.payload.t3codeActivity !== undefined && Number((root.payload.t3codeActivity || {}).requests || 0) > 0
                        Layout.fillWidth: true
                        implicitHeight: t3Column.implicitHeight + 24
                        radius: 10
                        color: root.ui.card
                        border.width: 1
                        border.color: root.ui.cardBorder
                        ColumnLayout {
                            id: t3Column
                            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 12
                            spacing: 3
                            PC.Label { text: "Via T3 Code"; color: root.ui.text; font.bold: true }
                            PC.Label { text: Number((root.payload.t3codeActivity || {}).requests || 0) + " requests · $" + Number((root.payload.t3codeActivity || {}).costUsd || 0).toFixed(2) + " observed / estimated"; color: root.ui.text; font.pixelSize: 12 }
                            PC.Label { text: "Activity only · excluded from usage totals"; color: root.ui.secondary; font.pixelSize: 11 }
                        }
                    }

                    ColumnLayout {
                        visible: root.layoutMode
                        Layout.fillWidth: true
                        spacing: 6
                        PaletteButton {
                            text: "Hidden quotas (" + root.hiddenAccounts.length + ")"
                            iconName: root.showHidden ? "arrow-down" : "arrow-right"
                            visible: root.hiddenAccounts.length > 0
                            onClicked: root.showHidden = !root.showHidden
                        }
                        Repeater {
                            model: root.showHidden ? root.hiddenAccounts : []
                            delegate: RowLayout {
                                required property var modelData
                                Layout.fillWidth: true
                                PC.Label { text: modelData.name; color: root.ui.text; Layout.fillWidth: true; elide: Text.ElideRight }
                                PaletteButton {
                                    text: ((root.payload.uiPreview || {}).menubarHidden || []).indexOf(modelData.harness) >= 0 ? "Restore all " + modelData.harness + " accounts" : "Restore"
                                    enabled: !root.orderSaving
                                    onClicked: root.setVisibility(modelData.id, {hidden: false})
                                }
                            }
                        }
                        PC.Label { text: "Bar order"; color: root.ui.secondary; font.bold: true; visible: root.barAccounts.length > 0 }
                        Repeater {
                            model: root.barAccounts
                            delegate: RowLayout {
                                required property var modelData
                                required property int index
                                Layout.fillWidth: true
                                PC.Label { text: modelData.name; color: root.ui.text; Layout.fillWidth: true; elide: Text.ElideRight }
                                IconButton { text: "Move bar account left"; icon.name: "go-previous"; enabled: !root.orderSaving && index > 0; onClicked: root.moveAccount(modelData.id, -1, true) }
                                IconButton { text: "Move bar account right"; icon.name: "go-next"; enabled: !root.orderSaving && index < root.barAccounts.length - 1; onClicked: root.moveAccount(modelData.id, 1, true) }
                            }
                        }
                    }
                }
            }

            Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: root.ui.separator }
            RowLayout {
                Layout.fillWidth: true
                spacing: 6
                PaletteButton { text: root.refreshing ? "Refreshing…" : "Refresh"; iconName: "view-refresh"; enabled: !root.refreshing; onClicked: root.refresh() }
                Item { Layout.fillWidth: true }
                PaletteButton { text: "Layout"; iconName: "view-grid"; highlighted: root.layoutMode; onClicked: root.layoutMode = !root.layoutMode }
                PaletteButton { text: "Settings"; iconName: "configure"; onClicked: root.Plasmoid.internalAction("configure").trigger() }
                PaletteButton { text: "Open"; iconName: "internet-web-browser"; onClicked: Qt.openUrlExternally(root.dashboardUrl) }
            }
        }
    }
}
