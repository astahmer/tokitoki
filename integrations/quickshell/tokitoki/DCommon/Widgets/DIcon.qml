import QtQuick
import "../../Common"

Text {
    property string name: ""
    property int size: 24
    text: name
    font.family: symbols.name
    font.pixelSize: size
    color: Theme.surfaceText
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    width: size
    height: size
    FontLoader {
        id: symbols
        source: "../../assets/material-symbols-rounded.ttf"
    }
}
