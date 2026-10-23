import QtQuick
import QtQuick.Controls
import "../../Common"
import "../../DCommon/Widgets"

Setting {
    id: root
    required property var options
    defaultValue: ""
    StyledText {
        text: root.label
        font.pixelSize: 16
    }
    StyledText {
        width: parent.width
        text: root.description
        visible: text.length > 0
        color: Theme.surfaceVariantText
        font.pixelSize: 12
        wrapMode: Text.WordWrap
    }
    ComboBox {
        id: control
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeMedium
        width: parent.width
        model: root.options
        textRole: "label"
        valueRole: "value"
        currentIndex: {
            for (let i = 0; i < root.options.length; i++)
                if (String(root.options[i].value ?? root.options[i]) === String(root.value))
                    return i;
            return -1;
        }
        Accessible.name: root.label
        onActivated: root.commit(root.options[currentIndex].value ?? root.options[currentIndex])
        palette.button: Theme.surfaceContainerHigh
        palette.buttonText: Theme.surfaceText
        palette.text: Theme.surfaceText
        palette.window: Theme.surfaceContainer
        palette.highlight: Theme.primaryContainer
        palette.highlightedText: Theme.primary
    }
}
