import Foundation
import Testing

@testable import tokitoki_menubar

@Suite @MainActor struct QuotaStatusTests {
    private func window(status: String) throws -> LimitWindow {
        let json = """
        {"kind":"week","source":"embedded","tokens":10,"cost":0,"requests":0,
         "status":"\(status)","usedPct":0,"observedAt":"2026-10-23T12:00:00Z",
         "bucketId":"codex","windowId":"secondary"}
        """
        return try JSONDecoder().decode(LimitWindow.self, from: Data(json.utf8))
    }

    @Test func invalidStatusesCannotExposeRemainingCapacity() throws {
        for status in ["stale", "expired", "unknown"] {
            let window = try window(status: status)
            #expect(window.currentUsedPct == nil)
            #expect(window.quotaStatus == status)
            #expect(window.observationLabel.hasPrefix("Observed "))
            #expect(window.bucketId == "codex")
            #expect(window.windowId == "secondary")
        }
        #expect(try window(status: "current").currentUsedPct == 0)
    }

    @Test func elapsedResetCannotBecomeFreshZeroUsage() throws {
        var window = try window(status: "current")
        window = LimitWindow(kind: window.kind, source: window.source, tokens: 0, cost: 0,
                             requests: 0, usedPct: 0, resetsAt: "2000-01-01T00:00:00Z",
                             windowStart: nil, windowEnd: nil)
        #expect(window.quotaStatus == "expired")
        #expect(window.currentUsedPct == nil)
    }

    @Test func localBudgetsDecodeSeparatelyAndStayOutOfTheStrip() throws {
        let json = """
        {"provider":"codex","accountKey":"unknown","windows":[],
         "budgetWindows":[{"kind":"day","source":"derived","tokens":100,"cost":2.5,
           "requests":3,"usedPct":40,"windowStart":"2026-10-24T00:00:00Z",
           "windowEnd":"2026-10-25T00:00:00Z"}]}
        """
        let account = try JSONDecoder().decode(AccountLimits.self, from: Data(json.utf8))
        #expect(account.quotaWindows.isEmpty)
        #expect(account.budgetWindows?.first?.cost == 2.5)
        #expect(account.budgetWindows?.first?.currentUsedPct == nil)
        #expect(Model.stripGroups(from: [account], metric: "percent", previewHidden: []).isEmpty)
        #expect(Model.previewText([account], cfg: nil, labeled: true) == nil)
    }
}
