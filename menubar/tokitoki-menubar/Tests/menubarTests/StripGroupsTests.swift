import Foundation
import Testing

@testable import tokitoki_menubar

/// Regression coverage for the status-bar strip grouping
/// (Model.stripGroups) and the upstream-provider mapping — the layer that
/// decides which marks + numbers appear in the menu bar.
@Suite @MainActor struct StripGroupsTests {
    // MARK: fixtures

    private func window(
        kind: String,
        source: String = "derived",
        tokens: Double,
        usedPct: Double? = nil,
        resetsAt: String? = nil,
    ) -> LimitWindow {
        LimitWindow(
            kind: kind,
            source: source,
            tokens: tokens,
            cost: 0,
            requests: 0,
            usedPct: usedPct,
            resetsAt: resetsAt,
            windowStart: nil,
            windowEnd: nil,
        )
    }

    private func account(
        provider: String,
        accountKey: String,
        windows: [LimitWindow],
    ) -> AccountLimits {
        AccountLimits(
            provider: provider,
            accountKey: accountKey,
            email: nil,
            credential: nil,
            alsoOn: nil,
            planLabel: nil,
            windows: windows,
            origin: nil,
            bankedResets: nil,
            bankedExpiresAt: nil,
        )
    }

    // MARK: upstreamProvider mapping

    @Test func harnessesMapToUpstreamProviders() {
        #expect(Model.upstreamProvider(account(provider: "codex", accountKey: "codex", windows: [])) == "openai")
        #expect(Model.upstreamProvider(account(provider: "codex", accountKey: "openai:plus", windows: [])) == "openai")
        #expect(Model.upstreamProvider(account(provider: "claude-code", accountKey: "default", windows: [])) == "claude")
        #expect(Model.upstreamProvider(account(provider: "pi", accountKey: "openrouter", windows: [])) == "openrouter")
        #expect(Model.upstreamProvider(account(provider: "pi", accountKey: "opencode-go", windows: [])) == "opencode")
        #expect(Model.upstreamProvider(account(provider: "opencode", accountKey: "opencode-go", windows: [])) == "opencode")
    }

    // MARK: percent mode (default)

    @Test func percentModeShowsOnlyRealQuotas() {
        let limits = [
            // codex carries a real weekly quota → stacked NN% lines.
            account(provider: "codex", accountKey: "codex", windows: [
                window(kind: "week", source: "embedded", tokens: 100, usedPct: 40),
                window(kind: "day", source: "embedded", tokens: 10, usedPct: 0),
            ]),
            // anthropic has no denominator → omitted entirely (icon disabled).
            account(provider: "claude-code", accountKey: "default", windows: [
                window(kind: "week", source: "derived", tokens: 500),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "percent", previewHidden: [])
        let byId = Dictionary(uniqueKeysWithValues: groups.map { ($0.provider, $0.lines) })

        #expect(byId["openai"] == ["60%", "100%"]) // payload window order
        #expect(byId["claude"] == nil)
    }

    @Test func percentModeStacksMultipleAccountsOfOneProvider() {
        let limits = [
            account(provider: "codex", accountKey: "codex", windows: [
                window(kind: "week", source: "embedded", tokens: 1, usedPct: 6),
            ]),
            account(provider: "codex", accountKey: "openai:plus", windows: [
                window(kind: "week", source: "polled", tokens: 1, usedPct: 0),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "percent", previewHidden: [])
        #expect(groups.count == 1)
        #expect(groups.first?.provider == "openai")
        #expect(groups.first?.lines == ["94%", "100%"])
    }

    @Test func percentModeKeepsEachAccountAndShowsPartialExhaustionReset() {
        let sessionReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(86 * 60))
        let limits = [
            account(provider: "codex", accountKey: "personal", windows: [
                window(kind: "day", source: "polled", tokens: 0, usedPct: 100, resetsAt: sessionReset),
                window(kind: "week", source: "polled", tokens: 0, usedPct: 23),
            ]),
            account(provider: "codex", accountKey: "work", windows: [
                window(kind: "day", source: "polled", tokens: 0, usedPct: 23),
                window(kind: "week", source: "polled", tokens: 0, usedPct: 44),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "percent", previewHidden: [], exhaustedBehavior: "reset")
        #expect(groups.count == 1)
        #expect(groups.first?.lines.count == 3)
        #expect(groups.first?.lines.first?.contains("h") == true)
        #expect(Array(groups.first?.lines.dropFirst() ?? []) == ["77%", "56%"])
    }

    // MARK: tokens mode (uniform)

    @Test func tokensModeShowsUsageForEveryGroup() {
        let limits = [
            account(provider: "claude-code", accountKey: "default", windows: [
                window(kind: "week", source: "derived", tokens: 600_000_000),
            ]),
            account(provider: "pi", accountKey: "openrouter", windows: [
                window(kind: "month", source: "derived", tokens: 0),
                window(kind: "week", source: "derived", tokens: 250_000),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "tokens", previewHidden: [])
        let byId = Dictionary(uniqueKeysWithValues: groups.map { ($0.provider, $0.lines) })

        // Exactly one ~line per group; week is the preferred basis.
        #expect(byId["claude"]?.count == 1)
        #expect(byId["claude"]?.first?.hasPrefix("~") == true)
        #expect(byId["openrouter"]?.count == 1)
        #expect(byId["openrouter"]?.first?.hasPrefix("~") == true)
    }

    // MARK: preview visibility

    @Test func previewHiddenFiltersGroupsOut() {
        let limits = [
            account(provider: "codex", accountKey: "codex", windows: [
                window(kind: "week", source: "embedded", tokens: 1, usedPct: 6),
            ]),
            account(provider: "claude-code", accountKey: "default", windows: [
                window(kind: "week", source: "derived", tokens: 500),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "percent", previewHidden: ["openai"])
        // claude is estimate-only → omitted in percent mode; openai hidden.
        #expect(groups.isEmpty)
    }

    @Test func zeroUsagePercentGroupStillRendersItsRealNumber() {
        // A polled 0%-used window IS real data — it must show as 100% left.
        let limits = [
            account(provider: "codex", accountKey: "openai:plus", windows: [
                window(kind: "week", source: "polled", tokens: 0, usedPct: 0),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "percent", previewHidden: [])
        #expect(groups.first?.lines == ["100%"])
    }

    @Test func exhaustedProviderUsesLongestResetWhenConfigured() {
        let dayReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3_600))
        let weekReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(5 * 86_400))
        let limits = [
            account(provider: "codex", accountKey: "default", windows: [
                window(kind: "day", source: "polled", tokens: 0, usedPct: 100, resetsAt: dayReset),
                window(kind: "week", source: "polled", tokens: 0, usedPct: 100, resetsAt: weekReset),
            ]),
        ]
        let groups = Model.stripGroups(from: limits, metric: "percent", previewHidden: [], exhaustedBehavior: "reset")
        #expect(groups.first?.lines.count == 1)
        #expect(groups.first?.lines.first?.contains("d") == true)
        #expect(Model.stripGroups(from: limits, metric: "percent", previewHidden: [], exhaustedBehavior: "hide").isEmpty)
    }

    @Test func smartModeShowsTheGoverningResetOrTightestWindow() {
        let dayReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3_600))
        let weekReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(5 * 86_400))
        let exhausted = account(provider: "codex", accountKey: "default", windows: [
            window(kind: "day", source: "polled", tokens: 0, usedPct: 100, resetsAt: dayReset),
            window(kind: "week", source: "polled", tokens: 0, usedPct: 100, resetsAt: weekReset),
        ])
        let exhaustedGroups = Model.stripGroups(from: [exhausted], metric: "smart", previewHidden: [])
        #expect(exhaustedGroups.first?.lines.first?.contains("d") == true)

        let constrained = account(provider: "codex", accountKey: "default", windows: [
            window(kind: "day", source: "polled", tokens: 0, usedPct: 10),
            window(kind: "week", source: "polled", tokens: 0, usedPct: 65),
        ])
        #expect(Model.stripGroups(from: [constrained], metric: "smart", previewHidden: []).first?.lines == ["35%"])
    }

    @Test func freshnessCopyStaysEnglish() {
        let now = Date()
        #expect(relativeDateEnglish(now.addingTimeInterval(-60), relativeTo: now) == "1 minute ago")
    }

    @Test func cliErrorsAreSafeForThePopover() {
        #expect(Model.conciseCLIError("SQLiteError: database is locked\n at bun:sqlite\n at cache.ts:47") == "database busy; the next refresh will retry automatically")
        #expect(Model.conciseCLIError("error: provider is not configured\n at cli.ts:1") == "provider is not configured")
    }

    @Test func hoverPreviewLabelsQuotaWindows() {
        let limits = [
            account(provider: "codex", accountKey: "openai:plus", windows: [
                window(kind: "day", source: "polled", tokens: 0, usedPct: 40),
                window(kind: "week", source: "polled", tokens: 0, usedPct: 0),
                window(kind: "month", source: "polled", tokens: 0, usedPct: 12),
            ]),
        ]
        let preview = Model.previewText(limits, cfg: UiPreviewConfig(
            previewLines: 3, previewMode: "hover", providers: nil, menubarHidden: nil,
            cards: nil, pollAuto: nil, pollIntervalMinutes: nil, previewHidden: nil, stripMetric: nil, stripExhausted: nil,
        ), labeled: true)
        #expect(preview == "session 60% weekly 100% monthly 88%")
    }

    @Test func localDashboardRoutesUseTheSharedServer() {
        #expect(AppDelegate.localDashboardURL(path: "/")?.absoluteString == "http://localhost:7788/")
        #expect(AppDelegate.localDashboardURL(path: "/?view=sources")?.absoluteString == "http://localhost:7788/?view=sources")
        #expect(AppDelegate.localDashboardURL(path: "?view=dashboard&range=month")?.absoluteString == "http://localhost:7788/?view=dashboard&range=month")
    }
}
