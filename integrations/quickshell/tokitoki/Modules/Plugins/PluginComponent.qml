import QtQuick

Item {
    property string layerNamespacePlugin: "tokitoki"
    property string pluginId: "tokitoki"
    property var pluginService: null
    readonly property var pluginData: pluginService ? pluginService.settings : ({})
    property var parentScreen: null
    property real barThickness: 44
    property var barConfig: ({})
    property int iconSize: 20
    property Component horizontalBarPill: null
    property Component verticalBarPill: null
    property Component popoutContent: null
    property real popoutWidth: 520
    property real popoutHeight: 820
}
