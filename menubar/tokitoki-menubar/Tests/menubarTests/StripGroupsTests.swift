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

    @Test func sideNotchModesAreCanonicalAndSessionProvidersMapToTheirUpstream() {
        #expect(SideNotchMode.canonical(nil) == "quota")
        #expect(SideNotchMode.canonical("unknown") == "quota")
        #expect(SideNotchMode.canonical("activity") == "activity")
        #expect(SideNotchMode.canonical("runway") == "runway")
        #expect(Model.upstreamProvider(for: "claude-code", accountKey: "default") == "claude")
        #expect(Model.upstreamProvider(for: "codex", accountKey: "default") == "openai")
        #expect(Model.upstreamProvider(for: "pi", accountKey: "openrouter") == "openrouter")
        #expect(Model.upstreamProvider(for: "opencode-go", accountKey: "default") == "opencode")
    }

    @Test func sideNotchWindowCanPinAQuotaKindAndFallsBackSafely() {
        let limits = account(provider: "codex", accountKey: "default", windows: [
            window(kind: "day", tokens: 1, usedPct: 10),
            window(kind: "week", tokens: 2, usedPct: 20),
            window(kind: "month", tokens: 3, usedPct: 30),
        ])
        #expect(Model.sideNotchWindow(limits, preference: "week")?.kind == "week")
        #expect(Model.sideNotchWindow(limits, preference: "month")?.kind == "month")
        #expect(Model.sideNotchWindow(limits, preference: "unknown")?.kind == "day")
        #expect(Model.sideNotchWindow(account(provider: "codex", accountKey: "default", windows: [window(kind: "week", tokens: 2)]), preference: "day")?.kind == "week")
    }

    @Test func sideNotchAnchorDerivesItsEdge() {
        #expect(Model.sideNotchEdge(for: "top-left") == "top")
        #expect(Model.sideNotchEdge(for: "top-right") == "top")
        #expect(Model.sideNotchEdge(for: "right-top") == "right")
        #expect(Model.sideNotchEdge(for: "right-bottom") == "right")
        #expect(Model.sideNotchEdge(for: "left-top") == "left")
        #expect(Model.sideNotchEdge(for: "left-bottom") == "left")
        #expect(Model.sideNotchEdge(for: "center") == "right") // legacy
        #expect(Model.sideNotchEdge(for: "right") == "right")
        #expect(Model.sideNotchEdge(for: "bottom-left") == "bottom")
        #expect(Model.sideNotchEdge(for: "bottom-right") == "bottom")
    }

    @Test func sideNotchDropSnapsToTheNearestGridAnchor() {
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.50, yFromTop: 0.04) == "top")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.96, yFromTop: 0.04) == "top-right")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.96, yFromTop: 0.24) == "right-top")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.96, yFromTop: 0.76) == "right-bottom")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.50, yFromTop: 0.96) == "bottom")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.04, yFromTop: 0.96) == "bottom-left")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.04, yFromTop: 0.76) == "left-bottom")
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.04, yFromTop: 0.24) == "left-top")

        // Center is equidistant from every edge; preserve dragged rail edge.
        #expect(Model.sideNotchPlacement(forNormalizedX: 0.50, yFromTop: 0.50, preferredEdge: "right") == "right")
        #expect(Model.sideNotchPlacement(forNormalizedX: -1, yFromTop: 2) == "bottom-left")
    }

    @Test func sideNotchGeometryKeepsEveryAnchorInsideTheViewport() {
        let visible = NSRect(x: 40, y: 30, width: 1_440, height: 900)

        for placement in Model.validSideNotchPlacements {
            let collapsed = SideNotchGeometry.frame(
                in: visible,
                placement: placement,
                expanded: false,
                hasDetail: false,
            )
            let expanded = SideNotchGeometry.frame(
                in: visible,
                placement: placement,
                expanded: true,
                hasDetail: true,
            )

            for frame in [collapsed, expanded] {
                #expect(frame.minX >= visible.minX)
                #expect(frame.maxX <= visible.maxX)
                #expect(frame.minY >= visible.minY)
                #expect(frame.maxY <= visible.maxY)
            }

            switch Model.sideNotchEdge(for: placement) {
            case "left":
                #expect(collapsed.minX == visible.minX)
                #expect(expanded.minX == visible.minX)
                #expect(expanded.size == NSSize(
                    width: SideNotchGeometry.railWidth + SideNotchGeometry.detailWidth + SideNotchGeometry.detailGap,
                    height: SideNotchGeometry.railLength,
                ))
            case "right":
                #expect(collapsed.maxX == visible.maxX)
                #expect(expanded.maxX == visible.maxX)
                #expect(expanded.size == NSSize(
                    width: SideNotchGeometry.railWidth + SideNotchGeometry.detailWidth + SideNotchGeometry.detailGap,
                    height: SideNotchGeometry.railLength,
                ))
            case "top":
                #expect(collapsed.maxY == visible.maxY)
                #expect(expanded.maxY == visible.maxY)
                #expect(expanded.size == NSSize(
                    width: SideNotchGeometry.railLength,
                    height: SideNotchGeometry.railWidth + SideNotchGeometry.detailHeight + SideNotchGeometry.detailGap,
                ))
            case "bottom":
                #expect(collapsed.minY == visible.minY)
                #expect(expanded.minY == visible.minY)
                #expect(expanded.size == NSSize(
                    width: SideNotchGeometry.railLength,
                    height: SideNotchGeometry.railWidth + SideNotchGeometry.detailHeight + SideNotchGeometry.detailGap,
                ))
            default:
                Issue.record("Unsupported side-notch placement: \(placement)")
            }
        }
    }

    @Test func topCenterCanHideCollapsedHandleInPhysicalNotch() {
        let visible = NSRect(x: 0, y: 30, width: 1_440, height: 900)
        let screen = NSRect(x: 0, y: 0, width: 1_440, height: 982)
        let topCenter = SideNotchGeometry.frame(
            in: visible,
            placement: "top",
            expanded: false,
            hasDetail: false,
            screenFrame: screen,
        )
        #expect(topCenter.maxY == screen.maxY)
        #expect(topCenter.midX == screen.midX)

        let topLeft = SideNotchGeometry.frame(
            in: visible,
            placement: "top-left",
            expanded: false,
            hasDetail: false,
            screenFrame: screen,
        )
        #expect(topLeft.maxY == visible.maxY)
    }

    @Test func topCenterReservesPhysicalNotchSafeArea() {
        let visible = NSRect(x: 0, y: 30, width: 1_440, height: 900)
        let screen = NSRect(x: 0, y: 0, width: 1_440, height: 982)
        let expanded = SideNotchGeometry.frame(
            in: visible,
            placement: "top",
            expanded: true,
            hasDetail: true,
            screenFrame: screen,
            topSafeAreaInset: 40,
        )

        #expect(expanded.maxY == screen.maxY - 40)
        #expect(expanded.maxY < screen.maxY)
    }

    @Test func sideNotchDetailHeightTracksVisibleQuotaRows() {
        #expect(SideNotchGeometry.dynamicDetailHeight(forRowCount: 0) == 110)
        #expect(SideNotchGeometry.dynamicDetailHeight(forRowCount: 1) == 110)
        #expect(SideNotchGeometry.dynamicDetailHeight(forRowCount: 2) == 156)
        #expect(SideNotchGeometry.dynamicDetailHeight(forRowCount: 3) == 206)
        #expect(SideNotchGeometry.dynamicDetailHeight(forRowCount: 5) == 238)
    }

    @Test func sideNotchRailLengthTracksVisibleIcons() {
        #expect(SideNotchGeometry.railLength(forVisibleEntryCount: 0) == 68)
        #expect(SideNotchGeometry.railLength(forVisibleEntryCount: 1) == 136)
        #expect(SideNotchGeometry.railLength(forVisibleEntryCount: 5) == 408)
        #expect(SideNotchGeometry.railLength(forVisibleEntryCount: 6) == 476)
        #expect(SideNotchGeometry.railLength(forVisibleEntryCount: 8) == 476)
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
            previewLines: 3, previewEnabled: nil, previewMode: "hover", sideNotchEnabled: nil, sideNotchHidden: nil, sideNotchMetric: nil, sideNotchSyncPreview: nil, sideNotchPlacement: nil, providers: nil, menubarHidden: nil,
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
