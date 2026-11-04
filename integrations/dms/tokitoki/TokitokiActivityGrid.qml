import QtQuick
import qs.Common
import qs.DCommon.Widgets
import "TokitokiPalette.js" as Palette

Item {
    id: root
    // Popout palette (menubar or shell theme), always passed by the parent.
    property var ui

    property var payload: null
    property var columns: []
    property real maximum: 0
    property var formatValue: function(value) { return String(value) }
    property var hoveredCell: null

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
                    day: dateKey(date),
                    present: present,
                    value: value
                })
            }
            nextColumns.push(week)
        }
        root.columns = nextColumns
        root.maximum = maxValue
    }

    // Grid position under the pointer; each gap belongs to the cell before it
    // so the readout does not flicker while the pointer crosses the grid.
    function cellAt(pointer) {
        var column = Math.floor(pointer.x / (pointer.cell + pointer.columnSpacing))
        var row = Math.floor(pointer.y / (pointer.cell + pointer.rowSpacing))
        if (column < 0 || row < 0 || column >= pointer.columns || row >= pointer.rows)
            return null
        return { column: column, row: row }
    }

    function cellText(cell) {
        var metric = root.payload && root.payload.metric ? root.payload.metric : "tokens"
        var value = metric === "cost" ? "$" + cell.value.toFixed(2) : root.formatValue(cell.value) + " " + metric
        return cell.day + " · " + value
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
            return Palette.alpha(root.ui.text, 0.035)
        if (root.maximum <= 0)
            return Palette.alpha(root.ui.accent, 0.16)
        return Palette.alpha(root.ui.accent, 0.16 + Math.min(0.76, cell.value / root.maximum * 0.76))
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
                            border.width: root.hoveredCell && root.hoveredCell.day === modelData.day ? 1 : 0
                            border.color: root.ui.text
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
                color: root.ui.secondary
                font.pixelSize: Theme.fontSizeMedium
            }

            Repeater {
                model: 5

                delegate: Rectangle {
                    width: 7
                    height: 7
                    radius: 1.5
                    color: Palette.alpha(root.ui.accent, 0.16 + index * 0.19)
                    anchors.verticalCenter: parent.verticalCenter
                }
            }

            StyledText {
                id: moreLabel
                text: "More"
                color: root.ui.secondary
                font.pixelSize: Theme.fontSizeMedium
            }

            StyledText {
                id: periodLabel
                width: Math.max(0, parent.width - lessLabel.width - moreLabel.width - 5 * 7 -
                    parent.spacing * 7)
                text: root.hoveredCell ? root.cellText(root.hoveredCell)
                    : root.payload && root.payload.metric
                        ? "Last year · " + root.displayLabel(root.payload.metric)
                        : ""
                color: root.hoveredCell ? root.ui.text : root.ui.secondary
                font.pixelSize: Theme.fontSizeMedium
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
            }
        }
    }

    // A sibling overlay: inside the Row or Column it would join their layout.
    MouseArea {
        x: grid.x
        y: grid.y
        width: grid.width
        height: grid.height
        hoverEnabled: true
        onPositionChanged: mouse => {
            var position = root.cellAt({ x: mouse.x, y: mouse.y, cell: grid.cell,
                columnSpacing: grid.spacing, rowSpacing: grid.rowSpacing,
                columns: root.columns.length, rows: 7 })
            var cell = position ? root.columns[position.column][position.row] : null
            root.hoveredCell = cell && cell.present ? cell : null
        }
        onExited: root.hoveredCell = null
    }
}
