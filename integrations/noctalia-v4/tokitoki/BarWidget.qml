import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Widgets

Item {
    id: root

    property var pluginApi: null
    property ShellScreen screen
    property string widgetId: ""
    property string section: ""
    property int sectionWidgetIndex: -1
    property int sectionWidgetsCount: 0
    property var payload: ({})
    property string errorText: ""

    readonly property string screenName: screen?.name ?? ""
    readonly property real capsuleHeight: Style.getCapsuleHeightForScreen(screenName)
    readonly property real barFontSize: Style.getBarFontSizeForScreen(screenName)

    implicitWidth: content.implicitWidth + Style.marginM * 2
    implicitHeight: capsuleHeight

    function refresh() {
        if (!statusProcess.running) statusProcess.running = true
    }

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

    function compactNumber(value) {
        var number = Number(value || 0)
        if (number >= 1000000) return (number / 1000000).toFixed(1) + "M"
        if (number >= 1000) return (number / 1000).toFixed(1) + "k"
        return Math.round(number).toString()
    }

    Rectangle {
        id: visualCapsule
        x: Style.pixelAlignCenter(parent.width, width)
        y: Style.pixelAlignCenter(parent.height, height)
        width: content.implicitWidth + Style.marginM * 2
        height: root.capsuleHeight
        color: mouseArea.containsMouse ? Color.mHover : Style.capsuleColor
        radius: Style.radiusL
        border.color: Style.capsuleBorderColor
        border.width: Style.capsuleBorderWidth

        RowLayout {
            id: content
            anchors.centerIn: parent
            spacing: Style.marginS

            NText {
                text: root.errorText.length > 0
                    ? "tokitoki ?"
                    : root.money(root.stat("costUsd")) + " · " + root.compactNumber(root.stat("tokens"))
                pointSize: root.barFontSize
                color: Color.mOnSurface
            }
        }
    }

    MouseArea {
        id: mouseArea
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.refresh()
    }

    Process {
        id: statusProcess
        command: ["tokitoki", "widget-payload", "--cached", "--json"]
        running: true

        stdout: StdioCollector {
            id: statusOutput
            onStreamFinished: root.accept(statusOutput.text)
        }
    }

    Timer {
        interval: 30000
        running: true
        repeat: true
        onTriggered: root.refresh()
    }
}
