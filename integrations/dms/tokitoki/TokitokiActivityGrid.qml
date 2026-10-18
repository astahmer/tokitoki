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
            return Math.max(0, safeNumber(cell.costUsd))
        if (root.payload && root.payload.metric === "requests")
            return Math.max(0, safeNumber(cell.requests))
        return Math.max(0, safeNumber(cell.tokens))
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
            if (cell && cell.day !== undefined)
                byDay[String(cell.day)] = cell
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
                var value = metricValue(dayCell)
                maxValue = Math.max(maxValue, value)
                week.push({
                    present: present,
                    value: value
                })
            }
            nextColumns.push(week)
        }
        root.columns = nextColumns
        root.maximum = maxValue
    }

    function cellSize(layout) {
        if (layout.columns <= 0 || layout.rows <= 0)
            return 0
        var byWidth = (layout.width - (layout.columns - 1) * layout.columnSpacing) / layout.columns
        var byHeight = (layout.height - (layout.rows - 1) * layout.rowSpacing) / layout.rows
        return Math.max(0, Math.floor(Math.min(byWidth, byHeight) * 2) / 2)
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

    TokitokiDayClock {
        onTodayKeyChanged: root.rebuild()
    }

    Column {
        anchors.fill: parent
        spacing: Theme.spacingS

        Row {
            id: grid

            readonly property int rowSpacing: 2
            readonly property real cell: root.cellSize({
                width: grid.width,
                height: grid.height,
                columns: root.columns.length,
                rows: 7,
                columnSpacing: grid.spacing,
                rowSpacing: grid.rowSpacing
            })

            width: parent.width
            height: 58
            spacing: Math.min(2, Math.max(0, (grid.width - 53) / 52))

            Repeater {
                model: root.columns

                delegate: Column {
                    spacing: grid.rowSpacing

                    Repeater {
                        model: modelData

                        delegate: Rectangle {
                            width: grid.cell
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
                id: lessLabel
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
                id: moreLabel
                text: "More"
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
            }

            StyledText {
                id: periodLabel
                width: Math.max(0, parent.width - lessLabel.width - moreLabel.width - 5 * 7 -
                    parent.spacing * 7)
                text: root.payload && root.payload.metric
                    ? "Last year · " + root.displayLabel(root.payload.metric)
                    : ""
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeMedium
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
            }
        }
    }
}
