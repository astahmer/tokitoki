import QtQuick
import Quickshell
import Quickshell.Io

Scope {
    id: root
    property var settings: ({})
    property var state: ({})
    property bool directoriesReady: false
    property bool configLoaded: false
    property bool stateLoaded: false
    property bool configWritable: false
    property bool stateWritable: false
    readonly property bool ready: directoriesReady && configLoaded && stateLoaded
    property string configError: ""
    property string stateError: ""
    property string directoryError: ""
    readonly property string errorText: [directoryError, configError, stateError].filter(value => value.length > 0).join(" · ")
    readonly property string configDirectory: (Quickshell.env("XDG_CONFIG_HOME") || Quickshell.env("HOME") + "/.config") + "/tokitoki"
    readonly property string stateDirectory: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/tokitoki"
    readonly property string configPath: configDirectory + "/quickshell.json"
    readonly property string statePath: stateDirectory + "/quickshell-state.json"
    signal pluginDataChanged(string changedPluginId)

    function loadPluginData(pluginId, key, fallback) {
        return settings[key] === undefined ? fallback : settings[key];
    }
    function loadPluginState(pluginId, key, fallback) {
        return state[key] === undefined ? fallback : state[key];
    }
    function savePluginData(pluginId, key, value) {
        if (!ready || !configWritable || settings[key] === value)
            return;
        const next = Object.assign({}, settings);
        next[key] = value;
        settings = next;
        configSave.restart();
        pluginDataChanged(pluginId);
    }
    function savePluginState(pluginId, key, value) {
        if (!ready || !stateWritable || state[key] === value)
            return;
        const next = Object.assign({}, state);
        next[key] = value;
        state = next;
        stateSave.restart();
    }
    function parseFile(file, isConfig) {
        try {
            const value = JSON.parse(file.text());
            if (!value || Array.isArray(value) || typeof value !== "object")
                throw new Error("expected a JSON object");
            if (isConfig) {
                settings = value;
                configWritable = true;
                configError = "";
            } else {
                state = value;
                stateWritable = true;
                stateError = "";
            }
        } catch (error) {
            if (isConfig)
                configError = "Invalid Quickshell settings; original file preserved: " + String(error);
            else
                stateError = "Invalid Quickshell state; original file preserved: " + String(error);
        }
        if (isConfig)
            configLoaded = true;
        else
            stateLoaded = true;
    }
    function loadFailed(error, isConfig) {
        const missing = error === FileViewError.FileNotFound;
        if (isConfig) {
            configWritable = missing;
            configLoaded = true;
            if (!missing)
                configError = "Could not read Quickshell settings (" + error + "); original file preserved";
        } else {
            stateWritable = missing;
            stateLoaded = true;
            if (!missing)
                stateError = "Could not read Quickshell state (" + error + "); original file preserved";
        }
    }
    Process {
        command: ["mkdir", "-p", root.configDirectory, root.stateDirectory]
        running: true
        onExited: function (exitCode) {
            if (exitCode !== 0) {
                root.directoryError = "Could not create Quickshell persistence directories";
                return;
            }
            root.directoriesReady = true;
        }
    }
    FileView {
        id: configFile
        path: root.directoriesReady ? root.configPath : ""
        onLoaded: root.parseFile(configFile, true)
        onLoadFailed: error => root.loadFailed(error, true)
        onSaveFailed: error => root.configError = "Could not save Quickshell settings (" + error + ")"
    }
    FileView {
        id: stateFile
        path: root.directoriesReady ? root.statePath : ""
        onLoaded: root.parseFile(stateFile, false)
        onLoadFailed: error => root.loadFailed(error, false)
        onSaveFailed: error => root.stateError = "Could not save Quickshell state (" + error + ")"
    }
    Timer {
        id: configSave
        interval: 100
        onTriggered: configFile.setText(JSON.stringify(root.settings, null, 2) + "\n")
    }
    Timer {
        id: stateSave
        interval: 100
        onTriggered: stateFile.setText(JSON.stringify(root.state, null, 2) + "\n")
    }
}
