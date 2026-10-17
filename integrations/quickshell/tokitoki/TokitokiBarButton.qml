import QtQuick
import QtQuick.Controls
import "Common"

Button {
    id: barButton
    required property var controller
    required property var screen
    implicitHeight: 36
    implicitWidth: Math.max(80, pill.implicitWidth + 24)
    focusPolicy: Qt.StrongFocus
    Accessible.name: "Open Tokitoki usage"
    onClicked: controller.toggle(screen)
    contentItem: Item {
        Loader {
            id: pill
            anchors.centerIn: parent
            sourceComponent: controller.widget ? controller.widget.horizontalBarPill : null
        }
    }
    background: Rectangle {
        radius: 10
        color: barButton.hovered ? Theme.primaryContainer : Theme.surfaceContainerHigh
    }
}
