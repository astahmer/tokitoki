import QtQuick
import qs.Common
import qs.DCommon.Widgets

Canvas {
    id: root

    property var history: null
    property color lineColor: Theme.primary
    property color textColor: Theme.surfaceText
    property var formatValue: function(value) { return String(value) }
    property int hoveredIndex: -1
    readonly property var samples: buildSamples(dayClock.todayKey)

    implicitHeight: 48

    function buildSamples(todayKey) {
        var totals = {}
        var source = history || ({})
        var days = Array.isArray(source.days) ? source.days : []
        var series = Array.isArray(source.series) ? source.series : []
        for (var i = 0; i < days.length; i++) {
            totals[days[i]] = series.reduce(function(sum, item) {
                var value = Number(item.values && item.values[i])
                return sum + (isFinite(value) ? Math.max(0, value) : 0)
            }, 0)
        }
        var values = []
        for (var index = 0; index < 30; index++)
            values.push(totals[sampleDay(todayKey, index, 30)] || 0)
        return values
    }

    // Day key for a sample: the last sample is today, each earlier one a day before.
    function sampleDay(todayKey, index, count) {
        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(todayKey || ""))
        var today = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date()
        var date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - index))
        return date.getFullYear() + "-" +
            String(date.getMonth() + 1).padStart(2, "0") + "-" +
            String(date.getDate()).padStart(2, "0")
    }

    function sampleAt(x, count) {
        if (count <= 0 || width <= 4)
            return -1
        return Math.max(0, Math.min(count - 1, Math.round((x - 2) / (width - 4) * Math.max(1, count - 1))))
    }

    TokitokiDayClock {
        id: dayClock
    }

    onSamplesChanged: requestPaint()
    onLineColorChanged: requestPaint()
    onHoveredIndexChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()

    onPaint: {
        var ctx = getContext("2d")
        ctx.clearRect(0, 0, width, height)
        if (width <= 4 || height <= 4 || samples.length === 0)
            return
        var maximum = Math.max.apply(null, samples.concat([1]))
        var chartWidth = width - 4
        var chartHeight = height - 4
        ctx.beginPath()
        for (var i = 0; i < samples.length; i++) {
            var x = 2 + i * chartWidth / Math.max(1, samples.length - 1)
            var y = 2 + chartHeight * (1 - samples[i] / maximum)
            if (i === 0)
                ctx.moveTo(x, y)
            else
                ctx.lineTo(x, y)
        }
        ctx.strokeStyle = lineColor
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.lineTo(width - 2, height - 2)
        ctx.lineTo(2, height - 2)
        ctx.closePath()
        ctx.fillStyle = Theme.withAlpha(lineColor, 0.12)
        ctx.fill()
        if (hoveredIndex >= 0 && hoveredIndex < samples.length) {
            var pointX = 2 + hoveredIndex * chartWidth / Math.max(1, samples.length - 1)
            var pointY = 2 + chartHeight * (1 - samples[hoveredIndex] / maximum)
            ctx.beginPath()
            ctx.moveTo(pointX, 2)
            ctx.lineTo(pointX, height - 2)
            ctx.strokeStyle = Theme.withAlpha(lineColor, 0.4)
            ctx.lineWidth = 1
            ctx.stroke()
            ctx.beginPath()
            ctx.arc(pointX, pointY, 3.5, 0, Math.PI * 2)
            ctx.fillStyle = lineColor
            ctx.fill()
        }
    }

    MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        onPositionChanged: mouse => root.hoveredIndex = root.sampleAt(mouse.x, root.samples.length)
        onExited: root.hoveredIndex = -1
    }

    StyledText {
        anchors.top: parent.top
        anchors.right: parent.right
        visible: root.hoveredIndex >= 0
        text: visible ? root.sampleDay(dayClock.todayKey, root.hoveredIndex, root.samples.length) + " · " +
            root.formatValue(root.samples[root.hoveredIndex]) + " tokens" : ""
        color: root.textColor
        font.pixelSize: Theme.fontSizeSmall
        font.weight: Font.DemiBold
    }
}
