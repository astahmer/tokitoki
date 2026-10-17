import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "Common"
import "Widgets"
import "Modules/Plugins"

ShellRoot {
    id: root
    readonly property alias controller: controller
    TokitokiController {
        id: controller
    }
    IpcHandler {
        target: "tokitoki"
        function open(tab: string): void {
            root.controller.openDashboard(tab);
        }
        function close(): void {
            root.controller.closeDashboard();
        }
        function toggle(): void {
            root.controller.toggle(root.controller.activeScreen);
        }
        function status(): string {
            return root.controller.status();
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
            color: Theme.surfaceContainer
            WlrLayershell.namespace: "tokitoki-bar"
            TokitokiBarButton {
                id: barButton
                x: 4
                anchors.verticalCenter: parent.verticalCenter
                controller: root.controller
                screen: bar.screen
            }
            StyledText {
                anchors.left: barButton.right
                anchors.leftMargin: 12
                anchors.verticalCenter: parent.verticalCenter
                visible: root.controller.errorText.length > 0
                text: root.controller.errorText
                color: Theme.error
                font.pixelSize: 12
            }
        }
    }
}
