import QtQuick
import QtQuick.Controls

Flickable {
    id: root
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    WheelHandler {
        target: null
        acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
        onWheel: event => {
            const delta = event.pixelDelta.y || event.angleDelta.y / 120 * 48;
            root.contentY = Math.max(0, Math.min(Math.max(0, root.contentHeight - root.height), root.contentY - delta));
            event.accepted = true;
        }
    }
    ScrollBar.vertical: ScrollBar {
        policy: ScrollBar.AsNeeded
    }
}
