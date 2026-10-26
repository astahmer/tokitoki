import Foundation
import Testing

@testable import tokitoki_menubar

@Suite struct TrackingQualityTests {
    @Test func tokenMeasurementIsIndependentOfCostSource() throws {
        let q = try quality("""
        {"reportedTokens":60,"estimatedTokens":30,"unknownTokens":10,"estimatedRequests":3}
        """)
        #expect(TrackingQuality.tokenLabel(reported: q.reportedTokens, estimated: q.estimatedTokens, unknown: q.unknownTokens) == "Token counts: 60 reported · 30 estimated · 10 source unknown")
        #expect(TrackingQuality.tokenLabel(reported: nil, estimated: nil, unknown: nil) == nil)
    }
    private func quality(_ json: String) throws -> TrackingQuality {
        try JSONDecoder().decode(TrackingQuality.self, from: Data(json.utf8))
    }

    private func report(_ n: Int) throws -> ReportPayload {
        try JSONDecoder().decode(ReportPayload.self, from: Data("""
        {"rows":[],"total":{"bucket":"total","requests":1,"sessions":1,"inputTokens":\(n),
        "outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4,"costUsd":0},
        "burn":{"perDay":0,"projected":0}}
        """.utf8))
    }

    @Test func optionalFieldsPreserveAbsenceAndExplicitZero() throws {
        let legacy = try quality("{}")
        #expect(legacy.reportedRequests == nil)
        #expect(legacy.pricingCoveragePercent == nil)
        #expect(legacy.unpricedModels == nil)
        let empty = try quality("""
        {"requests":0,"reportedRequests":0,"estimatedRequests":0,"unpricedRequests":0,
        "unknownRequests":0,"pricingCoveragePercent":null,"cachedInputPercent":null,"unpricedModels":[]}
        """)
        #expect(empty.requests == 0)
        #expect(empty.reportedRequests == 0)
        #expect(empty.cachedInputPercent == nil)
        #expect(empty.unpricedModels == [])
    }

    @Test func requestSourcesAreDecodedIndependently() throws {
        let q = try quality("""
        {"requests":10,"reportedRequests":1,"estimatedRequests":2,"unpricedRequests":3,
        "unknownRequests":4,"pricedRequests":3,"pricingCoveragePercent":30,"cachedInputPercent":75,
        "costUsd":0.12,"unpricedModels":["new-model"]}
        """)
        #expect(q.reportedRequests == 1)
        #expect(q.estimatedRequests == 2)
        #expect(q.unpricedRequests == 3)
        #expect(q.unknownRequests == 4)
        #expect(q.costUsd == 0.12)
        #expect(TrackingQuality.percentLabel(q.pricingCoveragePercent) == "30.0%")
    }

    @Test func compositionUsesSelectedPeriodAndIncludesAllCacheTokens() throws {
        let q = try quality("""
        {"inputTokens":10,"outputTokens":20,"cacheReadTokens":30,"cacheWriteTokens":40,"totalTokens":100}
        """)
        let today = try report(1000)
        let week = try report(7000)
        let selected = TokenComposition.selected(key: "month", tracking: ["month": q], periods: [],
            today: today, week: week, customRows: [])
        #expect(selected.input == 10)
        #expect(selected.output == 20)
        #expect(selected.cacheRead == 30)
        #expect(selected.cacheWrite == 40)
        #expect(selected.input + selected.output + selected.cacheRead + selected.cacheWrite == q.totalTokens)
        let oldWeek = TokenComposition.selected(key: "week", tracking: [:], periods: [],
            today: today, week: week, customRows: [])
        #expect(oldWeek.input == 7000)
        let oldToday = TokenComposition.selected(key: "today", tracking: [:], periods: [],
            today: today, week: week, customRows: [])
        #expect(oldToday.input == 1000)
        let absent = TokenComposition.selected(key: "year", tracking: [:], periods: [],
            today: today, week: week, customRows: [])
        #expect(absent.input == 0)
    }

    @Test func customAndLegacyPeriodRowsStayInTheirOwnWindow() throws {
        let row = try JSONDecoder().decode(ReportRow.self, from: Data("""
        {"bucket":"model","requests":1,"sessions":1,"costUsd":0,"inputTokens":10,
        "outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4}
        """.utf8))
        let period = SpendPeriod(key: "yesterday", rows: [row])
        let old = TokenComposition.selected(key: "yesterday", tracking: [:], periods: [period],
            today: nil, week: nil, customRows: [])
        #expect(old.input == 10)
        #expect(old.cacheWrite == 4)
        let custom = TokenComposition.selected(key: "custom", tracking: [:], periods: [period],
            today: nil, week: nil, customRows: [row, row])
        #expect(custom.input == 20)
        #expect(custom.cacheRead == 6)
    }

    @Test func boundedPrivacySafeLabelsAndUnavailablePercentages() {
        #expect(TrackingQuality.percentLabel(nil) == "—")
        #expect(TrackingQuality.percentLabel(.nan) == "—")
        #expect(TrackingQuality.percentLabel(101) == "—")
        #expect(TrackingQuality.percentLabel(0) == "0.0%")
        #expect(TrackingQuality.modelLabel("new-model-1") == "new-model-1")
        for unsafe in ["/Users/person/private", "name@example.com", "sk-secret", "line\nbreak"] {
            #expect(TrackingQuality.modelLabel(unsafe) == "other model identifier")
        }
        #expect(TrackingQuality.modelLabel(String(repeating: "a", count: 60)).count == 38)
        #expect(TrackingQuality.modelLabel(String(repeating: "a", count: 100)) == "other model identifier")
    }
}
