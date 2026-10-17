import QtQuick
import QtQuick.Controls
import qs.Common

Button {
    id: root
    property string iconName: ""
    property int iconSize: 20
    property color iconColor: Theme.surfaceText
    property int buttonSize: 32
    property string tooltipText: ""
    implicitWidth: buttonSize
    implicitHeight: buttonSize
    focusPolicy: Qt.StrongFocus
    Accessible.name: tooltipText || iconName
    ToolTip.visible: hovered && tooltipText.length > 0
    ToolTip.text: tooltipText
    contentItem: DankIcon {
        name: root.iconName
        size: root.iconSize
        color: root.iconColor
    }
    background: Rectangle {
        radius: width / 2
        color: root.down || root.hovered ? Theme.primaryContainer : "transparent"
        border.width: root.activeFocus ? 1 : 0
        border.color: Theme.primary
    }
}
