import QtQuick
import qs.Common
import qs.Widgets

Item {
    id: root

    property var payload: null
    property var columns: []
    property real maximum: 0

    implicitHeight: 118

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

    function dateKey(date) {
        function pad(value) {
            return value < 10 ? "0" + value : String(value)
        }
        return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    }

    function metricValue(cell) {
        if (!cell)
            return 0
        if (root.payload && root.payload.metric === "cost")
            return safeNumber(cell.costUsd)
        if (root.payload && root.payload.metric === "requests")
            return safeNumber(cell.requests)
        return safeNumber(cell.tokens)
    }

    function rebuild() {
        var source = root.payload
        if (!source || !Array.isArray(source.cells)) {
            root.columns = []
            root.maximum = 0
            return
        }

        var byDay = ({})
        var maxValue = 0
        for (var i = 0; i < source.cells.length; i++) {
            var cell = source.cells[i]
            byDay[cell.day] = cell
            maxValue = Math.max(maxValue, metricValue(cell))
        }

        var today = new Date()
        today.setHours(0, 0, 0, 0)
        var start = new Date(today)
        start.setDate(start.getDate() - 364)
        var mondayOffset = (start.getDay() + 6) % 7
        start.setDate(start.getDate() - mondayOffset)

        var nextColumns = []
        for (var column = 0; column < 53; column++) {
            var week = []
            for (var row = 0; row < 7; row++) {
                var date = new Date(start)
                date.setDate(start.getDate() + column * 7 + row)
                var present = date <= today
                var dayCell = present ? byDay[dateKey(date)] : null
                week.push({
                    present: present,
                    value: metricValue(dayCell)
                })
            }
            nextColumns.push(week)
        }
        root.columns = nextColumns
        root.maximum = maxValue
    }

    function cellColor(cell) {
        if (!cell.present)
            return Theme.withAlpha(Theme.surfaceText, 0.035)
        if (root.maximum <= 0)
            return Theme.withAlpha(Theme.primary, 0.16)
        return Theme.withAlpha(Theme.primary, 0.16 + Math.min(0.76, cell.value / root.maximum * 0.76))
    }

    onPayloadChanged: rebuild()
    Component.onCompleted: rebuild()

    Column {
        anchors.fill: parent
        spacing: Theme.spacingS

        Row {
            id: grid

            width: parent.width
            height: 58
            spacing: 2

            Repeater {
                model: root.columns

                delegate: Column {
                    spacing: 2

                    Repeater {
                        model: modelData

                        delegate: Rectangle {
                            width: Math.max(4, (grid.width - 52 * grid.spacing) / 53)
                            height: width
                            radius: 1.5
                            color: root.cellColor(modelData)
                        }
                    }
                }
            }
        }

        Row {
            width: parent.width
            spacing: Theme.spacingXXS

            StyledText {
                text: "Less"
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
            }

            Repeater {
                model: 5

                delegate: Rectangle {
                    width: 7
                    height: 7
                    radius: 1.5
                    color: Theme.withAlpha(Theme.primary, 0.16 + index * 0.19)
                    anchors.verticalCenter: parent.verticalCenter
                }
            }

            StyledText {
                text: "More"
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
            }

            Item { width: Math.max(0, parent.width - implicitWidth) }

            StyledText {
                text: root.payload && root.payload.metric
                    ? "Last year · " + root.displayLabel(root.payload.metric)
                    : ""
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
            }
        }
    }
}
