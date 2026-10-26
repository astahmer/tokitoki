import Foundation
import Testing

@testable import tokitoki_menubar

@Suite struct AccountPresentationTests {
    @Test func workspaceCreditsRemainSeparateFromBankedResetsAndMoney() throws {
        let credits = try JSONDecoder().decode(AccountCredits.self, from: Data("""
        {"hasCredits":true,"unlimited":false,"balance":"123.45"}
        """.utf8))
        #expect(credits.displayLabel == "Workspace credits 123.45")
        #expect(AccountCredits(hasCredits: true, unlimited: true, balance: nil).displayLabel == "Unlimited workspace credits")
        #expect(AccountCredits(hasCredits: false, unlimited: false, balance: "0").displayLabel == "Workspace credits 0")
        #expect(AccountCredits(hasCredits: false, unlimited: false, balance: nil).displayLabel == nil)
    }

    @Test func nativeProfilesKeepEmailsHomesAndIndependentWindowStatus() throws {
        let decoded = try JSONDecoder().decode(AccountLimits.self, from: Data("""
        {"provider":"codex","accountKey":"openai:work","accountId":"work",
         "email":"work@example.com","origin":"polled","codexHome":"/tmp/work profile",
         "bankedResets":2,"windows":[
           {"kind":"day","source":"polled","tokens":0,"cost":0,"requests":0,
            "id":"codex:primary","status":"expired","observedAt":"2026-09-09T12:00:00Z"},
           {"kind":"week","source":"polled","tokens":0,"cost":0,"requests":0,
            "id":"codex:secondary","status":"current","usedPct":35,
            "observedAt":"2026-09-10T15:18:00Z"}]}
        """.utf8))
        #expect(decoded.id == "codex@openai:work")
        #expect(decoded.email == "work@example.com")
        #expect(decoded.codexHome == "/tmp/work profile")
        #expect(decoded.bankedResets == 2)
        #expect(decoded.sourceDescription == "read from the native Codex CLI")
        #expect(decoded.quotaWindows.map(\.quotaStatus) == ["expired", "current"])
        #expect(decoded.quotaWindows[0].usedPct == nil)
        #expect(decoded.quotaWindows[1].usedPct == 35)
    }

    @Test func nativeLoginTargetsOwningHomeAndQuotesShellData() {
        #expect(AccountLimits.codexLoginCommand(home: nil) == "codex login")
        #expect(AccountLimits.codexLoginCommand(home: "") == "codex login")
        #expect(AccountLimits.codexLoginCommand(home: "/tmp/work profile") == "CODEX_HOME='/tmp/work profile' codex login")
        #expect(AccountLimits.codexLoginCommand(home: "/tmp/user's $(touch nope)") == "CODEX_HOME='/tmp/user'\"'\"'s $(touch nope)' codex login")
    }

    private func account(_ key: String, provider: String = "codex") -> AccountLimits {
        AccountLimits(provider: provider, accountKey: key, email: nil, credential: nil,
                      alsoOn: nil, planLabel: nil, windows: [], origin: nil,
                      bankedResets: nil, bankedExpiresAt: nil)
    }

    @Test func ordersRemainIndependentAndNewAccountsAppendStably() {
        let accounts = [account("a"), account("b"), account("c")]
        let quotaOrder = ["codex@b", "codex@a"]
        let barOrder = ["codex@a", "codex@b"]
        #expect(AccountPresentation.ordered(accounts, order: quotaOrder).map(\.id) == ["codex@b", "codex@a", "codex@c"])
        #expect(AccountPresentation.ordered(accounts, order: barOrder).map(\.id) == ["codex@a", "codex@b", "codex@c"])
    }

    @Test func movesPreserveHiddenAndAbsentSlots() {
        let saved = ["codex@a", "codex@hidden", "codex@absent", "codex@b"]
        let moved = AccountPresentation.move("codex@b", direction: -1, saved: saved,
            accounts: ["codex@a", "codex@b", "codex@new"], visible: ["codex@a", "codex@b"])
        #expect(moved == ["codex@b", "codex@hidden", "codex@absent", "codex@a", "codex@new"])
        #expect(AccountPresentation.move("codex@a", direction: -1, saved: saved,
            accounts: [], visible: ["codex@a", "codex@b"]) == saved)
        #expect(AccountPresentation.completeOrder(saved + saved, accounts: saved) == saved)
    }

    @Test func providerWideRestoreExposesAllProviderAccounts() {
        let personal = account("personal")
        let work = account("work")
        let claude = account("default", provider: "claude-code")
        let hidden: Set<String> = ["codex", "claude-code", "missing:account"]
        let restored = AccountPresentation.restoring(personal, hidden: hidden, accounts: [personal, work, claude])
        #expect(AccountPresentation.visible(personal, hidden: restored))
        #expect(AccountPresentation.visible(work, hidden: restored))
        #expect(!AccountPresentation.visible(claude, hidden: restored))
        #expect(restored.contains("missing:account"))
    }

    @Test func legacySuffixTargetsMatchBackendRules() {
        let personal = account("openai:personal")
        let unrelated = account("personal-team")
        #expect(!AccountPresentation.visible(personal, hidden: ["codex:personal"]))
        #expect(AccountPresentation.visible(unrelated, hidden: ["codex:personal"]))
        let restored = AccountPresentation.restoring(personal, hidden: ["codex:personal"], accounts: [personal, unrelated])
        #expect(restored.isEmpty)
    }

    @Test func previewPayloadDecodesIndependentPreferencesAndLegacyAbsence() throws {
        let current = try JSONDecoder().decode(UiPreviewConfig.self, from: Data("""
        {"accountOrder":["codex@a"],"barAccountOrder":["codex@b"],"barHiddenAccounts":["codex@a"]}
        """.utf8))
        #expect(current.accountOrder == ["codex@a"])
        #expect(current.barAccountOrder == ["codex@b"])
        #expect(current.barHiddenAccounts == ["codex@a"])
        let legacy = try JSONDecoder().decode(UiPreviewConfig.self, from: Data("{\"accountOrder\":[\"codex@a\"]}".utf8))
        #expect(legacy.barAccountOrder == nil)
        #expect(legacy.barHiddenAccounts == nil)
        let explicitEmpty = try JSONDecoder().decode(UiPreviewConfig.self, from: Data("{\"barAccountOrder\":[]}".utf8))
        #expect(explicitEmpty.barAccountOrder == [])
    }
    @Test func firstQuotaReorderFreezesLegacyBarOrderIncludingDiscoveredAccounts() {
        let saved = ["codex@a", "claude-code@b"]
        let discovered = saved + ["codex@c"]
        let update = AccountPresentation.quotaReorder(["codex@c", "claude-code@b", "codex@a"],
            saved: saved, barOrder: nil, accounts: discovered)
        #expect(update.quota == ["codex@c", "claude-code@b", "codex@a"])
        #expect(update.bar == discovered)
        let next = AccountPresentation.quotaReorder(saved, saved: update.quota,
            barOrder: update.bar, accounts: discovered)
        #expect(next.bar == discovered)
    }

    @Test func quotaReorderPreservesExplicitEmptyBarOrderAndHiddenQuotaSlots() {
        let saved = ["codex@a", "codex@hidden", "codex@b", "codex@absent"]
        let discovered = ["codex@a", "codex@b", "codex@new"]
        let update = AccountPresentation.quotaReorder(["codex@b", "codex@a"],
            saved: saved, barOrder: [], accounts: discovered)
        #expect(update.quota == ["codex@b", "codex@hidden", "codex@a", "codex@absent", "codex@new"])
        #expect(update.bar == discovered)
    }

    @Test func barArrowsFollowRenderedGroupsInsteadOfInterleavedSavedOrder() {
        let a = account("a")
        let b = account("b", provider: "claude-code")
        let c = account("c")
        let accounts = [a, b, c]
        let saved = accounts.map(\.id)
        let group: (AccountLimits) -> String? = { $0.provider }
        #expect(AccountPresentation.grouped(accounts, order: saved, group: group).flatMap { $0 }.map(\.id) == [a.id, c.id, b.id])
        let within = AccountPresentation.moveBar(a.id, direction: 1, saved: saved,
            accounts: accounts, visible: accounts, group: group)
        #expect(within == [c.id, a.id, b.id])
        let boundary = AccountPresentation.moveBar(c.id, direction: 1, saved: saved,
            accounts: accounts, visible: accounts, group: group)
        #expect(boundary == [b.id, a.id, c.id])
        let reverse = AccountPresentation.moveBar(b.id, direction: -1, saved: saved,
            accounts: accounts, visible: accounts, group: group)
        #expect(reverse == boundary)
    }

    @Test func groupedBarMovesPreserveHiddenAndMissingSlots() {
        let a = account("a")
        let b = account("b", provider: "claude-code")
        let c = account("c")
        let hidden = account("hidden")
        let accounts = [a, b, c, hidden]
        let saved = [a.id, hidden.id, b.id, "codex@absent", c.id]
        let moved = AccountPresentation.moveBar(c.id, direction: 1, saved: saved,
            accounts: accounts, visible: [a, b, c], group: { $0.provider })
        #expect(moved == [b.id, hidden.id, a.id, "codex@absent", c.id])
        let groups = AccountPresentation.grouped([a, b, c], order: moved, group: { $0.provider })
        #expect(groups.flatMap { $0 }.map(\.id) == [b.id, a.id, c.id])
    }

}
