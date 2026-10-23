import QtQuick
import qs.Common
import qs.DCommon.Widgets

Item {
    id: root

    property string provider: ""
    // payload.providerRegistry: id -> { logo, icon, ... }
    property var registry: ({})
    property int size: Theme.iconSizeSmall
    property bool showBackground: false
    property string fallbackIcon: "account_circle"
    property color fallbackColor: Theme.primary
    property color backgroundColor: Theme.withAlpha(Theme.primaryContainer, 0.9)

    // Unknown ids try an asset named after the raw id; a missing file falls
    // through to the icon below.
    readonly property string logoKey: {
        var entry = registry && provider.length > 0 ? registry[provider] : null
        if (entry)
            return entry.logo || ""
        return provider
    }
    readonly property url logoSource: logoKey.length > 0
        ? Qt.resolvedUrl("assets/provider-logos/" + logoKey + ".svg")
        : ""

    width: showBackground ? 28 : size
    height: showBackground ? 28 : size
    implicitWidth: width
    implicitHeight: height

    Rectangle {
        anchors.fill: parent
        radius: 10
        color: root.backgroundColor
        visible: root.showBackground
    }

    Image {
        id: logoImage

        width: root.showBackground ? Math.round(root.size * 0.66) : root.size
        height: width
        anchors.centerIn: parent
        source: root.logoSource
        sourceSize.width: width * 2
        sourceSize.height: height * 2
        fillMode: Image.PreserveAspectFit
        smooth: true
        visible: status === Image.Ready
    }

    DIcon {
        anchors.centerIn: parent
        name: root.fallbackIcon
        size: root.showBackground ? Math.min(root.size, Theme.iconSize) : root.size
        color: root.fallbackColor
        visible: !logoImage.visible
    }
}
