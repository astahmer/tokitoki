import QtQuick
import QtQuick.Controls
import "Common"

Button {
    id: barButton
    property var controller: null
    required property var screen
    implicitHeight: 36
    implicitWidth: Math.max(80, pill.implicitWidth + 24)
    focusPolicy: Qt.StrongFocus
    Accessible.name: "Open Tokitoki usage"
    onClicked: {
        if (controller)
            controller.toggle(screen);
    }
    HoverHandler {
        cursorShape: Qt.PointingHandCursor
    }
    contentItem: Item {
        Loader {
            id: pill
            anchors.centerIn: parent
            sourceComponent: barButton.controller && barButton.controller.widget ? barButton.controller.widget.horizontalBarPill : null
        }
    }
    background: Rectangle {
        radius: 10
        color: barButton.hovered ? Theme.primaryContainer : Theme.surfaceContainerHigh
    }
}
