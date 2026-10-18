import QtQuick

Item {
    id: root

    property string todayKey: localDayKey(new Date())

    visible: false
    width: 0
    height: 0

    function localDayKey(date) {
        return date.getFullYear() + "-" +
            String(date.getMonth() + 1).padStart(2, "0") + "-" +
            String(date.getDate()).padStart(2, "0")
    }

    // Capped so a missed wakeup (suspend, DST) still catches the new day soon after.
    function nextCheckInterval(now) {
        var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
        return Math.max(1000, Math.min(600000, midnight.getTime() - now.getTime() + 1000))
    }

    function refresh() {
        var now = new Date()
        var key = localDayKey(now)
        if (key !== root.todayKey)
            root.todayKey = key
        dayTimer.interval = nextCheckInterval(now)
        dayTimer.restart()
    }

    Timer {
        id: dayTimer

        running: true
        repeat: false
        interval: root.nextCheckInterval(new Date())
        onTriggered: root.refresh()
    }
}
