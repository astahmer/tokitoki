import QtQuick
import "../../Common"

Column {
    id: root
    property string pluginId: "tokitoki"
    property var pluginService: null
    signal settingChanged
    spacing: Theme.spacingM
    height: implicitHeight
    function loadValue(key, fallback) {
        return pluginService ? pluginService.loadPluginData(pluginId, key, fallback) : fallback;
    }
    function saveValue(key, value) {
        if (pluginService) {
            pluginService.savePluginData(pluginId, key, value);
            settingChanged();
        }
    }
    function reloadChildren() {
        for (let i = 0; i < children.length; i++)
            if (typeof children[i].loadValue === "function")
                children[i].loadValue();
    }
    onPluginServiceChanged: Qt.callLater(reloadChildren)
    Connections {
        target: root.pluginService
        function onPluginDataChanged(pluginId) {
            if (pluginId === root.pluginId)
                root.reloadChildren();
        }
    }
}
