import QtQuick
import qs.Common
import qs.DCommon.Widgets

Item {
    id: root
    // Popout palette (menubar or shell theme), always passed by the parent.
    property var ui

    property var slices: []
    property string centerLabel: ""
    property string centerUnit: ""
    property real innerRadiusRatio: 0.618
    property var formatValue: function(value) { return String(value) }
    // Name of the emphasized slice; set by pointer hover here or by a legend row.
    property string highlightName: ""
    readonly property var highlightedSlice: root.sliceNamed(root.highlightName)

    implicitWidth: 116
    implicitHeight: 116

    function positiveTotal(slices) {
        var total = 0
        for (var i = 0; i < slices.length; i++) {
            var value = slices[i] ? Number(slices[i].value || 0) : 0
            if (isFinite(value) && value > 0)
                total += value
        }
        return total
    }

    function sliceNamed(name) {
        if (!name || !Array.isArray(root.slices))
            return null
        for (var i = 0; i < root.slices.length; i++) {
            if (root.slices[i] && root.slices[i].name === name)
                return root.slices[i]
        }
        return null
    }

    // Slice under a point, matching the paint order: clockwise from 12 o'clock.
    function sliceAt(point) {
        var slices = Array.isArray(point.slices) ? point.slices : []
        var total = positiveTotal(slices)
        var dx = point.x - point.width / 2
        var dy = point.y - point.height / 2
        var distance = Math.sqrt(dx * dx + dy * dy)
        var radius = Math.min(point.width, point.height) / 2
        if (total <= 0 || distance > radius || distance < radius * point.innerRadiusRatio * 0.9)
            return null
        var angle = Math.atan2(dy, dx) + Math.PI / 2
        if (angle < 0)
            angle += Math.PI * 2
        var start = 0
        for (var i = 0; i < slices.length; i++) {
            var value = slices[i] ? Number(slices[i].value || 0) : 0
            if (!isFinite(value) || value <= 0)
                continue
            start += value / total * Math.PI * 2
            if (angle < start)
                return slices[i]
        }
        return null
    }

    function percentText(slice) {
        var total = positiveTotal(Array.isArray(root.slices) ? root.slices : [])
        var share = total > 0 ? Number(slice.value || 0) / total * 100 : 0
        return (share >= 10 || share === 0 ? Math.round(share) : share.toFixed(1)) + "%"
    }

    Canvas {
        id: canvas

        anchors.fill: parent

        function repaint() {
            requestPaint()
        }

        onPaint: {
            var context = getContext("2d")
            context.clearRect(0, 0, width, height)

            if (!Array.isArray(root.slices))
                return

            var total = root.positiveTotal(root.slices)
            var positiveSlices = root.slices.filter(function(slice) {
                var value = slice ? Number(slice.value || 0) : 0
                return isFinite(value) && value > 0
            }).length
            if (total <= 0)
                return

            var radius = Math.min(width, height) / 2 - 3
            if (radius <= 0)
                return
            var inner = radius * root.innerRadiusRatio
            var centerX = width / 2
            var centerY = height / 2
            var start = -Math.PI / 2
            var gap = positiveSlices > 1 ? Math.min(0.018, Math.PI / Math.max(1, radius)) : 0
            var focused = root.highlightedSlice !== null

            for (var j = 0; j < root.slices.length; j++) {
                var slice = root.slices[j]
                var sliceValue = slice ? Number(slice.value || 0) : 0
                if (!isFinite(sliceValue) || sliceValue <= 0)
                    continue

                var angle = (sliceValue / total) * Math.PI * 2
                var end = start + angle
                var sliceGap = Math.min(gap, angle / 4)
                var from = start + sliceGap
                var to = end - sliceGap
                var emphasized = focused && slice.name === root.highlightName
                if (to > from) {
                    context.beginPath()
                    context.arc(centerX, centerY, emphasized ? radius + 3 : radius, from, to, false)
                    context.arc(centerX, centerY, inner, to, from, true)
                    context.closePath()
                    context.fillRule = Qt.OddEvenFill
                    context.globalAlpha = focused && !emphasized ? 0.35 : 1
                    context.fillStyle = String(slice.color || root.ui.accent)
                    context.fill()
                }
                start = end
            }
            context.globalAlpha = 1
        }

        Component.onCompleted: requestPaint()
        onWidthChanged: repaint()
        onHeightChanged: repaint()
    }

    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        onPositionChanged: mouse => {
            var slice = root.sliceAt({ x: mouse.x, y: mouse.y, width: width, height: height,
                slices: root.slices, innerRadiusRatio: root.innerRadiusRatio })
            root.highlightName = slice ? slice.name : ""
        }
        onExited: root.highlightName = ""
    }

    Column {
        anchors.centerIn: parent
        spacing: 0

        StyledText {
            width: root.width * 0.62
            text: root.highlightedSlice ? root.formatValue(root.highlightedSlice.value) : root.centerLabel
            color: root.ui.text
            font.pixelSize: Theme.fontSizeMedium
            font.weight: Font.DemiBold
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
            wrapMode: Text.NoWrap
            maximumLineCount: 1
            anchors.horizontalCenter: parent.horizontalCenter
        }

        StyledText {
            width: root.width * 0.62
            text: root.highlightedSlice ? root.highlightedSlice.name : root.centerUnit
            color: root.highlightedSlice ? root.highlightedSlice.color : root.ui.secondary
            font.pixelSize: Theme.fontSizeSmall + 1
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
            wrapMode: Text.NoWrap
            maximumLineCount: 1
            anchors.horizontalCenter: parent.horizontalCenter
            visible: text.length > 0
        }

        StyledText {
            text: root.highlightedSlice ? root.percentText(root.highlightedSlice) : ""
            color: root.ui.secondary
            font.pixelSize: Theme.fontSizeSmall
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.highlightedSlice !== null
        }
    }

    onSlicesChanged: canvas.repaint()
    onHighlightNameChanged: canvas.repaint()
}
