import QtQuick
import QtQuick.Layouts
import QtQml
import org.kde.plasma.components as PlasmaComponents
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    property var payload: ({})
    property string errorText: ""

    Plasmoid.preferredRepresentation: Plasmoid.fullRepresentation
    Layout.minimumWidth: 220
    Layout.minimumHeight: 72

    function accept(raw) {
        try {
            var next = JSON.parse(raw)
            if (next.schema !== 1 || next.app !== "tokitoki") {
                throw new Error("unsupported widget payload")
            }
            root.payload = next
            root.errorText = ""
        } catch (error) {
            root.errorText = String(error)
        }
    }

    function stat(name) {
        if (!root.payload.stats) return 0
        return Number(root.payload.stats[name] || 0)
    }

    function money(value) {
        return "$" + Number(value || 0).toFixed(2)
    }

    function summaryText() {
        if (root.errorText.length > 0) return "Tokitoki is unavailable"
        return money(root.stat("costUsd")) + " · " + root.stat("requests") + " requests"
    }

    function detailText() {
        if (root.errorText.length > 0) return "Start `tokitoki web` on localhost"
        return root.stat("tokens") + " tokens · " + root.stat("sessions") + " sessions · " +
            root.stat("cachePct") + "% cache"
    }

    function refresh() {
        var request = new XMLHttpRequest()
        request.onreadystatechange = function() {
            if (request.readyState !== XMLHttpRequest.DONE) return
            if (request.status < 200 || request.status >= 300) {
                root.errorText = "HTTP " + request.status
                return
            }
            root.accept(request.responseText)
        }
        request.open("GET", "http://127.0.0.1:7788/v1/status?last=day")
        request.send()
    }

    Component.onCompleted: root.refresh()

    Timer {
        interval: 30000
        running: true
        repeat: true
        onTriggered: root.refresh()
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 10
        spacing: 4

        PlasmaComponents.Label {
            text: "Tokitoki Usage"
            font.bold: true
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            text: root.summaryText()
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            text: root.detailText()
            wrapMode: Text.WordWrap
            opacity: 0.75
        }
    }
}
