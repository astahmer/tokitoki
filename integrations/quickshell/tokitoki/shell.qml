import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Common
import qs.Widgets
import qs.Modules.Plugins

ShellRoot {
    id: root
    property bool dashboardVisible: false
    property string pendingTab: ""
    property var activeScreen: Quickshell.screens.length > 0 ? Quickshell.screens[0] : null
    readonly property var widget: widgetLoader.item
    function openDashboard(tab) {
        pendingTab = tab || "";
        if (widget && widget.tabOptions.indexOf(pendingTab) >= 0) {
            widget.selectedTab = pendingTab;
            widget.configOpen = false;
            pendingTab = "";
        }
        dashboardVisible = true;
    }
    function closeDashboard() {
        dashboardVisible = false;
    }
    StandaloneService {
        id: service
    }
    Loader {
        id: widgetLoader
        active: service.ready
        Component.onCompleted: setSource("file://" + Quickshell.shellPath("../../dms/tokitoki/TokitokiWidget.qml"), {
            shellName: "Quickshell",
            settingsLocation: "the ⋮ menu",
            pluginService: service,
            parentScreen: Qt.binding(() => root.activeScreen),
            popoutWidth: Qt.binding(() => Math.max(0, Math.min(520, (root.activeScreen ? root.activeScreen.width : 528) - 8))),
            popoutHeight: Qt.binding(() => {
                const screenHeight = root.activeScreen ? root.activeScreen.height : 1000;
                return Math.max(8, Math.min(860, Math.max(620, screenHeight * 0.82), screenHeight - 44));
            })
        })
        onLoaded: Qt.callLater(function () {
            if (root.pendingTab.length > 0)
                root.openDashboard(root.pendingTab);
        })
    }
    IpcHandler {
        target: "tokitoki"
        function open(tab: string): void {
            root.openDashboard(tab);
        }
        function close(): void {
            root.closeDashboard();
        }
        function toggle(): void {
            root.dashboardVisible = !root.dashboardVisible;
        }
        function status(): string {
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
    }
    Variants {
        model: Quickshell.screens
        PanelWindow {
            id: bar
            required property var modelData
            screen: modelData
            anchors {
                top: true
                left: true
                right: true
            }
            implicitHeight: 44
            color: Theme.surfaceContainer
            WlrLayershell.namespace: "tokitoki-bar"
            Button {
                id: barButton
                x: 4
                height: 36
                anchors.verticalCenter: parent.verticalCenter
                width: Math.max(80, pill.implicitWidth + 24)
                focusPolicy: Qt.StrongFocus
                Accessible.name: "Open Tokitoki usage"
                onClicked: {
                    const alreadyOpenHere = root.dashboardVisible && root.activeScreen === bar.screen;
                    root.activeScreen = bar.screen;
                    root.dashboardVisible = !alreadyOpenHere;
                }
                contentItem: Item {
                    Loader {
                        id: pill
                        anchors.centerIn: parent
                        sourceComponent: root.widget ? root.widget.horizontalBarPill : null
                    }
                }
                background: Rectangle {
                    radius: 10
                    color: barButton.hovered ? Theme.primaryContainer : Theme.surfaceContainerHigh
                }
            }
            StyledText {
                anchors.left: barButton.right
                anchors.leftMargin: 12
                anchors.verticalCenter: parent.verticalCenter
                visible: service.errorText.length > 0
                text: service.errorText
                color: Theme.error
                font.pixelSize: 12
            }
        }
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
                x: 4
                y: 48
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
