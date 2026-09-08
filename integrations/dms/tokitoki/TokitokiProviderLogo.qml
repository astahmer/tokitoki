import QtQuick
import qs.Common
import qs.Widgets

Item {
    id: root

    property string provider: ""
    property int size: Theme.iconSizeSmall
    property bool showBackground: false
    property string fallbackIcon: "account_circle"
    property color fallbackColor: Theme.primary
    property color backgroundColor: Theme.withAlpha(Theme.primaryContainer, 0.9)

    readonly property url logoSource: {
        switch (provider) {
        case "codex":
        case "openai": return Qt.resolvedUrl("assets/provider-logos/codex.svg")
        case "claude-code":
        case "claude": return Qt.resolvedUrl("assets/provider-logos/claude-code.svg")
        case "cursor": return Qt.resolvedUrl("assets/provider-logos/cursor.svg")
        case "gemini-cli":
        case "gemini": return Qt.resolvedUrl("assets/provider-logos/gemini-cli.svg")
        case "copilot": return Qt.resolvedUrl("assets/provider-logos/copilot.svg")
        case "grok": return Qt.resolvedUrl("assets/provider-logos/grok.svg")
        case "opencode":
        case "opencode-go": return Qt.resolvedUrl("assets/provider-logos/opencode.svg")
        default: return ""
        }
    }

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

    DankIcon {
        anchors.centerIn: parent
        name: root.fallbackIcon
        size: root.showBackground ? Math.min(root.size, Theme.iconSize) : root.size
        color: root.fallbackColor
        visible: !logoImage.visible
    }
}
