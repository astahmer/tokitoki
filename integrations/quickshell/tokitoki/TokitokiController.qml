import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import "Common"
import "DCommon/Widgets"
import "Modules/Plugins"

Scope {
    id: root
    property real popupX: 4
    property real popupY: 48
    property bool dashboardVisible: false
    property string pendingTab: ""
    property var activeScreen: Quickshell.screens.length > 0 ? Quickshell.screens[0] : null
    readonly property string errorText: service.errorText
    readonly property var widget: widgetLoader.item
    function openDashboard(tab) {
        pendingTab = tab || "";
        if (widget) {
            if (widget.tabOptions.indexOf(pendingTab) >= 0) {
                widget.selectedTab = pendingTab;
                widget.configOpen = false;
            }
            pendingTab = "";
        }
        dashboardVisible = true;
    }
    function closeDashboard() {
        pendingTab = "";
        dashboardVisible = false;
    }
    StandaloneService {
        id: service
    }
    Loader {
        id: widgetLoader
        active: service.ready
        onStatusChanged: {
            if (status === Loader.Error)
                console.error("Tokitoki could not load " + source);
        }
        Component.onCompleted: setSource("file://" + Quickshell.shellPath("../../dms/tokitoki/TokitokiWidget.qml"), {
            shellName: "Quickshell",
            settingsLocation: "the ⋮ menu",
            pluginService: service,
            parentScreen: Qt.binding(() => root.activeScreen),
            popoutWidth: Qt.binding(() => Math.max(0, Math.min(520, (root.activeScreen ? root.activeScreen.width : 528) - 8))),
            popoutHeight: Qt.binding(() => {
                const screenHeight = root.activeScreen ? root.activeScreen.height : 1000;
                return Math.max(8, Math.min(860, Math.max(620, screenHeight * 0.82), screenHeight - root.popupY + 4));
            })
        })
        onLoaded: Qt.callLater(function () {
            if (root.pendingTab.length > 0)
                root.openDashboard(root.pendingTab);
        })
    }
    function toggle(screen) {
        const alreadyOpenHere = dashboardVisible && activeScreen === screen;
        activeScreen = screen;
        dashboardVisible = !alreadyOpenHere;
    }
    function status() {
        return JSON.stringify({
            selectedTab: root.widget ? root.widget.selectedTab : service.state.selectedTab || "overview",
            visible: root.dashboardVisible,
            configOpen: root.widget ? root.widget.configOpen : false,
            autoRefreshEnabled: root.widget ? root.widget.autoRefreshEnabled : service.settings.autoRefreshEnabled !== false,
            ready: service.ready,
            hasPayload: root.widget ? root.widget.hasPayload : false,
            isBusy: root.widget ? root.widget.isBusy : false,
            error: service.errorText,
            configPath: service.configPath,
            statePath: service.statePath,
            screen: root.activeScreen ? root.activeScreen.name : "",
            popupGeometry: {
                x: popup.x,
                y: popup.y,
                width: popup.width,
                height: popup.height
            }
        });
    }
    PanelWindow {
        id: dashboard
        visible: root.dashboardVisible
        screen: root.activeScreen
        anchors {
            top: true
            left: true
            right: true
            bottom: true
        }
        exclusionMode: ExclusionMode.Ignore
        color: "transparent"
        WlrLayershell.namespace: "tokitoki-dashboard"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: root.dashboardVisible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
        onVisibleChanged: {
            if (visible)
                Qt.callLater(() => dashboardFocus.forceActiveFocus());
        }
        onScreenChanged: {
            if (visible)
                Qt.callLater(() => dashboardFocus.forceActiveFocus());
        }
        Item {
            id: dashboardFocus
            anchors.fill: parent
            focus: true
            Keys.onEscapePressed: root.closeDashboard()
            MouseArea {
                anchors.fill: parent
                onClicked: root.closeDashboard()
            }
            Rectangle {
                id: popup
                x: root.popupX
                y: root.popupY
                width: root.widget ? root.widget.popoutWidth : 520
                height: root.widget ? root.widget.popoutHeight - 8 : 812
                radius: Theme.cornerRadius
                color: Theme.surfaceContainer
                border.width: 1
                border.color: Theme.outlineLight
                clip: true
                MouseArea {
                    anchors.fill: parent
                }
                Loader {
                    x: 8
                    y: 8
                    width: parent.width - 16
                    sourceComponent: root.widget ? root.widget.popoutContent : null
                    onLoaded: item.closePopout = root.closeDashboard
                }
            }
        }
    }
}
