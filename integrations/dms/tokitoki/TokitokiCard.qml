import QtQuick
import qs.Common
import qs.Widgets

Rectangle {
    id: root

    property string title: ""
    property string iconName: ""
    property Component contentComponent: null
    property bool highlighted: false

    width: parent ? parent.width : implicitWidth
    implicitHeight: cardColumn.implicitHeight + Theme.spacingM * 2
    height: visible ? implicitHeight : 0
    radius: Theme.cornerRadius
    color: highlighted
        ? Theme.withAlpha(Theme.primaryContainer, 0.72)
        : Theme.withAlpha(Theme.surfaceContainerHigh, 0.78)
    border.width: 1
    border.color: highlighted ? Theme.primary : Theme.outlineLight
    clip: true

    Column {
        id: cardColumn

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Theme.spacingM
        spacing: Theme.spacingS

        Row {
            width: parent.width
            height: 32
            spacing: Theme.spacingXS

            DankIcon {
                name: root.iconName
                size: Theme.iconSizeSmall
                color: Theme.primary
                visible: root.iconName.length > 0
                anchors.verticalCenter: parent.verticalCenter
            }

            StyledText {
                text: root.title
                color: root.highlighted ? Theme.primary : Theme.surfaceText
                font.pixelSize: Theme.fontSizeLarge
                font.weight: Font.DemiBold
                anchors.verticalCenter: parent.verticalCenter
            }
        }

        Loader {
            id: contentLoader

            width: parent.width
            height: item ? item.implicitHeight : 0
            sourceComponent: root.contentComponent
        }
    }
}
