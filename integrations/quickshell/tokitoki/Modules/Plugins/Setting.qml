import QtQuick
import "../../Common"

Column {
    id: root
    required property string settingKey
    required property string label
    property string description: ""
    property var defaultValue
    property var value: defaultValue
    property bool initialized: false
    width: parent ? parent.width : 0
    spacing: Theme.spacingXS
    function settingsOwner() {
        let ancestor = parent;
        while (ancestor) {
            if (typeof ancestor.loadValue === "function" && typeof ancestor.saveValue === "function")
                return ancestor;
            ancestor = ancestor.parent;
        }
        return null;
    }
    function loadValue() {
        const owner = settingsOwner();
        if (!owner || !owner.pluginService)
            return;
        initialized = false;
        value = owner.loadValue(settingKey, defaultValue);
        initialized = true;
    }
    function commit(next) {
        value = next;
        const owner = settingsOwner();
        if (initialized && owner)
            owner.saveValue(settingKey, next);
    }
    Component.onCompleted: Qt.callLater(loadValue)
}
