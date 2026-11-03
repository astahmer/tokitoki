.pragma library

// Menubar palette entries are hex strings; Qt.lighter(value, 1) normalizes
// them (and shell theme colors) to a color before applying the opacity.
function alpha(value, opacity) {
    var color = Qt.lighter(value, 1)
    return Qt.rgba(color.r, color.g, color.b, opacity)
}
