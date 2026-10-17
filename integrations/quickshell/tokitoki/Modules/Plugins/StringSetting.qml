import QtQuick
import QtQuick.Controls
import qs.Common
import qs.Widgets

Setting {
    id: root
    property string placeholder: ""
    defaultValue: ""
    StyledText {
        text: root.label
        font.pixelSize: 14
    }
    StyledText {
        width: parent.width
        text: root.description
        visible: text.length > 0
        color: Theme.surfaceVariantText
        font.pixelSize: 12
        wrapMode: Text.WordWrap
    }
    TextField {
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeMedium
        width: parent.width
        text: String(root.value ?? "")
        placeholderText: root.placeholder
        color: Theme.surfaceText
        selectionColor: Theme.primaryContainer
        Accessible.name: root.label
        onEditingFinished: root.commit(text)
        background: Rectangle {
            color: Theme.surfaceContainerHigh
            radius: 6
            border.color: parent.activeFocus ? Theme.primary : Theme.outlineLight
            border.width: 1
        }
    }
}
