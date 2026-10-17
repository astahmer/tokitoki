import QtQuick

TokitokiBarButton {
    id: root
    controller: TokitokiController {
        activeScreen: root.screen
        popupX: root.popupX
        popupY: root.popupY
    }
    property real popupX: 4
    property real popupY: 48
}
