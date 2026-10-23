import QtQuick
import "../../Common"
import "../../DCommon/Widgets"

Setting {
    id: root
    defaultValue: false
    Item {
        width: parent.width
        height: Math.max(labels.implicitHeight, toggle.implicitHeight)
        Column {
            id: labels
            width: parent.width - toggle.width - 12
            spacing: 4
            StyledText {
                width: parent.width
                text: root.label
                font.pixelSize: 16
                wrapMode: Text.WordWrap
            }
            StyledText {
                width: parent.width
                text: root.description
                visible: text.length > 0
                font.pixelSize: 12
                color: Theme.surfaceVariantText
                wrapMode: Text.WordWrap
            }
        }
        DToggle {
            id: toggle
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            checked: Boolean(root.value)
            Accessible.name: root.label
            onToggled: isChecked => root.commit(isChecked)
        }
    }
}
