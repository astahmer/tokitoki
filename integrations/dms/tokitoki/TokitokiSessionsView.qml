import QtQuick
import Quickshell
import Quickshell.Io
import qs.Common
import qs.Widgets

// Sessions tab: read-only browser over `tokitoki sessions --cached --json`.
// List mode is a keyword search + pagination; selecting a row swaps to the
// conversation body and the request timeline of that session.
Item {
    id: root

    property string command: "tokitoki"
    property string query: ""
    property bool privacyHideNames: false
    property bool privacyHideIdentities: false
    property bool active: true

    property var rows: []
    property bool hasMore: false
    property int page: 1
    property bool loading: false
    property bool reindexing: false
    property bool pendingSearch: false
    property int searchGeneration: 0
    property var activeSearchRequest: null
    property string processError: ""
    property string reindexSummary: ""
    property var activeDrillRequest: null
    property var pendingDrillRequest: null
    property int detailGeneration: 0
    property string detailProcessError: ""
    property string status: ""
    property var detail: null
    property var events: []
    property bool eventsLoading: false
    property int hoveredEvent: -1
    readonly property real maximumEventTokenCount: root.maximumEventTokens()

    implicitWidth: body.implicitWidth
    implicitHeight: body.implicitHeight

    component ActionChip: Rectangle {
        id: chip

        property string label: ""
        property string iconName: ""
        property bool actionEnabled: true

        signal clicked()
        enabled: actionEnabled
        activeFocusOnTab: true
        Accessible.role: Accessible.Button
        Accessible.name: label
        Keys.onSpacePressed: clicked()
        Keys.onReturnPressed: clicked()

        width: chipRow.implicitWidth + Theme.spacingM
        height: 26
        radius: Theme.cornerRadius / 2
        color: Theme.withAlpha(Theme.surfaceText, hoverArea.containsMouse && chip.actionEnabled ? 0.10 : 0.05)
        border.width: 1
        border.color: Theme.outlineLight
        opacity: chip.actionEnabled ? 1 : 0.45

        Row {
            id: chipRow

            anchors.centerIn: parent
            spacing: Theme.spacingXXS

            DankIcon {
                name: chip.iconName
                size: Theme.iconSizeSmall
                color: Theme.surfaceText
                visible: chip.iconName.length > 0
                anchors.verticalCenter: parent.verticalCenter
            }

            StyledText {
                text: chip.label
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeSmall + 1
                anchors.verticalCenter: parent.verticalCenter
            }
        }

        MouseArea {
            id: hoverArea

            anchors.fill: parent
            hoverEnabled: true
            cursorShape: chip.actionEnabled ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: {
                if (chip.actionEnabled)
                    chip.clicked()
            }
        }
    }

    function safeNumber(value) {
        if (value === null || typeof value === "undefined" || value === "")
            return 0
        var number = Number(value)
        return isFinite(number) ? number : 0
    }

    function timestampMillis(value) {
        if (value === null || typeof value === "undefined" || value === "")
            return null
        var numeric = Number(value)
        if (typeof value === "number" ||
                (typeof value === "string" && value.trim().length > 0 && isFinite(numeric))) {
            if (!isFinite(numeric))
                return null
            return Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric
        }
        var parsed = Date.parse(String(value))
        return isFinite(parsed) ? parsed : null
    }

    function timestampText(value) {
        var milliseconds = timestampMillis(value)
        if (milliseconds === null)
            return "unknown time"
        var date = new Date(milliseconds)
        if (!isFinite(date.getTime()))
            return "unknown time"
        return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
            String(date.getDate()).padStart(2, "0") + " " + String(date.getHours()).padStart(2, "0") + ":" +
            String(date.getMinutes()).padStart(2, "0")
    }

    function eventTime(value) {
        var milliseconds = timestampMillis(value)
        if (milliseconds === null)
            return "unknown time"
        var date = new Date(milliseconds)
        if (!isFinite(date.getTime()))
            return "unknown time"
        return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" +
            String(date.getSeconds()).padStart(2, "0")
    }

    function trimDecimal(text) {
        return String(text).replace(/\.0$/, "")
    }

    function compactNumber(value) {
        var number = safeNumber(value)
        var sign = number < 0 ? "-" : ""
        number = Math.abs(number)
        if (number >= 1000000000)
            return sign + trimDecimal((number / 1000000000).toFixed(1)) + "B"
        if (number >= 1000000)
            return sign + trimDecimal((number / 1000000).toFixed(1)) + "M"
        if (number >= 1000)
            return sign + trimDecimal((number / 1000).toFixed(1)) + "k"
        return sign + Math.round(number)
    }

    function formatMoney(value) {
        return "$" + safeNumber(value).toFixed(2)
    }

    function escapeMarkup(text) {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    }

    function highlight(raw) {
        var color = String(Theme.warning)
        return escapeMarkup(raw)
            .split("[[").join('<font color="' + color + '">')
            .split("]]").join("</font>")
    }

    function sessionTitle(row) {
        if (root.privacyHideNames)
            return "Private session"
        var title = String(row && row.title ? row.title : "").trim()
        return title.length > 0 ? title : "(no title)"
    }

    function snippetMarkup(row) {
        if (root.privacyHideNames)
            return "Hidden"
        var raw = String(row && row.snippet ? row.snippet : "")
        if (raw.length === 0)
            return "No indexed conversation text for this session."
        return highlight(raw)
    }

    function sessionMeta(row) {
        var account = root.privacyHideNames || root.privacyHideIdentities
            ? "account hidden"
            : (row && row.accountKey ? String(row.accountKey) : "default")
        return (row && row.provider ? row.provider : "provider") + " · " +
            account + " · " + timestampText(row ? row.startedAt : null)
    }

    function eventTokens(event) {
        return safeNumber(event.inputTokens) + safeNumber(event.outputTokens) +
            safeNumber(event.cacheReadTokens) + safeNumber(event.cacheWriteTokens)
    }

    function maximumEventTokens() {
        var maximum = 1
        for (var i = 0; i < root.events.length; i++)
            maximum = Math.max(maximum, root.eventTokens(root.events[i]))
        return maximum
    }

    function intervalText(seconds) {
        var value = safeNumber(seconds)
        if (!isFinite(value) || value <= 0)
            return "not enough evidence"
        var minutes = Math.max(1, Math.round(value / 60))
        if (minutes < 60)
            return minutes + "m"
        var hours = Math.max(1, Math.round(minutes / 60))
        if (hours < 48)
            return hours + "h"
        return Math.max(1, Math.round(hours / 24)) + "d"
    }

    function cacheDurationText(estimate) {
        if (!estimate || typeof estimate !== "object")
            return ""
        var confidence = String(estimate.confidence || "unknown")
        if (["low", "medium", "high"].indexOf(confidence) < 0)
            confidence = "unknown"
        var samples = Math.max(0, Math.round(safeNumber(estimate.samples)))
        var busts = Math.max(0, Math.round(safeNumber(estimate.busts)))
        return "Estimated cache lifetime ≈ " + intervalText(estimate.estimatedSeconds) +
            " · " + confidence + " confidence. Based on " + busts +
            " observed cache reset" + (busts === 1 ? "" : "s") + " across " +
            samples + " requests; an estimate, not a provider guarantee."
    }

    function conversationBody() {
        if (root.detail === null || !root.detail.conversation || root.privacyHideNames)
            return ""
        return String(root.detail.conversation.body || "")
    }

    function searchArgs(searchQuery, searchPage) {
        var query = searchQuery === undefined ? root.query.trim() : String(searchQuery).trim()
        var pageNumber = searchPage === undefined ? root.page : searchPage
        var args = [root.command, "sessions", "--cached", "--last", "month", "--top", "25",
            "--page", String(pageNumber), "--json"]
        if (query.length > 0)
            args.push("--search", query)
        return args
    }

    function drillArgs(request) {
        return [root.command, "sessions", "--cached",
            "--provider", request.provider,
            "--session", request.sessionId,
            "--events-limit", "40", "--events-offset", String(request.offset), "--json"]
    }

    function runSearch() {
        if (!root.active) {
            root.pendingSearch = true
            return
        }
        if (searchProcess.running) {
            root.pendingSearch = true
            return
        }

        var request = {
            kind: root.reindexing ? "reindex" : "search",
            generation: root.searchGeneration,
            query: root.query.trim(),
            page: root.page
        }
        request.command = request.kind === "reindex"
            ? [root.command, "reindex"]
            : root.searchArgs(request.query, request.page)
        root.activeSearchRequest = request
        root.pendingSearch = false
        root.processError = ""
        root.loading = true
        if (request.kind === "reindex")
            root.reindexSummary = ""
        if (root.detail === null)
            root.status = request.kind === "reindex" ? "Reindexing conversations…" : "Searching sessions…"
        searchProcess.running = true
    }

    function acceptSearch(raw, request) {
        if (!request || request.generation !== root.searchGeneration)
            return
        try {
            var data = JSON.parse(String(raw || ""))
            if (!data || !Array.isArray(data.rows))
                throw new Error("the command returned an invalid sessions payload")
            var found = data.rows
            root.rows = found
            root.hasMore = Boolean(data && data.hasMore)
            var responsePage = safeNumber(data.page)
            root.page = responsePage > 0 ? responsePage : request.page
            if (root.detail === null) {
                var summary = found.length === 0
                    ? "No sessions found"
                    : found.length + " sessions · page " + root.page
                root.status = root.reindexSummary.length > 0
                    ? root.reindexSummary + " · " + summary
                    : summary
            }
            root.reindexSummary = ""
        } catch (error) {
            if (root.detail === null)
                root.status = "Session search failed: " + error
        }
    }

    function openSession(row) {
        if (!row || !row.provider || !row.sessionId) {
            root.status = "Could not open this session: missing provider or session id"
            return
        }
        root.detailGeneration += 1
        root.detail = {
            provider: String(row.provider),
            sessionId: String(row.sessionId),
            conversation: null,
            cacheDuration: null,
            events: [],
            eventsTotal: 0,
            eventsOffset: 0,
            eventsHasMore: false
        }
        root.events = []
        root.hoveredEvent = -1
        root.status = "Loading conversation…"
        root.eventsLoading = false
        root.pendingDrillRequest = null
        root.requestDrill(0)
    }

    function requestDrill(offset) {
        if (root.detail === null)
            return
        var request = {
            generation: root.detailGeneration,
            provider: String(root.detail.provider),
            sessionId: String(root.detail.sessionId),
            offset: Math.max(0, Math.floor(safeNumber(offset)))
        }
        request.command = root.drillArgs(request)
        root.eventsLoading = true
        if (drillProcess.running) {
            root.pendingDrillRequest = request
            return
        }
        root.startDrill(request)
    }

    function startDrill(request) {
        root.activeDrillRequest = request
        root.detailProcessError = ""
        root.eventsLoading = true
        drillProcess.running = true
    }

    function acceptDetail(raw, request) {
        if (!request || request.generation !== root.detailGeneration || root.detail === null ||
                request.provider !== String(root.detail.provider) ||
                request.sessionId !== String(root.detail.sessionId))
            return
        try {
            var data = JSON.parse(String(raw || ""))
            if (!data || String(data.provider) !== request.provider ||
                    String(data.sessionId) !== request.sessionId)
                throw new Error("the command returned a different session")
            var incoming = Array.isArray(data.events) ? data.events : []
            var responseOffset = Math.max(0, Math.floor(safeNumber(data.eventsOffset)))
            if (responseOffset !== request.offset || (request.offset > 0 && request.offset !== root.events.length))
                throw new Error("the command returned an unexpected event page")
            root.events = request.offset > 0 ? root.events.concat(incoming) : incoming
            var eventsTotal = Math.max(0, Math.floor(safeNumber(data.eventsTotal)))
            var eventsHaveMore = typeof data.eventsHasMore === "boolean"
                ? data.eventsHasMore
                : request.offset + incoming.length < eventsTotal
            if (incoming.length === 0)
                eventsHaveMore = false
            root.detail = {
                provider: request.provider,
                sessionId: request.sessionId,
                conversation: data.conversation || null,
                cacheDuration: data.cacheDuration || null,
                events: root.events,
                eventsTotal: eventsTotal,
                eventsOffset: responseOffset,
                eventsHasMore: eventsHaveMore
            }
            root.status = data.conversation === null || typeof data.conversation === "undefined"
                ? "No conversation body indexed"
                : ""
        } catch (error) {
            root.status = "Could not load conversation: " + error
        }
    }

    function closeSession() {
        root.detailGeneration += 1
        root.detail = null
        root.events = []
        root.eventsLoading = false
        root.pendingDrillRequest = null
        root.status = ""
    }

    function loadMoreEvents() {
        if (drillProcess.running || root.eventsLoading || root.detail === null ||
                root.detail.eventsHasMore !== true)
            return
        root.requestDrill(root.events.length)
    }

    function failureText(label, exitCode, errorText) {
        if (root.privacyHideNames || root.privacyHideIdentities)
            return label + " (exit " + exitCode + ")"
        var message = String(errorText || "").trim()
        return message.length > 0
            ? label + ": " + message
            : label + " (exit " + exitCode + ")"
    }

    function statusText() {
        if (root.privacyHideNames &&
                (root.status.indexOf("failed") >= 0 || root.status.indexOf("Could not") === 0))
            return "Tokitoki request failed."
        return root.status
    }

    Process {
        id: searchProcess

        command: root.activeSearchRequest ? root.activeSearchRequest.command : []

        stdout: StdioCollector {
            id: searchOutput

            onStreamFinished: {
                if (root.activeSearchRequest && root.activeSearchRequest.kind === "search")
                    root.acceptSearch(searchOutput.text, root.activeSearchRequest)
            }
        }

        stderr: StdioCollector {
            id: searchErrorOutput

            onStreamFinished: root.processError = String(searchErrorOutput.text || "").trim()
        }

        onExited: function(exitCode, exitStatus) {
            var request = root.activeSearchRequest
            root.loading = false
            root.activeSearchRequest = null
            if (request && request.kind === "reindex") {
                root.reindexing = false
                if (exitCode === 0) {
                    var output = String(searchOutput.text || "").trim().split("\n")
                    root.reindexSummary = output.length > 0 && output[0].length > 0
                        ? output[0]
                        : "Reindex complete"
                    root.pendingSearch = true
                } else {
                    root.status = root.failureText("Reindex failed", exitCode, root.processError)
                    root.reindexSummary = root.status
                }
            } else if (exitCode !== 0 && request &&
                    request.generation === root.searchGeneration && root.detail === null) {
                root.status = root.failureText("Session search failed", exitCode, root.processError)
            }

            if (root.reindexing) {
                root.runSearch()
                return
            }

            var queryIsDebouncing = queryDebounce.running
            if (request && request.kind === "search" &&
                    request.generation !== root.searchGeneration && !queryIsDebouncing)
                root.pendingSearch = true

            if (root.pendingSearch) {
                root.pendingSearch = false
                root.runSearch()
            }
        }

        onRunningChanged: {
            if (running || root.activeSearchRequest === null)
                return
            var failedReindex = root.activeSearchRequest.kind === "reindex"
            root.activeSearchRequest = null
            root.loading = false
            root.reindexing = false
            root.pendingSearch = false
            root.status = (failedReindex ? "Reindex failed" : "Session search failed") +
                ": could not start " + root.command
        }
    }

    Process {
        id: drillProcess

        command: root.activeDrillRequest ? root.activeDrillRequest.command : []

        stdout: StdioCollector {
            id: drillOutput

            onStreamFinished: root.acceptDetail(drillOutput.text, root.activeDrillRequest)
        }

        stderr: StdioCollector {
            id: drillErrorOutput

            onStreamFinished: root.detailProcessError = String(drillErrorOutput.text || "").trim()
        }

        onExited: function(exitCode, exitStatus) {
            var request = root.activeDrillRequest
            root.activeDrillRequest = null
            if (request && request.generation === root.detailGeneration && root.detail !== null) {
                if (exitCode !== 0)
                    root.status = root.failureText("Could not load conversation", exitCode, root.detailProcessError)
                root.eventsLoading = false
            }
            if (root.pendingDrillRequest !== null) {
                var nextRequest = root.pendingDrillRequest
                root.pendingDrillRequest = null
                if (nextRequest.generation === root.detailGeneration && root.detail !== null)
                    root.startDrill(nextRequest)
            }
        }

        onRunningChanged: {
            if (running || root.activeDrillRequest === null)
                return
            root.activeDrillRequest = null
            root.pendingDrillRequest = null
            root.eventsLoading = false
            if (root.detail !== null)
                root.status = "Could not load conversation: could not start " + root.command
        }
    }

    Timer {
        id: queryDebounce

        interval: 350
        onTriggered: {
            if (root.page !== 1)
                root.page = 1
            root.runSearch()
        }
    }

    onQueryChanged: {
        root.searchGeneration += 1
        root.page = 1
        if (root.active)
            queryDebounce.restart()
        else
            root.pendingSearch = true
    }

    onActiveChanged: {
        if (root.active)
            root.runSearch()
    }
    Component.onCompleted: {
        if (root.active)
            root.runSearch()
    }

    Column {
        id: body

        width: root.width
        spacing: Theme.spacingXS

        StyledText {
            width: parent.width
            visible: text.length > 0
            text: root.statusText()
            color: root.status.indexOf("failed") >= 0 || root.status.indexOf("Could not") === 0
                ? Theme.error : Theme.surfaceVariantText
            font.pixelSize: Theme.fontSizeSmall + 1
            wrapMode: Text.WordWrap
            elide: Text.ElideNone
        }

        Row {
            width: parent.width
            spacing: Theme.spacingS
            visible: root.detail === null

            ActionChip {
                label: root.reindexing ? "Reindexing…" : "Reindex conversations"
                iconName: "refresh"
                actionEnabled: !root.reindexing
                onClicked: {
                    root.reindexing = true
                    root.searchGeneration += 1
                    root.page = 1
                    root.runSearch()
                }
            }
        }

        Column {
            width: parent.width
            spacing: Theme.spacingXXS
            visible: root.detail === null

            Repeater {
                model: root.rows

                delegate: Item {
                    id: sessionRow
                    activeFocusOnTab: true
                    Accessible.role: Accessible.Button
                    Accessible.name: root.sessionTitle(modelData)
                    Keys.onReturnPressed: root.openSession(modelData)
                    Keys.onSpacePressed: root.openSession(modelData)

                    width: body.width
                    height: 64

                    TokitokiListRow {
                        anchors.fill: parent
                        alternate: index % 2 === 1
                        rowHeight: 64

                        Column {
                            anchors.fill: parent
                            spacing: 1

                            Item {
                                width: parent.width
                                height: 18

                                StyledText {
                                    anchors.left: parent.left
                                    anchors.right: sessionValue.left
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: root.sessionTitle(modelData)
                                    color: Theme.surfaceText
                                    font.pixelSize: Theme.fontSizeMedium
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                }

                                StyledText {
                                    id: sessionValue

                                    anchors.right: parent.right
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: root.compactNumber(modelData.requests) + " req · " +
                                        root.compactNumber(modelData.totalTokens) + " tok"
                                    color: Theme.surfaceVariantText
                                    font.pixelSize: Theme.fontSizeSmall
                                    isMonospace: true
                                }
                            }

                            StyledText {
                                width: parent.width
                                height: 30
                                text: root.snippetMarkup(modelData)
                                textFormat: Text.StyledText
                                color: Theme.surfaceVariantText
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                                maximumLineCount: 2
                                elide: Text.ElideRight
                                clip: true
                            }

                            StyledText {
                                width: parent.width
                                text: root.sessionMeta(modelData)
                                color: Theme.withAlpha(Theme.surfaceVariantText, 0.75)
                                font.pixelSize: Theme.fontSizeSmall - 2
                                elide: Text.ElideRight
                            }
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.openSession(modelData)
                    }
                }
            }
        }

        Row {
            width: parent.width
            spacing: Theme.spacingS
            visible: root.detail === null && (root.page > 1 || root.hasMore)

            ActionChip {
                label: "Previous"
                iconName: "chevron_left"
                actionEnabled: root.page > 1 && !root.loading
                onClicked: {
                    root.page = root.page - 1
                    root.searchGeneration += 1
                    root.runSearch()
                }
            }

            StyledText {
                text: "Page " + root.page
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeSmall
                anchors.verticalCenter: parent.verticalCenter
            }

            ActionChip {
                label: "Next"
                iconName: "chevron_right"
                actionEnabled: root.hasMore && !root.loading
                onClicked: {
                    root.page = root.page + 1
                    root.searchGeneration += 1
                    root.runSearch()
                }
            }
        }

        Column {
            width: parent.width
            spacing: Theme.spacingS
            visible: root.detail !== null

            Row {
                width: parent.width
                spacing: Theme.spacingS

                ActionChip {
                    id: sessionBackAction

                    label: "Sessions"
                    iconName: "arrow_back"
                    onClicked: root.closeSession()
                }

                StyledText {
                    width: Math.max(0, parent.width - parent.spacing - sessionBackAction.width)
                    anchors.verticalCenter: parent.verticalCenter
                    text: (root.detail ? String(root.detail.provider) : "") + " · " +
                        (root.privacyHideNames ? "Private session" : (root.detail ? String(root.detail.sessionId) : ""))
                    color: Theme.surfaceVariantText
                    font.pixelSize: Theme.fontSizeSmall
                    isMonospace: true
                    elide: Text.ElideMiddle
                }
            }

            StyledText {
                width: parent.width
                visible: root.detail !== null && root.detail.cacheDuration !== null &&
                    typeof root.detail.cacheDuration === "object"
                text: root.detail === null ? "" : root.cacheDurationText(root.detail.cacheDuration)
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
                elide: Text.ElideNone
            }

            StyledText {
                width: parent.width
                visible: root.conversationBody().length > 0
                text: root.conversationBody()
                textFormat: Text.PlainText
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeSmall + 1
                wrapMode: Text.WordWrap
                elide: Text.ElideNone
            }

            StyledText {
                width: parent.width
                visible: root.events.length > 0
                text: "Request timeline · " +
                    root.compactNumber(root.detail ? root.detail.eventsTotal : 0) + " requests"
                color: Theme.surfaceText
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }

            Item {
                width: parent.width
                height: 18
                visible: root.hoveredEvent >= 0 && root.hoveredEvent < root.events.length

                StyledText {
                    width: parent.width
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.hoveredEvent >= 0 && root.hoveredEvent < root.events.length
                            ? "Request " + (root.hoveredEvent + 1) + " · " +
                            root.eventTime(root.events[root.hoveredEvent].ts) + " · " +
                            String(root.events[root.hoveredEvent].model || "") + " · " +
                            root.compactNumber(root.eventTokens(root.events[root.hoveredEvent])) + " tok · " +
                            root.formatMoney(root.events[root.hoveredEvent].costUsd)
                        : ""
                    color: Theme.surfaceVariantText
                    font.pixelSize: Theme.fontSizeSmall
                    isMonospace: true
                    elide: Text.ElideRight
                }
            }

            Item {
                id: timeline

                width: parent.width
                height: 54
                visible: root.events.length > 0

                Row {
                    id: timelineRow

                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    height: parent.height
                    spacing: 0
                    clip: true

                    Repeater {
                        model: root.events

                        delegate: Rectangle {
                            width: root.events.length > 0
                                ? timelineRow.width / root.events.length : 0
                            height: Math.max(3, timelineRow.height * root.eventTokens(modelData) /
                                root.maximumEventTokenCount)
                            anchors.bottom: parent.bottom
                            radius: 1
                            color: root.hoveredEvent === index
                                ? Theme.primary
                                : Theme.withAlpha(Theme.primary, 0.72)

                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                onEntered: root.hoveredEvent = index
                                onExited: {
                                    if (root.hoveredEvent === index)
                                        root.hoveredEvent = -1
                                }
                            }
                        }
                    }
                }
            }

            Column {
                width: parent.width
                spacing: 2
                visible: root.events.length > 0

                Repeater {
                    model: root.events

                    delegate: TokitokiListRow {
                        alternate: index % 2 === 1
                        rowHeight: 22
                        showSurface: false

                        Item {
                            anchors.fill: parent

                            StyledText {
                                anchors.left: parent.left
                                anchors.right: eventValue.left
                                anchors.verticalCenter: parent.verticalCenter
                                text: root.eventTime(modelData.ts) + " · " +
                                    String(modelData.model || "(no model)")
                                color: Theme.surfaceText
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                            }

                            StyledText {
                                id: eventValue

                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                text: root.compactNumber(root.eventTokens(modelData)) + " tok · " +
                                    root.formatMoney(modelData.costUsd)
                                color: Theme.surfaceVariantText
                                font.pixelSize: Theme.fontSizeSmall
                                isMonospace: true
                            }
                        }
                    }
                }
            }

            Row {
                width: parent.width
                spacing: Theme.spacingS
                visible: root.detail !== null && root.detail.eventsHasMore === true

                ActionChip {
                    label: root.eventsLoading ? "Loading…" : "Load next 40 requests"
                    iconName: "more_horiz"
                    actionEnabled: !root.eventsLoading
                    onClicked: root.loadMoreEvents()
                }

                StyledText {
                    text: "Showing " + root.events.length + " of " +
                        root.compactNumber(root.detail ? root.detail.eventsTotal : 0)
                    color: Theme.surfaceVariantText
                    font.pixelSize: Theme.fontSizeSmall
                    anchors.verticalCenter: parent.verticalCenter
                }
            }

            StyledText {
                width: parent.width
                visible: root.events.length === 0 && !root.eventsLoading && root.detail !== null &&
                    root.conversationBody().length === 0
                text: root.privacyHideNames && root.detail && root.detail.conversation
                    ? "Conversation hidden by privacy setting."
                    : "No indexed conversation or request rows for this session."
                color: Theme.surfaceVariantText
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
                elide: Text.ElideNone
            }
        }
    }
}
