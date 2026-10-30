import QtQuick
import qs.Common
import qs.DCommon.Widgets

Rectangle {
    id: root

    property string title: ""
    property string iconName: ""
    property Component contentComponent: null
    property bool highlighted: false
    // Popout palette (TokitokiWidget.ui); null keeps the shell theme.
    property var ui: null

    width: parent ? parent.width : implicitWidth
    implicitHeight: cardColumn.implicitHeight + Theme.spacingM * 2
    height: visible ? implicitHeight : 0
    radius: Theme.cornerRadius
    color: ui ? (highlighted ? ui.highlight : ui.card)
        : highlighted ? Theme.withAlpha(Theme.primaryContainer, 0.72) : Theme.withAlpha(Theme.surfaceContainerHigh, 0.78)
    border.width: 1
    border.color: ui ? (highlighted ? ui.highlightBorder : ui.cardBorder)
        : highlighted ? Theme.primary : Theme.outlineLight
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

            DIcon {
                name: root.iconName
                size: Theme.iconSizeSmall
                color: root.ui ? root.ui.cardIcon : Theme.primary
                visible: root.iconName.length > 0
                anchors.verticalCenter: parent.verticalCenter
            }

            StyledText {
                text: root.title
                width: Math.max(0, parent.width - (root.iconName.length > 0 ? Theme.iconSizeSmall + parent.spacing : 0))
                elide: Text.ElideRight
                color: root.ui ? root.ui.text : root.highlighted ? Theme.primary : Theme.surfaceText
                font.pixelSize: root.ui ? Theme.fontSizeMedium : Theme.fontSizeLarge
                font.weight: Font.DemiBold
                anchors.verticalCenter: parent.verticalCenter
            }
        }

        Loader {
            id: contentLoader

            width: parent.width
            sourceComponent: root.contentComponent
        }
    }
}
