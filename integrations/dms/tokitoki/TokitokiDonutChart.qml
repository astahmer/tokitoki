import QtQuick
import qs.Common
import qs.Widgets

Item {
    id: root

    property var slices: []
    property string centerLabel: ""
    property string centerUnit: ""
    property real innerRadiusRatio: 0.618

    implicitWidth: 116
    implicitHeight: 116

    Canvas {
        id: canvas

        anchors.fill: parent

        function repaint() {
            requestPaint()
        }

        onPaint: {
            var context = getContext("2d")
            context.clearRect(0, 0, width, height)

            var total = 0
            for (var i = 0; i < root.slices.length; i++) {
                var value = Number(root.slices[i].value || 0)
                if (isFinite(value) && value > 0) {
                    total += value
                }
            }
            if (total <= 0)
                return

            var weightedTotal = 0
            for (var k = 0; k < root.slices.length; k++) {
                var weightedValue = Number(root.slices[k].value || 0)
                if (isFinite(weightedValue) && weightedValue > 0)
                    weightedTotal += Math.max(weightedValue / total, 0.025)
            }

            var radius = Math.min(width, height) / 2 - 3
            var inner = radius * root.innerRadiusRatio
            var centerX = width / 2
            var centerY = height / 2
            var start = -Math.PI / 2
            var gap = Math.min(0.018, Math.PI / Math.max(1, radius))

            for (var j = 0; j < root.slices.length; j++) {
                var slice = root.slices[j]
                var sliceValue = Number(slice.value || 0)
                if (!isFinite(sliceValue) || sliceValue <= 0)
                    continue

                var share = Math.max(sliceValue / total, 0.025) / weightedTotal
                var end = start + share * Math.PI * 2
                var from = start + gap
                var to = end - gap
                if (to > from) {
                    context.beginPath()
                    context.arc(centerX, centerY, radius, from, to, false)
                    context.arc(centerX, centerY, inner, to, from, true)
                    context.closePath()
                    context.fillStyle = String(slice.color || Theme.primary)
                    context.fill()
                }
                start = end
            }
        }

        Component.onCompleted: requestPaint()
        onWidthChanged: repaint()
        onHeightChanged: repaint()
    }

    Column {
        anchors.centerIn: parent
        spacing: 0

        StyledText {
            width: root.width * 0.62
            text: root.centerLabel
            color: Theme.surfaceText
            font.pixelSize: Theme.fontSizeMedium
            font.weight: Font.DemiBold
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
            anchors.horizontalCenter: parent.horizontalCenter
        }

        StyledText {
            width: root.width * 0.75
            text: root.centerUnit
            color: Theme.surfaceVariantText
            font.pixelSize: Theme.fontSizeSmall + 1
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
            anchors.horizontalCenter: parent.horizontalCenter
            visible: text.length > 0
        }
    }

    onSlicesChanged: canvas.repaint()
}
