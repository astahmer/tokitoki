import QtQuick
import qs.Common

Canvas {
    id: root

    property var history: null
    property color lineColor: Theme.primary
    readonly property var samples: buildSamples()

    implicitHeight: 48

    function buildSamples() {
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
        for (var offset = 29; offset >= 0; offset--) {
            var date = new Date()
            date.setDate(date.getDate() - offset)
            var key = date.getFullYear() + "-" +
                String(date.getMonth() + 1).padStart(2, "0") + "-" +
                String(date.getDate()).padStart(2, "0")
            values.push(totals[key] || 0)
        }
        return values
    }

    onSamplesChanged: requestPaint()
    onLineColorChanged: requestPaint()
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
    }
}
