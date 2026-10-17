import QtQuick
import Quickshell
import Quickshell.Io
import "Tokitoki" as Tokitoki
import "Common"

ShellRoot {
    id: root
    Tokitoki.TokitokiController {
        id: usage
    }
    IpcHandler {
        target: "tokitoki"
        function open(tab: string): void {
            usage.openDashboard(tab);
        }
        function close(): void {
            usage.closeDashboard();
        }
        function toggle(): void {
            usage.toggle(usage.activeScreen);
        }
        function status(): string {
            return usage.status();
        }
    }
    Variants {
        model: Quickshell.screens
        PanelWindow {
            id: bar
            required property var modelData
            screen: modelData
            anchors {
                top: true
                left: true
                right: true
            }
            implicitHeight: 44
            color: Theme.hostColor
            Tokitoki.TokitokiWidget {
                x: 4
                anchors.verticalCenter: parent.verticalCenter
                screen: bar.screen
                controller: usage
            }
        }
    }
}
