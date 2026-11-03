import QtQuick
import qs.Common
import "TokitokiPalette.js" as Palette

Rectangle {
    id: root
    // Popout palette (menubar or shell theme), always passed by the parent.
    property var ui

    property bool alternate: false
    property bool showSurface: true
    property int rowHeight: 30
    property int verticalPadding: Theme.spacingXXS
    default property alias contentData: contentLayer.data

    width: parent ? parent.width : implicitWidth
    height: rowHeight
    implicitHeight: rowHeight
    radius: Theme.cornerRadius / 2
    color: showSurface
        ? Palette.alpha(root.ui.text, alternate ? 0.045 : 0.018)
        : "transparent"
    border.width: showSurface ? 1 : 0
    border.color: Palette.alpha(root.ui.cardBorder, alternate ? 0.18 : 0.10)
    clip: true

    Item {
        id: contentLayer

        anchors.fill: parent
        anchors.leftMargin: Theme.spacingS
        anchors.rightMargin: Theme.spacingS
        anchors.topMargin: root.verticalPadding
        anchors.bottomMargin: root.verticalPadding
    }
}
