import QtQuick

TokitokiBarButton {
    id: root
    property real popupX: 4
    property real popupY: 48
    Component {
        id: ownController
        TokitokiController {
            activeScreen: root.screen
            popupX: root.popupX
            popupY: root.popupY
        }
    }
    Component.onCompleted: {
        if (!controller)
            controller = ownController.createObject(root);
    }
}
