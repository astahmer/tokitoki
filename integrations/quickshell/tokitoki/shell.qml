import QtQuick
import Quickshell
import Quickshell.Io

Scope {
    id: root

    property var payload: ({})
    property string errorText: ""

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

    Variants {
        model: Quickshell.screens

        PanelWindow {
            required property var modelData

            screen: modelData
            color: "transparent"
            implicitHeight: 30
            anchors {
                top: true
                left: true
                right: true
            }

            Rectangle {
                anchors.centerIn: parent
                implicitWidth: label.implicitWidth + 20
                implicitHeight: label.implicitHeight + 8
                radius: 8
                color: "#303030"

                Text {
                    id: label
                    anchors.centerIn: parent
                    color: "#ffffff"
                    text: root.errorText.length > 0
                        ? "tokitoki ?"
                        : root.money(root.stat("costUsd")) + " · " + root.compactNumber(root.stat("tokens")) +
                          " · " + root.stat("requests") + " req"
                }
            }
        }
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
        onTriggered: statusProcess.running = true
    }
}
