import QtQuick
import qs.Common
import qs.Widgets

Item {
    id: root

    property var history: null
    property var extendedHistory: null
    property string period: "month"
    property var columns: []

    implicitHeight: Math.max(154, chartColumn.implicitHeight)

    function safeNumber(value) {
        var number = Number(value)
        return isFinite(number) ? number : 0
    }

    function displayLabel(value) {
        var text = String(value || "")
        if (text.length === 0)
            return text
        return text.charAt(0).toUpperCase() + text.slice(1)
    }

    function paletteColor(name, index) {
        var colors = [
            Theme.warning,
            Theme.success,
            Theme.primary,
            Theme.secondary,
            Theme.error,
            Theme.tertiary,
            Theme.info
        ]
        if (index !== undefined && index >= 0)
            return colors[index % colors.length]

        var hash = 0
        var text = String(name || "")
        for (var i = 0; i < text.length; i++)
            hash = ((hash << 5) - hash) + text.charCodeAt(i)
        return colors[Math.abs(hash) % colors.length]
    }

    function dateKey(date) {
        function pad(value) {
            return value < 10 ? "0" + value : String(value)
        }
        return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    }

    function sourceForPeriod() {
        if (root.period === "year") {
            if (root.extendedHistory && Array.isArray(root.extendedHistory.days) &&
                    Array.isArray(root.extendedHistory.series))
                return root.extendedHistory
            return null
        }
        return root.history
    }

    function seriesForPeriod() {
        var source = root.sourceForPeriod()
        return source && Array.isArray(source.series) ? source.series : []
    }

    function buildColumns() {
        var source = root.sourceForPeriod()
        if (!source || !Array.isArray(source.days) || !Array.isArray(source.series))
            return []

        var daysToShow = 30
        if (root.period === "day")
            daysToShow = 1
        else if (root.period === "week")
            daysToShow = 7
        else if (root.period === "year")
            daysToShow = 365

        var bucketDays = root.period === "year" ? 7 : 1
        var endDate = new Date()
        endDate.setHours(0, 0, 0, 0)
        var firstDate = new Date(endDate)
        firstDate.setDate(firstDate.getDate() - daysToShow + 1)
        if (root.period === "year")
            firstDate.setDate(firstDate.getDate() - ((firstDate.getDay() + 6) % 7))

        var dayKeys = []
        var dayCount = root.period === "year" ? 53 * 7 : daysToShow
        for (var dayIndex = 0; dayIndex < dayCount; dayIndex++) {
            var date = new Date(firstDate)
            date.setDate(firstDate.getDate() + dayIndex)
            dayKeys.push(dateKey(date))
        }

        var seriesMaps = []
        for (var seriesIndex = 0; seriesIndex < source.series.length; seriesIndex++) {
            var series = source.series[seriesIndex]
            var values = Array.isArray(series.values) ? series.values : []
            var valuesByDay = ({})
            for (var sourceDayIndex = 0; sourceDayIndex < source.days.length; sourceDayIndex++)
                valuesByDay[String(source.days[sourceDayIndex])] = safeNumber(values[sourceDayIndex])
            seriesMaps.push(valuesByDay)
        }

        var rawColumns = []
        var maximum = 0
        var lastVisibleDay = dateKey(endDate)
        for (var bucketStart = 0; bucketStart < dayKeys.length; bucketStart += bucketDays) {
            var columnValues = []
            var columnTotal = 0
            for (var columnSeriesIndex = 0; columnSeriesIndex < seriesMaps.length; columnSeriesIndex++) {
                var columnValue = 0
                for (var bucketOffset = 0; bucketOffset < bucketDays &&
                        bucketStart + bucketOffset < dayKeys.length; bucketOffset++) {
                    var day = dayKeys[bucketStart + bucketOffset]
                    if (root.period !== "year" || day <= lastVisibleDay)
                        columnValue += safeNumber(seriesMaps[columnSeriesIndex][day])
                }
                columnValues.push(columnValue)
                columnTotal += columnValue
            }
            maximum = Math.max(maximum, columnTotal)
            var endDayIndex = Math.min(bucketStart + bucketDays - 1, dayKeys.length - 1)
            var endDay = dayKeys[endDayIndex]
            if (endDay > lastVisibleDay)
                endDay = lastVisibleDay
            rawColumns.push({ day: dayKeys[bucketStart], endDay: endDay, values: columnValues })
        }

        return rawColumns.map(function(column) {
            var segments = []
            for (var columnSeriesIndex = 0; columnSeriesIndex < source.series.length; columnSeriesIndex++) {
                var value = safeNumber(column.values[columnSeriesIndex])
                if (value > 0 && maximum > 0) {
                    segments.push({
                        fraction: value / maximum,
                        color: paletteColor(source.series[columnSeriesIndex].bucket, columnSeriesIndex),
                        name: source.series[columnSeriesIndex].bucket
                    })
                }
            }
            return {
                day: column.day,
                endDay: column.endDay,
                segments: segments
            }
        })
    }

    function rebuild() {
        root.columns = buildColumns()
    }

    onHistoryChanged: rebuild()
    onExtendedHistoryChanged: rebuild()
    onPeriodChanged: rebuild()
    Component.onCompleted: rebuild()

    Column {
        id: chartColumn
        anchors.fill: parent
        spacing: Theme.spacingXS

        Item {
            id: barArea

            width: parent.width
            height: 94

            Row {
                id: bars

                anchors.fill: parent
                spacing: 2

                Repeater {
                    model: root.columns.length

                    delegate: Item {
                        width: root.columns.length > 0
                            ? (bars.width - Math.max(0, root.columns.length - 1) * bars.spacing) / root.columns.length
                            : 0
                        height: bars.height

                        property var columnData: root.columns[index] || ({})

                        Column {
                            anchors.bottom: parent.bottom
                            width: parent.width
                            spacing: 0

                            Repeater {
                                model: columnData.segments || []

                                delegate: Rectangle {
                                    width: parent.width
                                    height: Math.max(1, barArea.height * Number(modelData.fraction || 0))
                                    color: modelData.color
                                }
                            }
                        }
                    }
                }
            }
        }

        Row {
            width: parent.width

            StyledText {
                id: firstLabel
                text: root.columns.length > 0 ? root.columns[0].day : ""
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
                isMonospace: true
            }

            Item {
                width: Math.max(0, parent.width - firstLabel.width - lastLabel.width)
                height: 1
            }

            StyledText {
                id: lastLabel
                text: root.columns.length > 0
                    ? root.columns[root.columns.length - 1].endDay
                    : ""
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
                isMonospace: true
                horizontalAlignment: Text.AlignRight
            }
        }

        Flow {
            width: parent.width
            spacing: Theme.spacingM

            Repeater {
                model: root.seriesForPeriod().slice(0, 6)

                delegate: Row {
                    spacing: Theme.spacingXXS

                    Rectangle {
                        width: 7
                        height: 7
                        radius: 3.5
                        color: root.paletteColor(modelData.bucket, index)
                        anchors.verticalCenter: parent.verticalCenter
                    }

                    StyledText {
                        text: root.displayLabel(modelData.bucket)
                        width: Math.min(100, implicitWidth)
                        color: Theme.surfaceVariantText
                        font.pixelSize: Theme.fontSizeMedium
                        elide: Text.ElideRight
                    }
                }
            }
        }
    }

}
