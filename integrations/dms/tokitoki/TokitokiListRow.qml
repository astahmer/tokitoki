import QtQuick
import qs.Common

Rectangle {
    id: root

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
        ? Theme.withAlpha(Theme.surfaceText, alternate ? 0.045 : 0.018)
        : "transparent"
    border.width: showSurface ? 1 : 0
    border.color: Theme.withAlpha(Theme.outlineLight, alternate ? 0.18 : 0.10)
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
