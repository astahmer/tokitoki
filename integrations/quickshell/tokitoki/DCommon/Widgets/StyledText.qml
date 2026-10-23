import QtQuick
import "../../Common"

Text {
    property bool isMonospace: false
    color: Theme.surfaceText
    font.family: isMonospace ? Theme.monoFontFamily : Theme.fontFamily
    font.pixelSize: Theme.fontSizeMedium
}
