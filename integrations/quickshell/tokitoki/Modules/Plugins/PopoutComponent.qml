import QtQuick
import "../../Common"
import "../../Widgets"

Column {
    id: root
    property string headerText: ""
    property string detailsText: ""
    property bool showCloseButton: false
    property var closePopout: null
    property var parentPopout: null
    property alias headerActions: actions.sourceComponent
    readonly property int headerHeight: header.visible ? 40 : 0
    readonly property int detailsHeight: details.visible ? details.implicitHeight : 0
    Item {
        id: header
        width: parent.width
        height: 40
        visible: root.headerText.length > 0
        StyledText {
            anchors.left: parent.left
            anchors.leftMargin: 8
            anchors.verticalCenter: parent.verticalCenter
            text: root.headerText
            font.pixelSize: 20
            font.bold: true
        }
        Row {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: 4
            Loader {
                id: actions
            }
            DankActionButton {
                visible: root.showCloseButton
                iconName: "close"
                tooltipText: "Close Tokitoki"
                onClicked: {
                    if (root.closePopout)
                        root.closePopout();
                }
            }
        }
    }
    StyledText {
        id: details
        width: parent.width
        text: root.detailsText
        visible: text.length > 0
        wrapMode: Text.WordWrap
    }
}
