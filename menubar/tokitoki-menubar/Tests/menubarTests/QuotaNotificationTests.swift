import Foundation
import Testing

@testable import tokitoki_menubar

@Suite struct QuotaNotificationTests {
    private func account() -> AccountLimits {
        AccountLimits(provider: "codex", accountKey: "personal", email: nil, credential: nil,
                      alsoOn: nil, planLabel: nil, windows: [], origin: nil,
                      bankedResets: nil, bankedExpiresAt: nil)
    }

    private func window(id: String? = nil, bucket: String = "codex", slot: String = "secondary",
                        model: String? = nil, used: Double = 95, status: String = "current",
                        reset: String = "2099-11-01T00:00:00Z") -> LimitWindow {
        var window = LimitWindow(kind: "week", source: "embedded", tokens: 0, cost: 0,
                                 requests: 0, usedPct: used, resetsAt: reset,
                                 windowStart: nil, windowEnd: nil)
        window.id = id
        window.bucketId = bucket
        window.windowId = slot
        window.model = model
        window.status = status
        return window
    }

    @Test func healthySeparateMeterCannotRecoverCriticalMeter() throws {
        var observations: [String: QuotaObservation] = [:]
        let critical = try #require(QuotaNotificationUpdate.record(account: account(),
            window: window(id: "weekly:opus"), criticalPercent: 10, observations: &observations))
        let healthy = try #require(QuotaNotificationUpdate.record(account: account(),
            window: window(id: "weekly:review", bucket: "review", used: 10),
            criticalPercent: 10, observations: &observations))
        #expect(critical.critical)
        #expect(!healthy.critical)
        #expect(!healthy.availableAgain)
        #expect(critical.identity != healthy.identity)
        #expect(observations[critical.identity]?.remaining == 5)
        #expect(observations[healthy.identity]?.remaining == 90)
    }

    @Test func simultaneousCriticalMetersHaveIndependentAlertKeys() throws {
        var observations: [String: QuotaObservation] = [:]
        var alerts: Set<String> = []
        for id in ["weekly:opus", "weekly:review", "weekly:opus", "weekly:review"] {
            let update = try #require(QuotaNotificationUpdate.record(account: account(),
                window: window(id: id), criticalPercent: 10, observations: &observations))
            if update.critical { alerts.insert(update.criticalKey) }
            #expect(!update.availableAgain)
        }
        #expect(alerts.count == 2)
        #expect(observations.count == 2)
    }

    @Test func fallbackSeparatesBucketsSlotsAndModels() throws {
        let windows = [window(), window(bucket: "review"), window(slot: "tertiary"), window(model: "opus")]
        #expect(Set(windows.map(\.notificationIdentity)).count == windows.count)
        var observations: [String: QuotaObservation] = [:]
        for window in windows {
            let update = try #require(QuotaNotificationUpdate.record(account: account(), window: window,
                criticalPercent: 10, observations: &observations))
            #expect(update.critical)
            #expect(!update.availableAgain)
        }
        #expect(observations.count == windows.count)
        var renamed = window()
        renamed.label = "Renamed weekly quota"
        #expect(renamed.notificationIdentity == window().notificationIdentity)
    }

    @Test func invalidObservationsCannotRecoverOrOverwriteCriticalState() throws {
        var observations: [String: QuotaObservation] = [:]
        let critical = try #require(QuotaNotificationUpdate.record(account: account(), window: window(),
            criticalPercent: 10, observations: &observations))
        for status in ["stale", "expired", "unknown"] {
            #expect(QuotaNotificationUpdate.record(account: account(), window: window(used: 0, status: status),
                criticalPercent: 10, observations: &observations) == nil)
        }
        #expect(QuotaNotificationUpdate.record(account: account(),
            window: window(used: 0, reset: "2000-01-01T00:00:00Z"),
            criticalPercent: 10, observations: &observations) == nil)
        #expect(observations[critical.identity]?.remaining == 5)
        let recovered = try #require(QuotaNotificationUpdate.record(account: account(), window: window(used: 10),
            criticalPercent: 10, observations: &observations))
        #expect(recovered.availableAgain)
    }

    @Test func resetChangeRequiresPreviouslyCriticalAndNowUsableCapacity() throws {
        var observations: [String: QuotaObservation] = [:]
        _ = QuotaNotificationUpdate.record(account: account(), window: window(),
            criticalPercent: 10, observations: &observations)
        let stillCritical = try #require(QuotaNotificationUpdate.record(account: account(),
            window: window(reset: "2099-12-01T00:00:00Z"),
            criticalPercent: 10, observations: &observations))
        #expect(!stillCritical.availableAgain)
        let recovered = try #require(QuotaNotificationUpdate.record(account: account(),
            window: window(used: 70, reset: "2100-01-01T00:00:00Z"),
            criticalPercent: 10, observations: &observations))
        #expect(recovered.availableAgain)
        let healthy = try #require(QuotaNotificationUpdate.record(account: account(),
            window: window(used: 10, reset: "2100-02-01T00:00:00Z"),
            criticalPercent: 10, observations: &observations))
        #expect(!healthy.availableAgain)
    }
    @Test func repeatedObservationIsUnchangedAndResetGetsANewAlertKey() throws {
        var observations: [String: QuotaObservation] = [:]
        let first = try #require(QuotaNotificationUpdate.record(account: account(), window: window(),
            criticalPercent: 10, observations: &observations))
        let repeated = try #require(QuotaNotificationUpdate.record(account: account(), window: window(),
            criticalPercent: 10, observations: &observations))
        #expect(first.changed)
        #expect(!repeated.changed)
        #expect(first.criticalKey == repeated.criticalKey)
        let next = try #require(QuotaNotificationUpdate.record(account: account(),
            window: window(reset: "2100-01-01T00:00:00Z"), criticalPercent: 10, observations: &observations))
        #expect(next.changed)
        #expect(next.criticalKey != first.criticalKey)
        #expect(!next.availableAgain)
    }

    @Test func nonfiniteAndDerivedObservationsDoNotOverwriteRealQuota() throws {
        var observations: [String: QuotaObservation] = [:]
        let first = try #require(QuotaNotificationUpdate.record(account: account(), window: window(),
            criticalPercent: 10, observations: &observations))
        for used in [Double.nan, Double.infinity, -Double.infinity] {
            #expect(QuotaNotificationUpdate.record(account: account(), window: window(used: used),
                criticalPercent: 10, observations: &observations) == nil)
        }
        let derived = LimitWindow(kind: "week", source: "derived", tokens: 100, cost: 0,
            requests: 0, usedPct: 0, resetsAt: nil, windowStart: nil, windowEnd: nil)
        #expect(QuotaNotificationUpdate.record(account: account(), window: derived,
            criticalPercent: 10, observations: &observations) == nil)
        #expect(observations.count == 1)
        #expect(observations[first.identity]?.remaining == 5)
    }

}
