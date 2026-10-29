pragma Singleton
import QtQuick

QtObject {
    readonly property string fontFamily: "DejaVu Sans"
    readonly property string monoFontFamily: "DejaVu Sans Mono"
    readonly property int spacingXXS: 2
    readonly property int spacingXS: 4
    readonly property int spacingS: 8
    readonly property int spacingM: 12
    readonly property int spacingXL: 24
    readonly property int fontSizeSmall: 12
    readonly property int fontSizeMedium: 14
    readonly property int fontSizeLarge: 16
    readonly property int fontSizeXLarge: 24
    readonly property int iconSize: 24
    readonly property int iconSizeSmall: 18
    readonly property int iconSizeLarge: 32
    readonly property int cornerRadius: 12
    readonly property color primary: "#ff8fa6"
    readonly property color primaryText: "#301019"
    readonly property color primaryContainer: "#512631"
    readonly property color surfaceText: "#f4e7ec"
    readonly property color surfaceVariantText: "#c6b6bd"
    readonly property color surfaceContainer: "#211d23"
    readonly property color surfaceContainerHigh: "#2d272e"
    readonly property color outlineLight: "#4a3c44"
    readonly property color widgetIconColor: primary
    readonly property color widgetTextColor: surfaceText
    readonly property color error: "#ff8b90"
    readonly property color warning: "#e8bc72"
    readonly property color success: "#92d3a6"
    readonly property color info: "#8ebde8"
    readonly property color secondary: "#c3a4df"
    readonly property color tertiary: "#7fd3cc"
    // Callers pass both color values and hex strings; Qt.darker(_, 1.0)
    // turns either into a color without changing it.
    function withAlpha(value, alpha) {
        const color = Qt.darker(value, 1.0);
        return Qt.rgba(color.r, color.g, color.b, alpha);
    }
    function barTextSize() {
        return 14;
    }
}
