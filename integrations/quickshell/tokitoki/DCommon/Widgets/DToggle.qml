import QtQuick
import QtQuick.Controls
import "../../Common"

Item {
    id: root
    property bool checked: false
    property string text: ""
    property string description: ""
    signal clicked
    signal toggled(bool checked)
    implicitWidth: text.length > 0 ? 280 : nativeToggle.implicitWidth
    implicitHeight: Math.max(labels.implicitHeight, nativeToggle.implicitHeight)
    Column {
        id: labels
        visible: root.text.length > 0
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        width: Math.max(0, parent.width - nativeToggle.width - 12)
        spacing: 4
        StyledText {
            text: root.text
            width: parent.width
            wrapMode: Text.WordWrap
        }
        StyledText {
            text: root.description
            visible: text.length > 0
            width: parent.width
            font.pixelSize: 12
            color: Theme.surfaceVariantText
            wrapMode: Text.WordWrap
        }
    }
    Switch {
        id: nativeToggle
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        checkable: false
        checked: root.checked
        focusPolicy: Qt.StrongFocus
        Accessible.name: root.Accessible.name || root.text || root.description
        onClicked: {
            root.clicked();
            root.toggled(!root.checked);
        }
        HoverHandler {
            cursorShape: Qt.PointingHandCursor
        }
        indicator: Rectangle {
            implicitWidth: 42
            implicitHeight: 24
            x: nativeToggle.leftPadding
            y: (nativeToggle.height - height) / 2
            radius: 12
            color: root.checked ? Theme.primary : Theme.outlineLight
            border.width: nativeToggle.activeFocus ? 2 : 0
            border.color: Theme.surfaceText
            Rectangle {
                width: 18
                height: 18
                radius: 9
                x: root.checked ? parent.width - width - 3 : 3
                y: 3
                color: root.checked ? Theme.primaryText : Theme.surfaceText
            }
        }
    }
}
