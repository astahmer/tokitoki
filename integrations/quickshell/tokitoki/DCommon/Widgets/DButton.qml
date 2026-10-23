import QtQuick
import QtQuick.Controls
import "../../Common"

Button {
    id: root
    property string iconName: ""
    property int buttonHeight: 36
    horizontalPadding: 12
    implicitHeight: buttonHeight
    implicitWidth: label.implicitWidth + horizontalPadding * 2
    padding: horizontalPadding
    focusPolicy: Qt.StrongFocus
    HoverHandler {
        cursorShape: Qt.PointingHandCursor
    }
    contentItem: Row {
        id: label
        spacing: 6
        DIcon {
            visible: root.iconName.length > 0
            name: root.iconName
            size: 18
            color: Theme.primary
            anchors.verticalCenter: parent.verticalCenter
        }
        StyledText {
            text: root.text
            anchors.verticalCenter: parent.verticalCenter
        }
    }
    background: Rectangle {
        radius: 8
        color: root.down ? Theme.primaryContainer : root.hovered ? Theme.surfaceContainerHigh : Theme.surfaceContainer
        border.color: root.activeFocus ? Theme.primary : Theme.outlineLight
        border.width: 1
        opacity: root.enabled ? 1 : 0.5
    }
}
