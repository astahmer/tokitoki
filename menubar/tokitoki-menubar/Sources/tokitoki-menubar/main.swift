import SwiftUI
import UniformTypeIdentifiers
import AppKit
import UserNotifications

// tokitoki menu-bar extra: AppKit NSStatusItem + NSPopover hosting the SwiftUI
// ContentView. Deliberately NOT SwiftUI MenuBarExtra: mutating a MenuBarExtra
// label on a bare (non-bundled) binary intermittently drops the status item
// from the menu bar while leaving the popover window orphaned on screen
// (observed 2026-08-24: no layer-25 window, stuck 320pt layer-101 panel).
// NSStatusItem + title-change guards are deterministic.

struct ReportRow: Codable {
    let bucket: String
    let requests: Int
    let sessions: Int
    let costUsd: Double
    // Token fields ride along in the report JSON; optional so an older
    // payload (pre-tokens) still decodes.
    let inputTokens: Double?
    let outputTokens: Double?
    let cacheReadTokens: Double?
    let cacheWriteTokens: Double?

    var totalTokens: Double {
        (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
    }
}

struct TotalsRow: Codable {
    let bucket: String
    let requests: Int
    let sessions: Int
    let inputTokens: Double?
    let outputTokens: Double?
    let cacheReadTokens: Double?
    let cacheWriteTokens: Double?
    let costUsd: Double

    var totalTokens: Double {
        (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
    }
}

struct ReportPayload: Codable {
    struct Burn: Codable { let perDay: Double; let projected: Double }
    // Absolute calendar-day payloads have no named rolling period.
    let period: String?
    let rows: [ReportRow]
    let total: TotalsRow
    let burn: Burn
}

// MARK: - budgets / anomalies contracts (tokitoki budgets --json, anomalies --json)

struct BudgetRow: Codable {
    let scope: String
    let label: String
    let cap: Double
    let used: Double
    let ratio: Double
    let state: String
    let daysLeft: Double?

    var level: Int { state == "exceeded" ? 100 : state == "warn" ? 80 : 0 }
}

struct AnomalyItem: Codable {
    let day: String
    let metric: String
    let value: Double
    let baseline: Double
    let ratio: Double
}

struct AnomaliesPayload: Codable {
    struct Window: Codable { let since: String; let until: String?; let label: String }
    let window: Window
    let metric: String
    let anomalies: [AnomalyItem]
}

struct SpendHealthPayload: Codable {
    let monthToDate: Double
    let requests: Int
    let perDay: Double
    let projected: Double
    let monthlyCap: Double?
    let projectedRatio: Double?
    let state: String
    let daysElapsed: Int
    let daysInMonth: Int
}

struct NotificationConfigPayload: Codable {
    let enabled: Bool?
    let resetAware: Bool?
    let quotaCriticalPercent: Int?
    let burnWarnings: Bool?
    let burnWarningRatio: Double?
    let disabledNotifications: [String]?
}

struct NotificationRecord: Codable, Identifiable {
    let id: String
    let at: String
    let title: String
    let body: String
    let reason: String
    let kind: String?
}

private struct NotificationState: Codable {
    let keys: [String]
    let history: [NotificationRecord]
}

struct MachineHeartbeat: Codable {
    let machineId: String
    let host: String
    let ts: Double
    let state: String
}

// MARK: - tools contract (tokitoki tools --json)

struct ToolRow: Codable {
    let tool: String
    let requests: Int
    let tokens: Double
    let costUsd: Double
}

struct ToolsPayload: Codable {
    struct Period: Codable { let since: String; let until: String }
    let period: Period
    let tools: [ToolRow]
}

// MARK: - limits contract (menubar-payload v2 `limits`, from src/limits.ts)

struct LimitWindow: Codable {
    let kind: String
    let source: String
    let tokens: Double
    let cost: Double
    let requests: Int
    let usedPct: Double?
    let resetsAt: String?
    let windowStart: String?
    let windowEnd: String?
}

struct AccountLimits: Codable, Identifiable {
    let provider: String
    let accountKey: String
    /// Stable provider account id; never use reset timestamps as identity.
    var accountId: String? = nil
    let email: String?
    /** Redacted api-key/credential hint ("sk-x…12ab") when key-based. */
    let credential: String?
    /** Other harnesses sharing this exact credential (grouped card). */
    let alsoOn: [String]?
    let planLabel: String?
    let windows: [LimitWindow]
    /** Where this account's quota data comes from ("polled"/"scan"/"opencodex"/"manual"). */
    let origin: String?
    let bankedResets: Int?
    let bankedExpiresAt: String?
    var observedAt: String? = nil
    var freshness: String? = nil

    var id: String { "\(provider)@\(accountKey)" }
}

struct MenubarCardConfig: Codable {
    let id: String
    let hidden: Bool
}

struct UiPreviewConfig: Codable {
    let previewLines: Int?
    let previewMode: String? // "inline" | "hover"
    // Provider visibility (context-menu Settings ▸ toggles).
    let providers: [String]?
    let menubarHidden: [String]?
    // Card layout (Customize sheet): ordered ids + hidden flags.
    let cards: [MenubarCardConfig]?
    // Opt-in background quota polling (menubar runs `tokitoki poll`).
    let pollAuto: Bool?
    let pollIntervalMinutes: Int?
    var pollAdaptive: Bool? = nil
    // Upstream provider ids hidden from the STATUS-BAR STRIP only.
    let previewHidden: [String]?
    // Uniform strip display: "percent" (default) | "tokens" | "smart".
    let stripMetric: String?
    // Exhausted providers: "show" percentages | "hide" mark | "reset" countdown.
    let stripExhausted: String?
    var tabs: [String]? = nil
    var syncBackend: String? = nil
    var syncConfigured: Bool? = nil
    var syncPath: String? = nil
    var syncUrl: String? = nil
    var syncHandle: String? = nil
    var privacyHideIdentities: Bool? = nil
}

// Combined snapshot from `tokitoki menubar-payload --json` (single CLI
// process instead of seven parallel ones that thrashed memory).
/// Token rows for one selectable period (today|yesterday|week|month|year).
/// The payload carries separate harness, inferred-provider, and model series.
struct SpendPeriod: Codable {
    let key: String
    let rows: [ReportRow]
}

struct DailyUsageSeries: Codable, Identifiable {
    let bucket: String
    let values: [Double]
    var id: String { bucket }
}

struct DailyUsageHistory: Codable {
    let days: [String]
    let series: [DailyUsageSeries]
}

struct ActivityGridPayload: Codable {
    struct Cell: Codable { let day: String; let tokens: Double; let costUsd: Double; let requests: Int }
    let metric: String
    let cells: [Cell]
}

struct PopoverBlock: Codable, Identifiable {
    let accountKey: String
    let startIso: String
    let endIso: String
    let tokens: Double
    let costUsd: Double
    let requests: Int
    let isActive: Bool
    var id: String { "\(accountKey)/\(startIso)" }
}

struct BlocksPayload: Codable { let rows: [PopoverBlock] }
struct StatuslinePreviewPayload: Codable { let command: String; let preview: String }

struct PopoverSessionRow: Decodable, Identifiable {
    let sessionId: String
    let provider: String
    let accountKey: String
    let startedAt: String
    let lastRequestAt: String
    let title: String?
    let snippet: String?
    let requests: Int
    let models: [String]
    let repos: [String]
    let totalTokens: Double
    let cachePct: Int
    let costUsd: Double
    var id: String { "\(provider)/\(sessionId)" }

    private enum CodingKeys: String, CodingKey {
        case sessionId, provider, accountKey, startedAt, lastRequestAt, title, snippet
        case requests, models, repos, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
        case cachePct, costUsd
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try values.decode(String.self, forKey: .sessionId)
        provider = try values.decode(String.self, forKey: .provider)
        accountKey = try values.decode(String.self, forKey: .accountKey)
        startedAt = try values.decode(String.self, forKey: .startedAt)
        lastRequestAt = try values.decodeIfPresent(String.self, forKey: .lastRequestAt) ?? startedAt
        title = try values.decodeIfPresent(String.self, forKey: .title)
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet)
        requests = try values.decode(Int.self, forKey: .requests)
        models = try values.decodeIfPresent([String].self, forKey: .models) ?? []
        repos = try values.decodeIfPresent([String].self, forKey: .repos) ?? []
        let explicitTotal = try values.decodeIfPresent(Double.self, forKey: .totalTokens)
        let input = try values.decodeIfPresent(Double.self, forKey: .inputTokens) ?? 0
        let output = try values.decodeIfPresent(Double.self, forKey: .outputTokens) ?? 0
        let cacheRead = try values.decodeIfPresent(Double.self, forKey: .cacheReadTokens) ?? 0
        let cacheWrite = try values.decodeIfPresent(Double.self, forKey: .cacheWriteTokens) ?? 0
        totalTokens = explicitTotal ?? input + output + cacheRead + cacheWrite
        cachePct = try values.decodeIfPresent(Int.self, forKey: .cachePct) ?? 0
        costUsd = try values.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0
    }
}

struct PopoverSessionsPayload: Decodable {
    let rows: [PopoverSessionRow]
    let page: Int?
    let hasMore: Bool?
}

struct PopoverSessionDetail: Codable {
    let provider: String
    let sessionId: String
    let conversation: Conversation?

    struct Conversation: Codable {
        let title: String
        let body: String
    }

    struct Event: Codable, Identifiable {
        let n: Int
        let ts: String
        let model: String
        let inputTokens: Double
        let outputTokens: Double
        let cacheReadTokens: Double
        let cacheWriteTokens: Double
        let costUsd: Double
        let runningTokens: Double
        let tool: String?
        let description: String?
        var id: Int { n }
    }

    struct CacheDurationEstimate: Codable {
        let estimatedSeconds: Double?
        let confidence: String
        let samples: Int
        let busts: Int
        let lastBustAt: String?
    }

    let events: [Event]?
    let eventsTotal: Int?
    let eventsOffset: Int?
    let eventsHasMore: Bool?
    let cacheDuration: CacheDurationEstimate?
}

struct MenubarPayload: Decodable {
    let snapshotAt: String?
    let today: ReportPayload
    let rollingDay: ReportPayload?
    let week: ReportPayload
    let reposMonth: ReportPayload?
    let budgets: [BudgetRow]
    let anomalies: AnomaliesPayload?
    let spendHealth: SpendHealthPayload?
    let notifications: NotificationConfigPayload?
    let topTools: ToolsPayload?
    let presence: [MachineHeartbeat]?
    let limits: [AccountLimits]?
    let uiPreview: UiPreviewConfig?
    let spendPeriods: [SpendPeriod]?
    let providerPeriods: [SpendPeriod]?
    let modelPeriods: [SpendPeriod]?
    let history: DailyUsageHistory?
    let activityGrid: ActivityGridPayload?
    let repoHistory: DailyUsageHistory?
    let blocks: BlocksPayload?
    let statuslinePreview: StatuslinePreviewPayload?
    let recentSessions: PopoverSessionsPayload?
}

@MainActor
final class Model: ObservableObject {
    @Published var title: String = "…"
    @Published var today: ReportPayload?
    @Published var rollingDay: ReportPayload?
    @Published var week: ReportPayload?
    @Published var repos: [ReportRow] = []
    @Published var topTools: [ToolRow] = []
    @Published var activeOtherMachines = 0
    @Published var budgets: [BudgetRow] = []
    @Published var anomalyLine: String?
    @Published var spendHealth: SpendHealthPayload?
    @Published var limits: [AccountLimits] = []
    @Published var previewMode: String = "inline"
    /// Status-item strip groups: UPSTREAM providers (openai, claude,
    /// opencode, openrouter… — not harnesses), each with stacked "NN%" lines
    /// for real quotas or a single "~NN%" usage-relative estimate.
    @Published var previewGroups: [(provider: String, lines: [String])] = []
    @Published var knownProviders: [String] = []
    @Published var menubarHidden: Set<String> = []
    /// Popover card layout from the payload: ordered ids + hidden flags.
    @Published var cardLayout: [(id: String, hidden: Bool)] = []
    /// Opt-in background quota polling (`tokitoki poll` every ~15 min).
    @Published var pollAuto = false
    @Published var pollIntervalMinutes = 15
    @Published var pollAdaptive = false
    @Published var pollInFlight = false
    @Published var pollStatus: String?
    @Published var pollLastResult: String?
    @Published var nextPollAt: Date?
    @Published var isLoading = true
    @Published var loadingCompleted = 0
    @Published var loadingTotal = 1
    @Published var loadingStage = "Loading latest data…"
    @Published var dashboardStatus: String?
    @Published var lastUpdatedAt: Date?
    /// Account-card order override applied immediately after customize saves.
    @Published var accountOrderOverride: [String]? = nil
    /// Upstream provider ids hidden from the status-bar strip (cards unaffected).
    @Published var previewHidden: Set<String> = []
    /// Uniform strip display: "percent" (default) | "tokens".
    @Published var stripMetric: String = "percent"
    @Published var stripExhausted: String = "reset"
    @Published var spendPeriods: [SpendPeriod] = []
    @Published var providerPeriods: [SpendPeriod] = []
    @Published var modelPeriods: [SpendPeriod] = []
    @Published var history: DailyUsageHistory?
    @Published var activityGrid: ActivityGridPayload?
    @Published var repoHistory: DailyUsageHistory?
    @Published var blocks: [PopoverBlock] = []
    @Published var statuslinePreview: StatuslinePreviewPayload?
    @Published var tabOrder: [PopoverSubview] = PopoverSubview.defaultOrder
    @Published var syncBackend: String?
    @Published var syncConfigured = false
    @Published var syncStatus: String?
    @Published var syncPath = ""
    @Published var syncUrl = ""
    @Published var syncHandle = ""
    @Published var mcpStatus = "Ready · stdio is agent-owned"
    @Published var notificationsEnabled = true
    @Published var resetAwareNotifications = true
    @Published var quotaCriticalPercent = 10
    @Published var burnWarnings = true
    @Published var burnWarningRatio = 0.8
    @Published var disabledNotifications: Set<String> = []
    @Published var privacyHideIdentities = false
    @Published var notificationStatus: String?
    @Published var notificationHistory: [NotificationRecord] = []
    @Published var sessionRows: [PopoverSessionRow] = []
    @Published var sessionQuery = ""
    @Published var selectedSession: PopoverSessionDetail?
    @Published var selectedSessionRow: PopoverSessionRow?
    @Published var sessionStatus: String?
    @Published var sessionPage = 1
    @Published var sessionHasMore = false
    @Published var sessionEventsLoading = false
    @Published var maintenanceStatus: String?
    @Published var customHarnessRows: [ReportRow] = []
    @Published var customModelRows: [ReportRow] = []
    @Published var customProviderRows: [ReportRow] = []
    /// nil = no budgets configured; "ok" | "warn" | "exceeded"
    @Published var worstState: String?
    @Published var errorText: String?
    @Published var errorDetails: String?
    @Published var refreshingAccounts: Set<String> = []

    private var timer: Timer?
    /// Refresh responses are asynchronous; mutations bump this generation so
    /// an older payload cannot overwrite a newer optimistic setting.
    private var refreshGeneration = 0
    private var invocation: CLIInvocation = CLIInvocation(executable: URL(fileURLWithPath: "/usr/bin/false"), prefixArgs: [])
    private var lastLevels: [String: Int] = [:]
    private var notifiedKeys: Set<String> = []
    private var quotaObservations: [String: QuotaObservation] = [:]
    private var payloadInFlight = false
    private var payloadRefreshPending = false
    private var payloadRefreshPendingForce = false
    private var refreshFailureCount = 0
    private var nextRefreshRetryAt: Date?
    private var sessionRequestGeneration = 0
    private var hasHydratedSnapshot = false
    private var sessionTask: Task<Void, Never>?
    private var sessionPageCache: [String: PopoverSessionsPayload] = [:]

    private struct QuotaObservation: Codable {
        let remaining: Double
        let resetAt: String?
    }

    private static let debug = ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_DEBUG"] == "1"

    /// Refresh one card using the source that produced its numbers.
    func refreshAccount(_ account: AccountLimits) {
        let id = "\(account.provider)@\(account.accountKey)"
        guard !refreshingAccounts.contains(id) else { return }
        refreshingAccounts.insert(id)
        let cli = invocation
        let provider = refreshProvider(for: account)
        let args = account.origin == "scan"
            ? ["scan", "--provider", account.provider]
            : ["poll", "--json", "--provider", provider]
        Task { [weak self] in
            do {
                _ = try await Self.runCLI(cli, args)
            } catch {
                self?.dbg("card refresh failed for \(id): \(error.localizedDescription)")
            }
            self?.refreshingAccounts.remove(id)
            self?.refresh()
        }
    }

    /// Load a small, bounded session list without blocking the popover's main
    /// actor. An empty query shows the recent leaderboard; a query uses the
    /// same indexed full-text search as the CLI and web dashboard.
    func searchPopoverSessions(_ query: String) {
        sessionQuery = query
        sessionPage = 1
        fetchPopoverSessions(page: 1)
    }

    func nextPopoverSessionPage() {
        guard sessionHasMore else { return }
        fetchPopoverSessions(page: sessionPage + 1)
    }

    func previousPopoverSessionPage() {
        guard sessionPage > 1 else { return }
        fetchPopoverSessions(page: sessionPage - 1)
    }

    private func fetchPopoverSessions(page: Int) {
        let cli = invocation
        let trimmed = sessionQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let cacheKey = "\(trimmed.lowercased())|\(page)"
        sessionRequestGeneration += 1
        let requestGeneration = sessionRequestGeneration
        sessionTask?.cancel()
        sessionStatus = "Searching sessions…"
        if let cached = sessionPageCache[cacheKey] {
            sessionRows = cached.rows
            sessionPage = cached.page ?? page
            sessionHasMore = cached.hasMore ?? false
            sessionStatus = sessionRows.isEmpty ? "No sessions found" : "\(sessionRows.count) sessions · page \(sessionPage)"
            return
        }
        sessionTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                // The payload refresh already ingests and indexes local stores.
                // Session navigation must be a read-only cache query; syncing
                // here made a 50-row search compete with the full scanner.
                var args = ["sessions", "--cached", "--last", "month", "--top", "25", "--page", String(page), "--json"]
                if !trimmed.isEmpty { args += ["--search", trimmed] }
                let payload = try await Self.runJSON(PopoverSessionsPayload.self, cli, args)
                guard requestGeneration == self.sessionRequestGeneration else { return }
                if let payload { self.sessionPageCache[cacheKey] = payload }
                self.sessionRows = payload?.rows ?? []
                self.sessionPage = payload?.page ?? page
                self.sessionHasMore = payload?.hasMore ?? false
                self.sessionStatus = self.sessionRows.isEmpty ? "No sessions found" : "\(self.sessionRows.count) session\(self.sessionRows.count == 1 ? "" : "s") · page \(self.sessionPage)"
            } catch {
                if Task.isCancelled { return }
                guard requestGeneration == self.sessionRequestGeneration else { return }
                self.sessionRows = []
                self.sessionStatus = "Session search failed: \(error.localizedDescription)"
            }
        }
    }

    func loadPopoverSession(_ row: PopoverSessionRow) {
        let cli = invocation
        sessionTask?.cancel()
        sessionRequestGeneration += 1
        selectedSessionRow = row
        selectedSession = nil
        sessionEventsLoading = true
        sessionStatus = "Loading conversation…"
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let detail = try await Self.runJSON(PopoverSessionDetail.self, cli, [
                    "sessions", "--cached", "--provider", row.provider, "--session", row.sessionId,
                    "--events-limit", "40", "--events-offset", "0", "--json",
                ])
                self.selectedSession = detail
                self.sessionEventsLoading = false
                self.sessionStatus = detail?.conversation == nil ? "No conversation body indexed" : nil
            } catch {
                self.sessionEventsLoading = false
                self.sessionStatus = "Could not load conversation: \(error.localizedDescription)"
            }
        }
    }

    func clearPopoverSession() {
        sessionTask?.cancel()
        sessionRequestGeneration += 1
        selectedSession = nil
        selectedSessionRow = nil
        sessionEventsLoading = false
        sessionStatus = nil
    }

    func loadMorePopoverSessionEvents() {
        guard let row = selectedSessionRow,
              let detail = selectedSession,
              detail.eventsHasMore == true,
              !sessionEventsLoading else { return }
        let offset = detail.events?.count ?? 0
        let cli = invocation
        sessionEventsLoading = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let next = try await Self.runJSON(PopoverSessionDetail.self, cli, [
                    "sessions", "--cached", "--provider", row.provider, "--session", row.sessionId,
                    "--events-limit", "40", "--events-offset", String(offset), "--json",
                ])
                if let next {
                    let oldEvents = detail.events ?? []
                    self.selectedSession = PopoverSessionDetail(
                        provider: next.provider,
                        sessionId: next.sessionId,
                        conversation: detail.conversation ?? next.conversation,
                        events: oldEvents + (next.events ?? []),
                        eventsTotal: next.eventsTotal,
                        eventsOffset: 0,
                        eventsHasMore: next.eventsHasMore,
                        cacheDuration: next.cacheDuration,
                    )
                }
                self.sessionEventsLoading = false
            } catch {
                self.sessionEventsLoading = false
                self.sessionStatus = "Could not load more requests: \(error.localizedDescription)"
            }
        }
    }

    func loadCustomTokenBreakdowns(from: Date, to: Date) {
        let calendar = Calendar.current
        func day(_ date: Date) -> String {
            let c = calendar.dateComponents([.year, .month, .day], from: date)
            return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        }
        let cli = invocation
        let fromKey = day(from)
        let toKey = day(to)
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                async let harness = Self.runJSON(ReportPayload.self, cli, ["report", "--by", "provider", "--from", fromKey, "--to", toKey, "--json"])
                async let models = Self.runJSON(ReportPayload.self, cli, ["report", "--by", "model", "--from", fromKey, "--to", toKey, "--json"])
                self.customHarnessRows = (try await harness)?.rows ?? []
                self.customModelRows = (try await models)?.rows ?? []
                // Upstream provider attribution is not exposed by the report
                // command, so retain the last cached attribution and make the
                // custom provider chart use the provider-grouped report rows.
                self.customProviderRows = self.customHarnessRows
            } catch {
                self.pollStatus = "Custom token range failed: \(error.localizedDescription)"
            }
        }
    }

    /// Hide one account card immediately, then persist the same canonical
    /// provider:account target used by Customize and the CLI.
    func hideAccount(_ account: AccountLimits) {
        let target = "\(account.provider):\(account.accountKey)"
        menubarHidden.insert(target)
        invalidateRefreshes()
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await Self.runConfigCLI(cli, ["ui", "--hide", target])
                self.pollStatus = "Hidden \(account.accountKey)"
                self.refresh()
            } catch {
                self.menubarHidden.remove(target)
                self.pollStatus = "Could not hide card: \(error.localizedDescription)"
            }
        }
    }

    private func refreshProvider(for account: AccountLimits) -> String {
        if account.provider == "codex" { return "codex" }
        if account.provider == "copilot" { return "copilot" }
        if account.provider == "claude-code" { return "claude-code" }
        if account.provider == "commandcode" { return "commandcode" }
        if account.provider == "pi" || account.provider == "opencode" {
            return account.accountKey.lowercased().contains("openrouter") ? "openrouter" : "opencode-go"
        }
        return account.provider
    }

    /// Env-gated stderr tracing (`TOKITOKI_MENUBAR_DEBUG=1`) — no-op normally.
    fileprivate func dbg(_ msg: @autoclosure () -> String) {
        if Self.debug { FileHandle.standardError.write(Data(("[tokitoki-menubar] " + msg() + "\n").utf8)) }
    }

    /// Accessor for AppDelegate context-menu actions.
    func currentInvocation() -> CLIInvocation { invocation }

    /// Resolve the same writable config file as the CLI. An existing TOML
    /// file wins when no JSON file exists, keeping declarative/Nix-owned
    /// settings from silently drifting into a sidecar.
    static func configFileURL() -> URL {
        if let path = ProcessInfo.processInfo.environment["TOKITOKI_CONFIG"], !path.isEmpty {
            return URL(fileURLWithPath: path)
        }
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/tokitoki")
        let json = dir.appendingPathComponent("config.json")
        let toml = dir.appendingPathComponent("config.toml")
        if !FileManager.default.fileExists(atPath: json.path), FileManager.default.fileExists(atPath: toml.path) {
            return toml
        }
        return json
    }

    var configFilePath: String { Self.configFileURL().path }

    func openConfigFile() {
        let url = Self.configFileURL()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
            )
            if !FileManager.default.fileExists(atPath: url.path) {
                try Data("{}\n".utf8).write(to: url, options: .atomic)
            }
            guard NSWorkspace.shared.open(url) else {
                pollStatus = "Could not open \(url.lastPathComponent)"
                return
            }
            pollStatus = "Opened \(url.lastPathComponent)"
        } catch {
            pollStatus = "Could not open config: \(error.localizedDescription)"
        }
    }

    func setPolling(enabled: Bool) {
        pollAuto = enabled
        if !enabled { lastPollAt = nil; nextPollAt = nil }
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await Self.runConfigCLI(cli, ["poll", enabled ? "--enable" : "--disable"])
                self.pollStatus = enabled ? "Background polling enabled" : "Background polling disabled"
                self.refresh()
            } catch {
                self.pollAuto = !enabled
                self.pollStatus = "Could not save polling setting: \(error.localizedDescription)"
            }
        }
    }

    func setPollingInterval(minutes: Int) {
        let value = max(1, minutes)
        pollIntervalMinutes = value
        updatePollSchedule()
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await Self.runConfigCLI(cli, ["config", "set", "poll.intervalMinutes", String(value)])
                self.pollStatus = "Polling interval saved"
            } catch {
                self.pollStatus = "Could not save polling interval: \(error.localizedDescription)"
            }
        }
    }

    func setPollingAdaptive(_ enabled: Bool) {
        pollAdaptive = enabled
        updatePollSchedule()
        persistUISetting(path: "poll.adaptive", json: enabled ? "true" : "false")
    }

    func setNotificationsEnabled(_ enabled: Bool) {
        notificationsEnabled = enabled
        notificationStatus = enabled ? "Critical alerts enabled" : "Notifications disabled"
        persistUISetting(path: "notifications.enabled", json: enabled ? "true" : "false")
    }

    func setResetAwareNotifications(_ enabled: Bool) {
        resetAwareNotifications = enabled
        notificationStatus = enabled ? "Reset alerts enabled" : "Reset alerts disabled"
        persistUISetting(path: "notifications.resetAware", json: enabled ? "true" : "false")
    }

    func setQuotaCriticalPercent(_ percent: Int) {
        quotaCriticalPercent = max(0, min(100, percent))
        notificationStatus = "Critical threshold saved"
        persistUISetting(path: "notifications.quotaCriticalPercent", json: "\(quotaCriticalPercent)")
    }

    func setBurnWarnings(_ enabled: Bool) {
        burnWarnings = enabled
        notificationStatus = enabled ? "Burn warnings enabled" : "Burn warnings disabled"
        persistUISetting(path: "notifications.burnWarnings", json: enabled ? "true" : "false")
    }

    func setBurnWarningRatio(_ ratio: Double) {
        burnWarningRatio = max(0, min(1, ratio))
        notificationStatus = "Burn threshold saved"
        persistUISetting(path: "notifications.burnWarningRatio", json: String(format: "%.2f", burnWarningRatio))
    }

    func setPrivacyHideIdentities(_ enabled: Bool) {
        privacyHideIdentities = enabled
        persistUISetting(path: "privacy.hideIdentities", json: enabled ? "true" : "false")
    }

    func setNotificationKindEnabled(_ kind: String, enabled: Bool) {
        if enabled { disabledNotifications.remove(kind) } else { disabledNotifications.insert(kind) }
        notificationStatus = enabled ? "\(notificationKindLabel(kind)) alerts enabled" : "\(notificationKindLabel(kind)) alerts disabled"
        let json = "[" + disabledNotifications.sorted().map { "\"\($0)\"" }.joined(separator: ",") + "]"
        persistUISetting(path: "notifications.disabled", json: json)
    }

    func notificationKindLabel(_ kind: String) -> String {
        switch kind {
        case "quotaCritical": return "Critical quota"
        case "quotaReset": return "Quota reset"
        case "burnRate": return "Burn-rate"
        case "budget": return "Budget"
        default: return kind
        }
    }

    func setTabOrder(_ order: [PopoverSubview]) {
        let normalized = PopoverSubview.normalizedOrder(order.map(\.rawValue))
        tabOrder = normalized
        let json = "[" + normalized.map { "\"\($0.rawValue)\"" }.joined(separator: ",") + "]"
        persistUISetting(path: "ui.menubarTabs", json: json)
    }

    func setSyncBackend(_ backend: String) {
        let value = "\"\(backend)\""
        syncBackend = backend == "none" ? nil : backend
        syncConfigured = backend != "none"
        syncStatus = "Saving sync backend…"
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await Self.runConfigCLI(cli, ["config", "set", "sync.backend", value])
                self.syncStatus = backend == "none" ? "Sync disabled" : "Sync backend saved"
                self.refresh()
            } catch {
                self.syncStatus = "Could not save sync setting: \(error.localizedDescription)"
            }
        }
    }

    func setSyncValue(path: String, value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        switch path {
        case "sync.path": syncPath = trimmed
        case "sync.url": syncUrl = trimmed
        case "sync.handle": syncHandle = trimmed
        default: break
        }
        let cli = invocation
        let json = "\"\(trimmed.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\""
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await Self.runConfigCLI(cli, ["config", "set", path, json])
                self.syncStatus = "Sync setting saved"
            } catch {
                self.syncStatus = "Could not save sync setting: \(error.localizedDescription)"
            }
        }
    }

    func syncNow() {
        guard syncConfigured else {
            syncStatus = "Choose a backend and finish its path/remote in config first"
            return
        }
        syncStatus = "Syncing events…"
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let output = try await Self.runCLI(cli, ["sync"])
                self.syncStatus = output.split(separator: "\n").last.map(String.init) ?? "Sync complete"
                self.refresh()
            } catch {
                self.syncStatus = "Sync failed: \(error.localizedDescription)"
            }
        }
    }

    func reindexSessions() {
        maintenanceStatus = "Reindexing every harness conversation…"
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let output = try await Self.runCLI(cli, ["reindex"])
                maintenanceStatus = output.split(separator: "\n").first.map(String.init) ?? "Session index rebuilt"
                refresh()
            } catch {
                maintenanceStatus = "Reindex failed: \(error.localizedDescription)"
            }
        }
    }

    func importUsageCSV() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.commaSeparatedText, .text]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        maintenanceStatus = "Importing \(url.lastPathComponent)…"
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let output = try await Self.runCLI(cli, ["import", url.path])
                maintenanceStatus = output.split(separator: "\n").last.map(String.init) ?? "Import complete"
                refresh()
            } catch {
                maintenanceStatus = "Import failed: \(error.localizedDescription)"
            }
        }
    }

    /// Refresh provider quotas and expose progress in the popover.
    func pollNow(background: Bool = false) {
        guard !pollInFlight else { return }
        guard !payloadInFlight else {
            pollStatus = "Data refresh in progress · quotas will refresh next"
            return
        }
        pollInFlight = true
        if !background { pollStatus = "refreshing provider quotas…" }
        let cli = invocation
        Task { @MainActor [weak self] in
            guard let self else { return }
            var succeeded = false
            do {
                _ = try await Self.runCLI(cli, ["poll", "--json"])
                succeeded = true
                self.pollStatus = background ? nil : "provider quotas refreshed"
            } catch {
                self.pollStatus = "Quota refresh failed: \(error.localizedDescription)"
                self.pollLastResult = "Failed · \(error.localizedDescription)"
            }
            self.pollInFlight = false
            self.lastPollAt = Date()
            self.nextPollAt = self.pollAuto
                ? Date().addingTimeInterval(Double(self.effectivePollIntervalMinutes) * 60)
                : nil
            if succeeded { self.pollLastResult = "Updated successfully" }
            self.refresh()
        }
    }

    /// Fire a background quota poll only when enabled and due.
    private func runBackgroundPoll() {
        pollNow(background: true)
    }

    func start(invocation: CLIInvocation) {
        self.invocation = invocation
        dbg("start · exec=\(invocation.executable.path) prefix=\(invocation.prefixArgs)")
        notifiedKeys = Self.loadNotifiedKeys()
        notificationHistory = Self.loadNotificationHistory()
        quotaObservations = Self.loadQuotaObservations()
        dbg("loaded \(notifiedKeys.count) notified keys from \(Self.stateFileURL.path)")
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        // e2e seam: poll a sentinel file to trigger a deterministic close
        // (synthetic HID/AX events don't route reliably to accessory apps).
        if ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST"] == "1" {
            let closeFile = URL(fileURLWithPath: "/tmp/tokitoki-menubar.close")
            let contextFile = URL(fileURLWithPath: "/tmp/tokitoki-menubar.context")
            Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
                if FileManager.default.fileExists(atPath: closeFile.path) {
                    try? FileManager.default.removeItem(at: closeFile)
                    Task { @MainActor in
                        AppDelegate.shared?.closePopover()
                        FileHandle.standardError.write(Data("[tokitoki-menubar] test-close fired\n".utf8))
                    }
                }
                if FileManager.default.fileExists(atPath: contextFile.path) {
                    try? FileManager.default.removeItem(at: contextFile)
                    Task { @MainActor in AppDelegate.shared?.showTestContextMenu() }
                }
            }
        }
    }

    private var lastPollAt: Date?

    var pollScheduleDescription: String {
        guard pollAuto else { return "Off · quota refreshes happen only when you ask." }
        let cadence = pollAdaptive
            ? "Adaptive · every \(effectivePollIntervalMinutes)–30 minutes"
            : "Every \(max(1, pollIntervalMinutes)) minutes"
        guard let nextPollAt else { return "On · \(cadence) · waiting for the first check." }
        return "On · \(cadence) · next check \(nextPollAt.formatted(date: .omitted, time: .shortened))"
    }

    var pollLastResultDescription: String? {
        guard let pollLastResult else { return nil }
        guard let lastPollAt else { return pollLastResult }
        return "Last check \(relativeDateEnglish(lastPollAt)) · \(pollLastResult)"
    }

    private func updatePollSchedule() {
        nextPollAt = pollAuto && lastPollAt != nil
            ? lastPollAt!.addingTimeInterval(Double(effectivePollIntervalMinutes) * 60)
            : nil
    }

    /// Poll faster when a provider is close to a reset, but never more often
    /// than once per five minutes or less often than once per thirty minutes.
    /// This keeps the idle menu cheap while making a near-term unblock visible.
    private var effectivePollIntervalMinutes: Int {
        guard pollAdaptive else { return max(1, pollIntervalMinutes) }
        let now = Date()
        let nearestReset = limits
            .flatMap { $0.windows }
            .compactMap { $0.resetsAt.flatMap(parseISO) }
            .filter { $0 > now }
            .min()
        guard let nearestReset else { return 30 }
        let seconds = nearestReset.timeIntervalSince(now)
        if seconds <= 15 * 60 { return 5 }
        if seconds <= 2 * 60 * 60 { return 10 }
        return 30
    }

    /// Invalidate payload requests already in flight before a config mutation.
    func invalidateRefreshes() { refreshGeneration += 1 }

    func refresh(force: Bool = false) {
        if !force, let retryAt = nextRefreshRetryAt, retryAt > Date() {
            isLoading = false
            loadingStage = "Retry scheduled"
            return
        }
        refreshGeneration += 1
        let generation = refreshGeneration
        isLoading = true
        loadingCompleted = 0
        loadingTotal = 4
        if payloadInFlight {
            payloadRefreshPending = true
            payloadRefreshPendingForce = payloadRefreshPendingForce || force
            return
        }
        if pollInFlight {
            payloadRefreshPending = true
            payloadRefreshPendingForce = payloadRefreshPendingForce || force
            return
        }
        if pollAuto, lastPollAt.map({ Date().timeIntervalSince($0) >= Double(effectivePollIntervalMinutes) * 60 }) ?? true {
            lastPollAt = Date()
            runBackgroundPoll()
            return
        }
        let cached = !hasHydratedSnapshot
        hasHydratedSnapshot = true
        loadingCompleted = cached ? 0 : 1
        loadingStage = cached ? "Reading saved snapshot…" : "Scanning harness stores…"
        payloadInFlight = true
        Task { @MainActor in
            defer {
                self.payloadInFlight = false
                self.isLoading = false
                if self.payloadRefreshPending {
                    let pendingForce = self.payloadRefreshPendingForce
                    self.payloadRefreshPending = false
                    self.payloadRefreshPendingForce = false
                    self.refresh(force: pendingForce)
                }
            }
            do {
                let args = cached
                    ? ["menubar-payload", "--cached", "--json"]
                    : ["menubar-payload", "--json"]
                let p = try await Self.runJSON(MenubarPayload.self, invocation, args)!
                guard generation == self.refreshGeneration else {
                    self.dbg("discarded stale payload generation \(generation)")
                    return
                }
                dbg("fetched · budgets=\(p.budgets.count) anomalies=\(p.anomalies?.anomalies.count ?? -1) limits=\(p.limits?.count ?? -1)")
                self.loadingCompleted = cached ? 1 : 4
                self.loadingStage = cached ? "Refreshing live data…" : "Reports ready"
                if let notifications = p.notifications {
                    self.notificationsEnabled = notifications.enabled ?? true
                    self.resetAwareNotifications = notifications.resetAware ?? true
                    self.quotaCriticalPercent = max(0, min(100, notifications.quotaCriticalPercent ?? 10))
                    self.burnWarnings = notifications.burnWarnings ?? true
                    self.burnWarningRatio = max(0, min(1, notifications.burnWarningRatio ?? 0.8))
                    self.disabledNotifications = Set(notifications.disabledNotifications ?? [])
                }
                if let ui = p.uiPreview {
                    self.previewMode = ui.previewMode ?? "inline"
                    self.knownProviders = ui.providers ?? []
                    self.menubarHidden = Set(ui.menubarHidden ?? [])
                    self.cardLayout = (ui.cards ?? []).map { ($0.id, $0.hidden) }
                    self.pollAuto = ui.pollAuto ?? false
                    self.pollIntervalMinutes = max(1, ui.pollIntervalMinutes ?? 15)
                    self.pollAdaptive = ui.pollAdaptive ?? false
                    self.previewHidden = Set(ui.previewHidden ?? [])
                    self.stripMetric = ui.stripMetric ?? "percent"
                    self.stripExhausted = ui.stripExhausted ?? "reset"
                    self.tabOrder = PopoverSubview.normalizedOrder(ui.tabs)
                    self.syncBackend = ui.syncBackend
                    self.syncConfigured = ui.syncConfigured ?? (ui.syncBackend != nil)
                    self.syncPath = ui.syncPath ?? ""
                    self.syncUrl = ui.syncUrl ?? ""
                    self.syncHandle = ui.syncHandle ?? ""
                    self.privacyHideIdentities = ui.privacyHideIdentities ?? false
                }
                self.updatePollSchedule()
                self.spendPeriods = p.spendPeriods ?? []
                self.providerPeriods = p.providerPeriods ?? []
                self.modelPeriods = p.modelPeriods ?? []
                self.history = p.history
                self.activityGrid = p.activityGrid
                self.repoHistory = p.repoHistory
                self.blocks = p.blocks?.rows ?? []
                self.statuslinePreview = p.statuslinePreview
                self.spendHealth = p.spendHealth
                self.today = p.today
                self.rollingDay = p.rollingDay
                self.week = p.week
                self.currentPayloadForTitle = p
                self.currentPreviewCfg = p.uiPreview
                if let recentSessions = p.recentSessions {
                    self.sessionPageCache["|1"] = recentSessions
                    if self.selectedSessionRow == nil && self.sessionQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.sessionRows = recentSessions.rows
                        self.sessionPage = recentSessions.page ?? 1
                        self.sessionHasMore = recentSessions.hasMore ?? false
                        self.sessionStatus = recentSessions.rows.isEmpty
                            ? "No sessions found"
                            : "\(recentSessions.rows.count) sessions · page \(recentSessions.page ?? 1)"
                    }
                }
                if let rm = p.reposMonth {
                    self.repos = Array(rm.rows.sorted { $0.costUsd > $1.costUsd }.prefix(6))
                }
                self.topTools = Array((p.topTools?.tools ?? []).prefix(3))
                let local = ProcessInfo.processInfo.hostName
                self.activeOtherMachines = (p.presence ?? []).filter { $0.state == "active" && $0.machineId != local }.count
                self.limits = p.limits ?? []
                applyBudgets(p.budgets)
                applyQuotaNotifications(self.limits)
                applySpendHealthNotifications(p.spendHealth)
                self.previewMode = p.uiPreview?.previewMode ?? "inline"
                // Upstream-provider groups with stacked quota percentages;
                // providers without a real denominator get ONE usage-relative
                // estimate line (~NN%) instead of nothing.
                previewGroups = Self.stripGroups(
                    from: p.limits ?? [],
                    metric: stripMetric,
                    previewHidden: previewHidden,
                    exhaustedBehavior: stripExhausted
                )
                let newTitle = composeTitle(today: p.today, preview: Self.previewText(p.limits ?? [], cfg: p.uiPreview, labeled: self.previewMode == "hover"), hovering: isHovering, mode: self.previewMode)
                setTitleIfChanged(newTitle)
                self.errorText = nil
                self.errorDetails = nil
                self.refreshFailureCount = 0
                self.nextRefreshRetryAt = nil
                if let snapshotAt = p.snapshotAt, let parsedSnapshotAt = parseISO(snapshotAt) {
                    self.lastUpdatedAt = parsedSnapshotAt
                } else if self.lastUpdatedAt == nil {
                    self.lastUpdatedAt = Date()
                }
                applyAnomalies(p.anomalies)
                AppDelegate.shared?.refreshProofIfShown()
                // Test-mode diagnostics don't require the popover to be open.
                if ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST"] == "1" {
                    AppDelegate.shared?.writeTestProof()
                }
                if cached {
                    // The persisted snapshot makes the first frame useful;
                    // the live pass catches up without competing with it.
                    DispatchQueue.main.async { [weak self] in
                        guard let self, !self.payloadInFlight, !self.pollInFlight else { return }
                        self.refresh()
                    }
                }
            } catch {
                self.refreshFailureCount = min(self.refreshFailureCount + 1, 6)
                let delay = min(300.0, 5.0 * pow(2.0, Double(self.refreshFailureCount - 1)))
                self.nextRefreshRetryAt = Date().addingTimeInterval(delay)
                self.errorText = "Couldn’t refresh latest data · retry in \(countdown(self.nextRefreshRetryAt!))"
                self.errorDetails = error.localizedDescription
                setTitleIfChanged("tokitoki ⚠️")
                dbg("refresh failed: \(error.localizedDescription)")
            }
        }
    }

    /// Guard against redundant NSStatusItem title writes (visibility regression).
    private func setTitleIfChanged(_ newTitle: String) {
        guard newTitle != title else { return }
        title = newTitle
        AppDelegate.shared?.syncButtonTitle(title)
    }

    static func badged(_ base: String, worst: String?) -> String {
        let dot: String
        switch worst {
        case "exceeded": dot = "🔴 "
        case "warn": dot = "🟠 "
        default: dot = ""
        }
        return dot + base
    }

    // MARK: budget state → badge + notifications

    private func applyBudgets(_ rows: [BudgetRow]) {
        dbg("applyBudgets rows=\(rows.count) states=\(rows.map { $0.state })")
        budgets = rows
        var current: [String: Int] = [:]
        var worst = "ok"
        for r in rows {
            current[r.label] = max(current[r.label] ?? 0, r.level)
            if r.level > levelFor(worst) { worst = r.state }
        }
        worstState = rows.isEmpty ? nil : worst
        guard !rows.isEmpty else { return }
        guard notificationsEnabled else {
            lastLevels = current
            return
        }

        // Notify only on transitions INTO warn/exceeded (not while staying there).
        // State is persisted BEFORE attempting delivery so a crash/missing
        // bundle can never cause re-notification spam.
        dbg("levels=\(current) notified=\(notifiedKeys.count)")
        for (label, level) in current where level > 0 {
            let prev = lastLevels[label] ?? 0
            guard level > prev else { continue }
            let row = rows.first { $0.label == label }
            let key = "budget|\(label)|\(level)|\(Self.notificationPeriodKey(label: label))"
            notifyOnce(
                kind: "budget",
                key: key,
                title: "tokitoki budget \(level)%",
                body: "\(label): $\(String(format: "%.2f", row?.used ?? 0)) / $\(String(format: "%.2f", row?.cap ?? 0))",
                reason: "This budget crossed its \(level)% warning threshold.",
            )
        }
        lastLevels = current
    }

    /// Compare persisted quota observations so a restart can still detect a
    /// reset after an exhausted window. Reset timestamps are part of the
    /// notification identity, which prevents repeated alerts in one window.
    private func applyQuotaNotifications(_ limits: [AccountLimits]) {
        var changed = false
        for account in limits {
            for window in account.windows {
                guard let used = window.usedPct else { continue }
                let remaining = max(0, min(100, 100 - used))
                let identity = "\(account.provider)@\(account.accountKey)|\(window.kind)"
                let previous = quotaObservations[identity]
                let resetChanged = previous?.resetAt != nil
                    && window.resetsAt != nil
                    && previous?.resetAt != window.resetsAt
                let recovered = previous.map { $0.remaining <= Double(quotaCriticalPercent) && remaining >= 50 } ?? false
                let display = account.email ?? account.credential ?? account.accountKey
                let name = "\(account.provider) · \(display) · \(windowDisplayName(window.kind, provider: account.provider))"
                let reset = window.resetsAt.map(countdown) ?? "—"

                if notificationsEnabled && remaining <= Double(quotaCriticalPercent) {
                    let key = "quota-critical|\(identity)|\(window.resetsAt ?? "unknown")"
                    notifyOnce(
                        kind: "quotaCritical",
                        key: key,
                        title: "tokitoki quota critical",
                        body: "\(name): \(Int(remaining.rounded()))% left · resets in \(reset)",
                        reason: "The reported \(windowDisplayName(window.kind, provider: account.provider).lowercased()) quota reached your configured critical threshold of \(quotaCriticalPercent)% remaining.",
                    )
                }
                if notificationsEnabled && resetAwareNotifications && (resetChanged || recovered) {
                    let key = "quota-reset|\(identity)|\(window.resetsAt ?? "unknown")"
                    notifyOnce(
                        kind: "quotaReset",
                        key: key,
                        title: "tokitoki quota available",
                        body: "\(name) is available again · \(Int(remaining.rounded()))% left",
                        reason: "This quota was previously exhausted or critical and its provider now reports usable capacity again.",
                    )
                }

                let next = QuotaObservation(remaining: remaining, resetAt: window.resetsAt)
                if previous?.remaining != next.remaining || previous?.resetAt != next.resetAt {
                    quotaObservations[identity] = next
                    changed = true
                }
            }
        }
        if changed { saveQuotaObservations() }
    }

    private func applySpendHealthNotifications(_ health: SpendHealthPayload?) {
        guard notificationsEnabled, burnWarnings, let health,
              let cap = health.monthlyCap,
              let ratio = health.projectedRatio,
              ratio >= burnWarningRatio else { return }
        let level = ratio >= 1 ? 100 : 80
        let key = "burn|\(Self.notificationPeriodKey(label: "monthly"))|\(level)"
        notifyOnce(
            kind: "burnRate",
            key: key,
            title: "tokitoki burn-rate warning",
            body: "Projected $\(String(format: "%.0f", health.projected)) by month end vs $\(String(format: "%.0f", cap)) cap · $\(String(format: "%.2f", health.perDay))/day",
            reason: "Your current month-to-date spend pace projects above the configured warning threshold.",
        )
    }

    private func applyAnomalies(_ payload: AnomaliesPayload?) {
        guard let top = payload?.anomalies.first else { anomalyLine = nil; return }
        anomalyLine = "⚠︎ \(top.day) \(top.metric) \(String(format: "%.1f", top.ratio))× baseline"
    }

    private func levelFor(_ state: String) -> Int {
        state == "exceeded" ? 100 : state == "warn" ? 80 : 0
    }

    // MARK: notifications + persisted dedupe state

    private static var stateFileURL: URL {
        // Mirror the CLI convention (<data-home>/tokitoki/) even when
        // XDG_DATA_HOME is set — never write bare into the data home.
        let xdg = ProcessInfo.processInfo.environment["XDG_DATA_HOME"]
        let base = xdg.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0).appendingPathComponent("tokitoki") }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/tokitoki")
        return base.appendingPathComponent("menubar-state.json")
    }

    private static var quotaStateFileURL: URL {
        stateFileURL.deletingLastPathComponent().appendingPathComponent("menubar-quota-state.json")
    }

    private static func notificationPeriodKey(label: String) -> String {
        let now = Date()
        let calendar = Calendar.current
        if label.contains("monthly") || label.contains("month") {
            return String(format: "%04d-%02d", calendar.component(.year, from: now), calendar.component(.month, from: now))
        }
        if label.contains("weekly") || label.contains("week") {
            return String(format: "%04d-w%02d", calendar.component(.yearForWeekOfYear, from: now), calendar.component(.weekOfYear, from: now))
        }
        return String(format: "%04d-%02d-%02d", calendar.component(.year, from: now), calendar.component(.month, from: now), calendar.component(.day, from: now))
    }

    private static func loadNotifiedKeys() -> Set<String> {
        guard let data = try? Data(contentsOf: stateFileURL) else { return [] }
        if let state = try? JSONDecoder().decode(NotificationState.self, from: data) { return Set(state.keys) }
        if let keys = try? JSONDecoder().decode([String].self, from: data) { return Set(keys) }
        return []
    }

    private static func loadNotificationHistory() -> [NotificationRecord] {
        guard let data = try? Data(contentsOf: stateFileURL),
              let state = try? JSONDecoder().decode(NotificationState.self, from: data) else { return [] }
        return state.history
    }

    private func saveNotifiedKeys() {
        let url = Self.stateFileURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let state = NotificationState(keys: Array(notifiedKeys).sorted(), history: notificationHistory)
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: url)
        }
    }

    private static func loadQuotaObservations() -> [String: QuotaObservation] {
        guard let data = try? Data(contentsOf: quotaStateFileURL),
              let observations = try? JSONDecoder().decode([String: QuotaObservation].self, from: data) else { return [:] }
        return observations
    }

    private func saveQuotaObservations() {
        let url = Self.quotaStateFileURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(quotaObservations) {
            try? data.write(to: url)
        }
    }

    private func notifyOnce(kind: String, key: String, title: String, body: String, reason: String) {
        guard !disabledNotifications.contains(kind) else { return }
        guard !notifiedKeys.contains(key) else { return }
        notifiedKeys.insert(key)
        let record = NotificationRecord(
            id: key,
            at: ISO8601DateFormatter().string(from: Date()),
            title: title,
            body: body,
            reason: reason,
            kind: kind,
        )
        notificationHistory = Array(([record] + notificationHistory).prefix(50))
        saveNotifiedKeys()
        dbg("notification · \(key) · state-file=\(Self.stateFileURL.path)")
        deliverNotification(title: title, body: body)
    }

    private func deliverNotification(title: String, body: String) {
        // The development/release binary is intentionally a bare LaunchAgent
        // executable, so it has no bundle identifier. Use native UN alerts
        // for a bundled build and an osascript fallback for the installed
        // binary instead of silently dropping every notification.
        guard Bundle.main.bundleIdentifier != nil else {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-e", "display notification \(appleScriptQuote(body)) with title \(appleScriptQuote(title))"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            return
        }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return } // badge already reflects the state
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request)
        }
    }

    private func appleScriptQuote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    static func baseTitle(for p: ReportPayload) -> String {
        if p.total.costUsd > 0 { return String(format: "$%.2f", p.total.costUsd) }
        return humanCount(Double(p.total.requests)) + " req"
    }

    // MARK: status-item preview lines (CodexBar-style per-provider %s)

    static func shortTag(_ provider: String) -> String {
        switch provider {
        case "claude-code": return "cc"
        case "codex": return "cx"
        case "openrouter": return "or"
        case "opencode-go", "opencode": return "oc"
        case "gemini-cli": return "gm"
        case "cursor": return "cu"
        case "grok": return "gk"
        default: return String(provider.prefix(2))
        }
    }


    /// Primary window for a card/bar: first with a real quota denominator,
    /// else the first window. Mirrors the popover hero logic.
    /// Upstream provider (openai/claude/opencode/openrouter/…) for strip
    /// grouping — harnesses (pi, codex, claude-code) are just clients.
    static func upstreamProvider(_ l: AccountLimits) -> String? {
        switch l.provider {
        case "codex": return "openai"
        case "claude-code": return "claude"
        case "gemini-cli": return "gemini"
        case "grok": return "grok"
        case "cursor": return "cursor"
        case "copilot": return "copilot"
        case "openrouter": return "openrouter"
        case "pi", "opencode", "opencode-go":
            let key = l.accountKey.lowercased()
            if key.contains("openrouter") { return "openrouter" }
            if key.contains("opencode") { return "opencode" }
            return nil
        default: return nil
        }
    }

    /// Build strip groups: stacked real percentages when any account in the
    /// group reports a quota; otherwise one "~NN%" estimate from the group's
    /// usage relative to the busiest same-kind window across all accounts
    /// (same normalization as the card bars — an ESTIMATE, tilde-marked).
    static func stripGroups(
        from limits: [AccountLimits],
        metric: String,
        previewHidden: Set<String>,
        exhaustedBehavior: String = "show",
    ) -> [(provider: String, lines: [String])] {
        var maxima: [String: Double] = [:]
        for l in limits {
            for w in l.windows { maxima[w.kind] = max(maxima[w.kind] ?? 0, w.tokens) }
        }

        struct AccountPreview {
            let percentLines: [String]
            let smartLine: String
        }
        struct Group {
            var accounts: [AccountPreview] = []
            var estByKind: [String: Double] = [:]
        }
        var order: [String] = []
        var groups: [String: Group] = [:]
        for l in limits {
            guard let up = upstreamProvider(l) else { continue }
            if previewHidden.contains(up) { continue } // strip-only visibility
            if groups[up] == nil {
                groups[up] = Group()
                order.append(up)
            }
            var accountPcts: [Int] = []
            var accountResets: [Date] = []
            for w in l.windows {
                if let pct = w.usedPct {
                    let remaining = Int(max(0, min(100, 100 - pct)).rounded())
                    accountPcts.append(remaining)
                    if remaining == 0, let reset = w.resetsAt, let date = parseISO(reset) {
                        accountResets.append(date)
                    }
                }
                groups[up]!.estByKind[w.kind, default: 0] += w.tokens
            }
            if metric != "tokens" && !accountPcts.isEmpty {
                let percentLines: [String]
                if let nextReset = nextUnblockingReset(
                    pcts: accountPcts,
                    resets: accountResets,
                    exhaustedBehavior: exhaustedBehavior
                ) {
                    percentLines = [countdown(nextReset)]
                } else if exhaustedBehavior == "hide" && accountPcts.allSatisfy({ $0 == 0 }) {
                    percentLines = []
                } else {
                    percentLines = accountPcts.map { "\($0)%" }
                }
                if !percentLines.isEmpty {
                    let smartLine = nextUnblockingReset(
                        pcts: accountPcts,
                        resets: accountResets,
                        exhaustedBehavior: "reset"
                    ).map(countdown) ?? "\(accountPcts.min()!)%"
                    groups[up]!.accounts.append(AccountPreview(
                        percentLines: percentLines,
                        smartLine: smartLine
                    ))
                }
            }
        }

        let kindPriority = ["week", "month", "day"]
        return order.compactMap { up -> (provider: String, lines: [String])? in
            let g = groups[up]!
            if metric == "tokens" {
                // Uniform tokens mode: every group shows exactly one usage line.
                for kind in kindPriority {
                    let tokens = g.estByKind[kind] ?? 0
                    if tokens > 0 {
                        return (up, ["~\(humanCount(tokens))"])
                    }
                }
                return nil
            }
            if metric == "smart" {
                return g.accounts.isEmpty ? nil : (up, g.accounts.map(\.smartLine))
            }
            // Percent mode keeps one line per real account. This prevents a
            // second Codex login from disappearing behind a provider-level
            // window limit and lets an exhausted session show its own next
            // unblocking reset even when another account remains healthy.
            guard !g.accounts.isEmpty else { return nil }
            return (up, g.accounts.flatMap(\.percentLines))
        }
    }

    /// Return the reset that makes an account usable again. If another quota
    /// window still has headroom, the earliest exhausted-window reset is the
    /// useful answer. If every reported window is exhausted, all constraints
    /// must clear, so the latest reset governs.
    private static func nextUnblockingReset(
        pcts: [Int],
        resets: [Date],
        exhaustedBehavior: String,
    ) -> Date? {
        guard exhaustedBehavior == "reset", pcts.contains(0), !resets.isEmpty else { return nil }
        return pcts.allSatisfy({ $0 == 0 }) ? resets.max() : resets.min()
    }

    /// Context-menu visibility items grouped by UPSTREAM provider.
    struct VisibilityItem {
        let display: String
        let targets: [String]
        let anyVisible: Bool
    }

    /// Optimistic visibility flip for the context menu (config confirms later).
    func applyVisibility(_ targets: [String], visible: Bool) {
        var set = menubarHidden
        if visible {
            for t in targets { set.remove(t) }
        } else {
            for t in targets { set.insert(t) }
        }
        menubarHidden = set
    }

    func providerVisibilityItems() -> [VisibilityItem]? {
        guard !limits.isEmpty else { return nil }
        var order: [String] = []
        var byUp: [String: [AccountLimits]] = [:]
        for l in limits {
            let up = Self.upstreamProvider(l) ?? l.provider
            if byUp[up] == nil { order.append(up) }
            byUp[up, default: []].append(l)
        }
        var harnessTotals: [String: Int] = [:]
        for l in limits { harnessTotals[l.provider, default: 0] += 1 }

        func targetIsVisible(_ t: String) -> Bool {
            if menubarHidden.contains(t) { return false }
            if t.contains(":") {
                let h = String(t.split(separator: ":")[0])
                if menubarHidden.contains(h) { return false }
            }
            return true
        }

        return order.sorted().map { up in
            let ls = byUp[up]!
            var byHarness: [String: [AccountLimits]] = [:]
            for l in ls { byHarness[l.provider, default: []].append(l) }
            var targets: [String] = []
            for (harness, accs) in byHarness {
                if accs.count == harnessTotals[harness] {
                    targets.append(harness) // whole harness belongs to this provider
                } else {
                    for a in accs { targets.append("\(harness):\(a.accountKey)") }
                }
            }
            return VisibilityItem(
                display: up,
                targets: targets.sorted(),
                anyVisible: targets.contains(where: targetIsVisible),
            )
        }
    }

    /// Recompute + publish the status-item strip from current state
    /// (used by immediate-apply paths like customize toggles).
    func rebuildStripPreview() {
        previewGroups = Self.stripGroups(
            from: limits,
            metric: stripMetric,
            previewHidden: previewHidden,
            exhaustedBehavior: stripExhausted,
        )
    }

    func setPreviewMode(_ value: String) {
        previewMode = value == "hover" ? "hover" : "inline"
        let preview = Self.previewText(
            currentPayloadForTitle?.limits ?? limits,
            cfg: currentPreviewCfg,
            labeled: previewMode == "hover",
        )
        setTitleIfChanged(composeTitle(today: currentPayloadForTitle?.today, preview: preview, hovering: isHovering, mode: previewMode))
        persistUISetting(path: "ui.menubarPreviewMode", json: "\"\(previewMode)\"")
    }

    func setStripMetric(_ value: String) {
        stripMetric = ["tokens", "smart"].contains(value) ? value : "percent"
        rebuildStripPreview()
        persistUISetting(path: "ui.stripMetric", json: "\"\(stripMetric)\"")
    }

    func setStripExhausted(_ value: String) {
        stripExhausted = ["show", "hide", "reset"].contains(value) ? value : "reset"
        rebuildStripPreview()
        persistUISetting(path: "ui.stripExhausted", json: "\"\(stripExhausted)\"")
    }

    func setPreviewVisible(_ provider: String, visible: Bool) {
        if visible { previewHidden.remove(provider) } else { previewHidden.insert(provider) }
        invalidateRefreshes()
        rebuildStripPreview()
        let json = "[" + previewHidden.sorted().map { "\"\($0)\"" }.joined(separator: ",") + "]"
        persistUISetting(path: "ui.previewHidden", json: json)
    }

    private func persistUISetting(path: String, json: String) {
        let cli = invocation
        Task { @MainActor [weak self] in
            do {
                _ = try await Self.runConfigCLI(cli, ["config", "set", path, json])
            } catch {
                self?.pollStatus = "Could not save setting: \(error.localizedDescription)"
            }
        }
    }

    static func primaryWindow(_ l: AccountLimits) -> LimitWindow? {
        l.windows.first { $0.usedPct != nil } ?? l.windows.first
    }

    /// Status-item preview: per account, every quota-bearing window's remaining
    /// percentage. Hover mode labels each value so session/weekly/monthly are
    /// not ambiguous; compact inline mode keeps the old short form.
    static func previewText(_ limits: [AccountLimits], cfg: UiPreviewConfig?, labeled: Bool = false) -> String? {
        let maxLines = cfg?.previewLines ?? 3
        guard maxLines > 0 else { return nil }
        var groups: [String] = []
        for l in limits {
            let pcts = l.windows.compactMap { w -> String? in
                guard let pct = w.usedPct else { return nil }
                let remaining = Int(max(0, min(100, 100 - pct)).rounded())
                guard labeled else { return "\(remaining)%" }
                let label: String
                switch w.kind {
                case "day": label = (l.provider == "codex" || l.provider == "claude-code") ? "session" : "day"
                case "week": label = "weekly"
                case "month": label = "monthly"
                default: label = w.kind
                }
                return "\(label) \(remaining)%"
            }
            if !pcts.isEmpty { groups.append(pcts.joined(separator: " ")) }
            if groups.count >= maxLines { break }
        }
        guard !groups.isEmpty else { return nil }
        return groups.prefix(maxLines).joined(separator: " · ")
    }

    func composeTitle(today: ReportPayload?, preview: String?, hovering: Bool, mode: String) -> String {
        guard let preview, mode != "hover" || hovering else { return "tokitoki" }
        return preview
    }

    /// Hover expansion seam (hover-only preview mode + tests).
    @Published var isHovering: Bool = false {
        didSet {
            guard oldValue != isHovering else { return }
            let p = currentPayloadForTitle
            let t = composeTitle(today: p?.today,
                                 preview: Self.previewText(p?.limits ?? [], cfg: currentPreviewCfg, labeled: previewMode == "hover"),
                                 hovering: isHovering,
                                 mode: previewMode)
            setTitleIfChanged(t)
        }
    }
    var currentPayloadForTitle: MenubarPayload?
    var currentPreviewCfg: UiPreviewConfig?
    var trackingArea: NSTrackingArea?

    nonisolated static func runJSON<T: Decodable>(_ type: T.Type, _ cli: CLIInvocation, _ args: [String]) async throws -> T? {
        let out = try await runCLI(cli, args)
        guard !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let data = out.data(using: .utf8) else { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Serialize all config-mutating CLI calls. Each CLI invocation does a
    /// whole-file read/modify/write; concurrent calls otherwise lose updates.
    private static let configWriteQueue = DispatchQueue(label: "dev.tokitoki.config-writes", qos: .utility)

    static func runConfigCLI(_ cli: CLIInvocation, _ args: [String]) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            configWriteQueue.async {
                runCLIProcess(cli, args, continuation: cont)
            }
        }
    }

    static func runCLI(_ cli: CLIInvocation, _ args: [String]) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                runCLIProcess(cli, args, continuation: cont)
            }
        }
    }

    nonisolated private static func runCLIProcess(
        _ cli: CLIInvocation,
        _ args: [String],
        continuation cont: CheckedContinuation<String, Error>,
    ) {
        let proc = Process()
        proc.executableURL = cli.executable
        proc.arguments = cli.prefixArgs + args
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("tokitoki-cli-\(UUID().uuidString).out")
        let errorURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("tokitoki-cli-\(UUID().uuidString).err")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        FileManager.default.createFile(atPath: errorURL.path, contents: nil)
        defer {
            try? FileManager.default.removeItem(at: outputURL)
            try? FileManager.default.removeItem(at: errorURL)
        }
        do {
            guard let outputHandle = FileHandle(forWritingAtPath: outputURL.path),
                  let errorHandle = FileHandle(forWritingAtPath: errorURL.path) else {
                throw NSError(domain: "tokitoki", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create CLI output files"])
            }
            proc.standardOutput = outputHandle
            proc.standardError = errorHandle
            try proc.run()
            proc.waitUntilExit()
            try? outputHandle.close()
            try? errorHandle.close()
            let data = (try? Data(contentsOf: outputURL)) ?? Data()
            if proc.terminationStatus == 0 {
                cont.resume(returning: String(data: data, encoding: .utf8) ?? "")
            } else {
                let errorData = (try? Data(contentsOf: errorURL)) ?? Data()
                let raw = String(data: errorData, encoding: .utf8) ?? "exit \(proc.terminationStatus)"
                let msg = Self.conciseCLIError(raw)
                cont.resume(throwing: NSError(domain: "tokitoki", code: 1, userInfo: [NSLocalizedDescriptionKey: msg]))
            }
        } catch {
            cont.resume(throwing: error)
        }
    }

    /// CLI stderr may contain a Bun/SQLite stack trace. Menubar status rows
    /// need one actionable sentence, not hundreds of implementation lines.
    nonisolated static func conciseCLIError(_ raw: String) -> String {
        let oneLine = raw
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if oneLine.contains(where: { $0.contains("SQLITE_BUSY") || $0.contains("database is locked") }) {
            return "database busy; the next refresh will retry automatically"
        }
        if let error = oneLine.first(where: { $0.hasPrefix("error:") }) {
            return String(error.dropFirst("error:".count)).trimmingCharacters(in: .whitespaces)
        }
        if let sqlite = oneLine.first(where: { $0.hasPrefix("SQLiteError") }) { return sqlite }
        return oneLine.first ?? "CLI failed (exit status unknown)"
    }

}

private func humanCount(_ n: Double) -> String {
    switch abs(n) {
    case 1_000_000_000...: return String(format: "%.2fB", n / 1_000_000_000)
    case 1_000_000...: return String(format: "%.2fM", n / 1_000_000)
    case 1_000...: return String(format: "%.2fk", n / 1_000)
    default: return String(Int(n))
    }
}

// MARK: - AppKit shell (NSStatusItem + NSPopover)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?

    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var popoverHost: NSHostingController<AnyView>?
    private var monitors: [Any] = []
    private var testContextObserver: NSObjectProtocol?
    private var dashboardProcess: Process?
    /// A detached stdio MCP process is only a health/lifecycle indicator;
    /// real agents own their own stdio connection.
    private var mcpProcess: Process?
    private var mcpInput: Pipe?
    private let hoverPopover = NSPopover()
    private let hoverActivationDelay: TimeInterval = 0.15
    private var hoverWorkItem: DispatchWorkItem?
    private var popoverContentLoaded = false
    private var popoverContentLoadScheduled = false
    var model: Model?

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        NSApp.setActivationPolicy(.accessory)

        guard let model = model else {
            FileHandle.standardError.write(Data("[tokitoki-menubar] no model\n".utf8)); return
        }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = model.title
        item.button?.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize - 1, weight: .regular)
        item.button?.target = self
        item.button?.action = #selector(statusItemAction(_:))
        // NSStatusBarButton swallows right-clicks by default; without this
        // the currentEvent routing in statusItemAction never sees them and
        // the context menu is unreachable.
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        statusItem = item
        FileHandle.standardError.write(Data(
            "[tokitoki-menubar] statusItem created · button=\(item.button != nil ? "ok" : "NIL") title=[\(model.title)]\n".utf8))

        // Keep the first AppKit layout tiny. ContentView contains charts,
        // lists, and several SwiftUI sheets; constructing it before the first
        // frame made an otherwise idle click occasionally wait for a full
        // main-actor layout pass.
        let host = NSHostingController(rootView: AnyView(PopoverLaunchView(model: model)))
        popoverHost = host
        popover.contentViewController = host
        hoverPopover.behavior = .transient
        hoverPopover.animates = false
        hoverPopover.contentViewController = NSHostingController(rootView: HoverPreviewView(model: model))
        // .transient: AppKit's own outside-click dismissal — works for real
        // user clicks without any TCC permissions. Synthetic HID events don't
        // route here (they never activate the accessory app), so tests use
        // the dev.tokitoki.menubar.close distributed notification instead.
        // Under the e2e env flag, pin it open (.applicationDefined): the
        // synthetic AX click steals focus back and .transient would dismiss
        // the panel before the paint assertions can screenshot it.
        popover.behavior = ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST"] == "1"
            ? .applicationDefined
            : .transient
        popover.animates = false

        installEventMonitors()
        if ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST_CONTEXT"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.showTestContextMenu() }
        }
        if ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST"] == "1" {
            testContextObserver = DistributedNotificationCenter.default.addObserver(
                forName: Notification.Name("dev.tokitoki.menubar.context"), object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, let button = self.statusItem?.button else { return }
                    self.showContextMenu(for: button, event: nil)
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Only terminate a web server this app launched itself. If a user
        // started `tokitoki web` separately, dashboardProcess is nil and the
        // existing server remains available for other clients.
        if dashboardProcess?.isRunning == true {
            dashboardProcess?.terminate()
        }
        if mcpProcess?.isRunning == true { mcpProcess?.terminate() }
    }

    func showTestContextMenu() {
        guard let button = statusItem?.button else { return }
        // Leave a deterministic, non-user-facing proof for the e2e harness:
        // AX cannot enumerate an NSMenu while it is owned by WindowServer.
        let labels = ["Open Dashboard", "Open Reports", "Open Sources", "Refresh Now", "Start at Login", "Quit tokitoki"]
        if let data = try? JSONSerialization.data(withJSONObject: labels) {
            try? data.write(to: URL(fileURLWithPath: "/tmp/tokitoki-menubar.context-menu.json"))
        }
        showContextMenu(for: button, event: nil)
    }

    /// Close the popover when the user clicks outside it (or presses Escape).
    /// .applicationDefined behavior means AppKit won't do this for us, and
    /// accessory-app key-window tracking is unreliable — hence the monitors.
    private func installEventMonitors() {
        // Local monitor: escape reaches us when the popover is key (real usage).
        if let local = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            guard let self else { return event }
            if self.popover.isShown && event.keyCode == 53 {
                self.popover.performClose(nil)
                return nil
            }
            return event
        }) {
            monitors.append(local)
        }
        // NSStatusItem does not route a secondary click through its target
        // action. A global monitor catches the real user right-click while
        // the hit-test keeps unrelated desktop clicks untouched.
        if let global = NSEvent.addGlobalMonitorForEvents(matching: [.rightMouseUp], handler: { [weak self] event in
            guard let self, let button = self.statusItem?.button, let window = button.window else { return }
            let point = event.locationInWindow
            guard window.frame.contains(point) else { return }
            self.showContextMenu(for: button, event: event)
        }) {
            monitors.append(global)
        }
    }

    @objc func closePopover() {
        FileHandle.standardError.write(Data("[tokitoki-menubar] closePopover fired\n".utf8))
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            FileHandle.standardError.write(Data("[tokitoki-menubar] pre-close isShown=\(self.popover.isShown)\n".utf8))
            self.popover.performClose(nil)
            self.popover.close()
            // Known bare-binary quirk: the popover window can linger on screen
            // after a logical close (isShown=false but window still composited).
            // Force-order it out and mark the popover as fully detached.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                if let w = self.popover.contentViewController?.view.window {
                    FileHandle.standardError.write(Data("[tokitoki-menubar] force ordering out lingering popover window\n".utf8))
                    w.orderOut(nil)
                }
            }
        }
    }

    private static var logoImageCache: [String: NSImage] = [:]

    /// Render a ProviderLogo into a small NSImage for inline use.
    private func logoImage(_ provider: String) -> NSImage? {
        if let cached = Self.logoImageCache[provider] { return cached }
        let renderer = ImageRenderer(content: ProviderLogo(provider: provider))
        renderer.scale = 2
        guard let img = renderer.nsImage else { return nil }
        Self.logoImageCache[provider] = img
        return img
    }

    /// Last rendered strip image; identical content skips the button set (an
    /// unconditional set still costs a WindowServer redraw).
    private static var lastStrip: (fingerprint: String, image: NSImage?)?

    /// openusage-style status item: provider marks + bare percentages rendered
    /// as a MONOCHROME template image (black on clear, isTemplate=true) so macOS
    /// tints it correctly for light/dark and it never reads as colored. Falls
    /// back to the plain text title when no preview data is available.
    private func applyTemplateStrip(fallback: String) {
        guard let button = statusItem?.button else { return }
        guard let model else { return }
        let showPreview = model.previewMode != "hover" || model.isHovering
        let entries = showPreview ? model.previewGroups : []

        // Fingerprint of everything the strip renders, for memoization.
        let fingerprint = entries.map { "\($0.provider):\($0.lines.joined(separator: "+"))" }.joined(separator: ",")
            + "|\(fallback.hasPrefix("🔴") ? "x" : fallback.hasPrefix("🟠") ? "w" : "-")"

        if let last = Self.lastStrip, last.fingerprint == fingerprint {
            if let img = last.image { button.image = img; button.title = "" } else { button.image = nil; button.title = fallback }
            refreshHoverMonitor()
            return
        }

        var badgeKind: String? = nil
        if fallback.hasPrefix("🔴") { badgeKind = "exceeded" }
        else if fallback.hasPrefix("🟠") { badgeKind = "warn" }

        var content: NSImage? = nil
        if !entries.isEmpty {
            content = Self.renderStrip(groups: entries, badge: badgeKind)
        }

        Self.lastStrip = (fingerprint, content)
        if let img = content {
            button.image = img
            button.title = ""
            button.toolTip = model.previewMode == "hover"
                ? "Hover for quota summary · click for details"
                : entries.map { "\($0.provider): \($0.lines.joined(separator: " · "))" }.joined(separator: "\n")
        } else {
            button.image = nil
            button.title = fallback
            button.toolTip = nil
        }
        refreshHoverMonitor()
    }


    /// Render [mark] 94%\n43%  [mark] 44% … as black-on-clear SwiftUI (one
    /// mark per provider, that provider's percentages STACKED vertically at a
    /// slightly smaller size — openusage pattern), rasterize via ImageRenderer,
    /// trim transparent margins, and wrap in a template NSImage.
    static func renderStrip(groups: [(provider: String, lines: [String])], badge: String?) -> NSImage? {
        struct Strip: View {
            let groups: [(provider: String, lines: [String])]
            let badge: String?
            var body: some View {
                HStack(spacing: 7) {
                    if let badge {
                        Image(systemName: badge == "exceeded" ? "exclamationmark.circle.fill" : "exclamationmark.circle")
                    }
                    ForEach(Array(groups.enumerated()), id: \.offset) { i, g in
                        if i > 0 { Text("·") }
                        HStack(spacing: 4) {
                            MonoMark(provider: g.provider)
                                .frame(width: 10, height: 10)
                            VStack(alignment: .leading, spacing: -1) {
                                ForEach(Array(g.lines.enumerated()), id: \.offset) { _, line in
                                    Text(line)
                                        .font(.system(size: 9.5, weight: .semibold))
                                        .monospacedDigit()
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
                .foregroundStyle(Color.black)
            }
        }
        let renderer = ImageRenderer(content: Strip(groups: groups, badge: badge))
        renderer.scale = 2
        guard let cg = renderer.cgImage else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / 2, height: CGFloat(cg.height) / 2))
        image.isTemplate = true
        return image
    }

    func syncButtonTitle(_ title: String) {
        applyTemplateStrip(fallback: title)
        refreshHoverMonitor()
    }

    /// Hover detection for preview expansion: accessory status-item buttons
    /// aren't NSViews we own, so tracking areas don't fire — a global
    /// mouse-moved monitor hit-testing the button frame is deterministic.
    private var hoverMonitor: Any?
    private func refreshHoverMonitor() {
        let preserveHoverPopover = model?.previewMode == "hover" && model?.isHovering == true
        if let hoverMonitor { NSEvent.removeMonitor(hoverMonitor); self.hoverMonitor = nil }
        hoverWorkItem?.cancel()
        hoverWorkItem = nil
        if !preserveHoverPopover { hideHoverPopover() }
        guard model?.previewMode == "hover", statusItem?.button != nil else { return }
        if preserveHoverPopover {
            DispatchQueue.main.async { [weak self] in self?.showHoverPopover() }
        }
        hoverMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseUp, .rightMouseUp]) { [weak self] event in
            guard let self, let button = self.statusItem?.button,
                  let window = button.window else { return }
            let inside = window.frame.contains(NSEvent.mouseLocation)
            DispatchQueue.main.async {
                guard let model = self.model else { return }
                if inside {
                    guard !model.isHovering, self.hoverWorkItem == nil else { return }
                    let work = DispatchWorkItem { [weak self] in
                        guard let self, let model = self.model else { return }
                        self.hoverWorkItem = nil
                        model.isHovering = true
                        self.showHoverPopover()
                    }
                    self.hoverWorkItem = work
                    DispatchQueue.main.asyncAfter(deadline: .now() + self.hoverActivationDelay, execute: work)
                } else {
                    self.hoverWorkItem?.cancel()
                    self.hoverWorkItem = nil
                    model.isHovering = false
                    self.hideHoverPopover()
                }
            }
        }
    }

    private func showHoverPopover() {
        guard let button = statusItem?.button, let model, !popover.isShown else { return }
        hoverPopover.contentViewController = NSHostingController(rootView: HoverPreviewView(model: model))
        hoverPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
        positionPopoverBelowStatusItem(hoverPopover, button: button)
    }

    private func hideHoverPopover() {
        if hoverPopover.isShown { hoverPopover.performClose(nil) }
    }

    @objc private func statusItemAction(_ sender: Any?) {
        FileHandle.standardError.write(Data("[tokitoki-menubar] statusItemAction fired\n".utf8))
        guard let button = statusItem?.button else { return }
        hideHoverPopover()
        if let event = NSApp.currentEvent,
           event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
            showContextMenu(for: button, event: event)
            return
        }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            // Accessory apps must activate before showing or the popover
            // never becomes key — synthetic AND real outside clicks/escapes
            // then fail to close it.
            NSApp.activate(ignoringOtherApps: true)
            updatePopoverSize(for: button)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
            positionPopoverBelowStatusItem(popover, button: button)
            FileHandle.standardError.write(Data("[tokitoki-menubar] popover.show called · shown=\(popover.isShown)\n".utf8))
            popover.contentViewController?.view.window?.makeKey()
            loadPopoverContentIfNeeded()
            writePopoverProof()
        }
    }

    private func loadPopoverContentIfNeeded() {
        guard !popoverContentLoaded, !popoverContentLoadScheduled, let model else { return }
        popoverContentLoadScheduled = true
        // Let WindowServer paint the lightweight launch state before asking
        // SwiftUI to build the full view tree.
        DispatchQueue.main.async { [weak self, weak model] in
            guard let self, let model else { return }
            guard self.popover.isShown else {
                self.popoverContentLoadScheduled = false
                return
            }
            self.popoverContentLoadScheduled = false
            self.popoverContentLoaded = true
            // Keep the same hosting controller/window. Replacing the view
            // controller after show made AppKit calculate the first anchor
            // from the launch shell and then leave the real popover offset.
            self.popoverHost?.rootView = AnyView(ContentView(model: model))
            if let button = self.statusItem?.button { self.updatePopoverSize(for: button) }
            self.popover.contentViewController?.view.layoutSubtreeIfNeeded()
            // The content swap can change the hosting view's intrinsic size.
            // Re-apply the same below-the-menubar anchor after layout so the
            // first open cannot retain the launch shell's off-screen origin.
            if let button = self.statusItem?.button {
                self.popover.show(relativeTo: button.bounds, of: button, preferredEdge: .maxY)
                self.positionPopoverBelowStatusItem(self.popover, button: button)
            }
            self.popover.contentViewController?.view.window?.makeKey()
        }
    }

    /// Keep the popover inside the current screen's usable area while giving
    /// dense views more room than the old hard-coded 400×700 rectangle.
    private func updatePopoverSize(for button: NSStatusBarButton) {
        let visible = button.window?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame
        let width = min(520, max(400, (visible?.width ?? 1440) * 0.30))
        let height = min(860, max(560, (visible?.height ?? 900) * 0.80))
        popover.contentSize = NSSize(width: width, height: height)
    }

    /// NSPopover's automatic edge selection can place a tall panel above the
    /// menu bar on the first layout pass. Explicitly pin its window below the
    /// status item, inside the screen's usable frame, after AppKit has created
    /// the window. This also keeps the launch-shell -> ContentView swap from
    /// inheriting an off-screen origin.
    private func positionPopoverBelowStatusItem(_ panel: NSPopover, button: NSStatusBarButton) {
        let apply = {
            guard let window = panel.contentViewController?.view.window,
                  let screen = button.window?.screen ?? NSScreen.main else { return }
            let visible = screen.visibleFrame
            let buttonRect = button.window?.convertToScreen(button.frame)
            let size = window.frame.size
            let preferredX = (buttonRect?.midX ?? visible.midX) - size.width / 2
            let x = min(max(preferredX, visible.minX), visible.maxX - size.width)
            let y = visible.maxY - size.height
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
        apply()
        // AppKit may perform one more positioning pass after `show` returns;
        // repeat on the next run-loop turn so the explicit origin wins.
        DispatchQueue.main.async(execute: apply)
    }

    /// Deterministic e2e proof of what the popover renders (AX cannot see
    /// inside SwiftUI on accessory apps reliably). Written on every open.
    func refreshProofIfShown() {
        guard popover.isShown else { return }
        writePopoverProof()
    }

    func writeTestProof() { writePopoverProof() }

    private func writePopoverProof() {
        guard ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST"] == "1",
              let model else { return }
        // Payload may not have completed its first fetch yet — never trap.
        let hasPie = (model.today?.rows.isEmpty == false)
        let proof: [String: Any] = [
            "sections": ["limits", "pie", "tokens", "history", "providers", "budgets", "mcp"],
            "views": PopoverSubview.allCases.map(\.title),

            "accounts": model.limits.map { "\($0.provider)@\($0.accountKey)" },
            "todayRows": model.today?.rows.count ?? 0,
            "hasPie": hasPie,
            "hasHistory": model.history?.days.isEmpty == false,
            "previewGroups": model.previewGroups.map { ["provider": $0.provider, "lines": $0.lines] },
            "limitCards": model.limits.count,
            // Diagnostics: what each card actually renders for its primary window.
            "countdowns": model.limits.reduce(into: [:]) { acc, l in
                let p = Model.primaryWindow(l)
                acc["\(l.provider)@\(l.accountKey)"] = [
                    "resetsAt": p?.resetsAt ?? "nil",
                    "countdown": countdown(p?.resetsAt),
                    "usedPct": p?.usedPct as Any,
                ]
            },
        ]
        if let data = try? JSONSerialization.data(withJSONObject: proof, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "/tmp/tokitoki-menubar.popover.json"))
        }
    }

    private func showContextMenu(for button: NSStatusBarButton, event: NSEvent?) {
        let menu = NSMenu()
        menu.autoenablesItems = false

        // Keep the context menu scannable: one primary browser action and
        // grouped maintenance/preferences submenus. The full destinations are
        // also available as tabs in the popover.
        let dashboard = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        dashboard.target = self
        menu.addItem(dashboard)
        let refresh = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)

        let browser = NSMenuItem(title: "Open in Browser", action: nil, keyEquivalent: "")
        let browserSub = NSMenu()
        browserSub.autoenablesItems = false
        let reports = NSMenuItem(title: "Reports", action: #selector(openReports), keyEquivalent: "")
        reports.target = self
        browserSub.addItem(reports)
        let sources = NSMenuItem(title: "Sources", action: #selector(openSources), keyEquivalent: "")
        sources.target = self
        browserSub.addItem(sources)
        browserSub.addItem(.separator())
        for item in (model?.providerVisibilityItems() ?? []).sorted(by: { $0.display < $1.display }) {
            if let url = upstreamConsoleURL(item.display) {
                let mi = NSMenuItem(title: "\(item.display) Console", action: #selector(openUpstreamConsole(_:)), keyEquivalent: "")
                mi.representedObject = url.absoluteString
                mi.target = self
                browserSub.addItem(mi)
            }
        }
        browser.submenu = browserSub
        menu.addItem(browser)

        let actions = NSMenuItem(title: "Actions", action: nil, keyEquivalent: "")
        let actionSub = NSMenu()
        actionSub.autoenablesItems = false
        let rescan = NSMenuItem(title: "Re-scan all sources", action: #selector(rescanAll), keyEquivalent: "")
        rescan.target = self
        actionSub.addItem(rescan)
        let poll = NSMenuItem(title: "Refresh provider quotas", action: #selector(pollNow), keyEquivalent: "")
        poll.target = self
        actionSub.addItem(poll)
        actionSub.addItem(.separator())
        let polling = NSMenuItem(title: "Background polling", action: nil, keyEquivalent: "")
        let pollingSub = NSMenu()
        pollingSub.autoenablesItems = false
        let enablePolling = NSMenuItem(title: "Enabled", action: #selector(enablePolling), keyEquivalent: "")
        enablePolling.state = model?.pollAuto == true ? .on : .off
        enablePolling.target = self
        let disablePolling = NSMenuItem(title: "Disabled", action: #selector(disablePolling), keyEquivalent: "")
        disablePolling.state = model?.pollAuto == true ? .off : .on
        disablePolling.target = self
        pollingSub.addItem(enablePolling)
        pollingSub.addItem(disablePolling)
        polling.submenu = pollingSub
        actionSub.addItem(polling)
        actionSub.addItem(.separator())
        let mcp = NSMenuItem(title: "Copy MCP connection config", action: #selector(copyMCPConfig), keyEquivalent: "")
        mcp.target = self
        actionSub.addItem(mcp)
        actions.submenu = actionSub
        menu.addItem(actions)

        // Settings ▸ menubar visibility per UPSTREAM provider plus login.
        if let items = model?.providerVisibilityItems() {
            let settings = NSMenuItem(title: "Menubar Providers", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            sub.autoenablesItems = false
            for item in items {
                let toggle = NSMenuItem(title: item.display, action: #selector(toggleProviderVisibility(_:)), keyEquivalent: "")
                toggle.representedObject = item.targets
                toggle.state = item.anyVisible ? .on : .off
                toggle.target = self
                sub.addItem(toggle)
            }
            settings.submenu = sub
            menu.addItem(settings)
        }

        let preferences = NSMenuItem(title: "Preferences", action: nil, keyEquivalent: "")
        let preferenceSub = NSMenu()
        preferenceSub.autoenablesItems = false
        let login = NSMenuItem(title: "Start at Login", action: #selector(toggleStartAtLogin), keyEquivalent: "")
        login.state = isStartAtLogin ? .on : .off
        login.target = self
        preferenceSub.addItem(login)
        preferences.submenu = preferenceSub
        menu.addItem(preferences)
        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit tokitoki", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        if let event {
            NSMenu.popUpContextMenu(menu, with: event, for: button)
        } else {
            _ = menu.popUp(positioning: nil, at: button.bounds.origin, in: button)
        }
    }

    private var launchAgentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/dev.tokitoki.menubar.plist")
    }

    private var isStartAtLogin: Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["list", "dev.tokitoki.menubar"]
        return (try? task.run()).map { task.waitUntilExit(); return task.terminationStatus == 0 } ?? false
    }

    private func upstreamConsoleURL(_ provider: String) -> URL? {
        switch provider {
        case "openai": return URL(string: "https://platform.openai.com/usage")
        case "claude": return URL(string: "https://console.anthropic.com/settings/usage")
        case "opencode": return URL(string: "https://opencode.ai/auth")
        case "openrouter": return URL(string: "https://openrouter.ai/credits")
        case "gemini": return URL(string: "https://aistudio.google.com")
        case "grok": return URL(string: "https://console.x.ai")
        case "cursor": return URL(string: "https://cursor.com/dashboard")
        default: return nil
        }
    }

    @objc private func openUpstreamConsole(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openDashboard() {
        openLocalDashboard(path: "/")
    }

    @objc private func refreshNow() { model?.refresh() }

    private func runMaintenance(_ args: [String], label: String, config: Bool = false) {
        guard let model else { return }
        let cli = model.currentInvocation()
        Task {
            do {
                _ = try await (config ? Model.runConfigCLI(cli, args) : Model.runCLI(cli, args))
                await MainActor.run { model.refresh() }
            } catch {
                FileHandle.standardError.write(Data("[tokitoki] \(label) failed: \(error.localizedDescription)\n".utf8))
            }
        }
    }

    @objc private func rescanAll() { runMaintenance(["scan"], label: "scan") }
    func rescanForPopover() { rescanAll() }
    @objc private func pollNow() { model?.pollNow() }
    @objc private func enablePolling() { runMaintenance(["poll", "--enable"], label: "enable polling", config: true); model?.pollAuto = true }
    @objc private func disablePolling() { runMaintenance(["poll", "--disable"], label: "disable polling", config: true); model?.pollAuto = false }

    @objc private func openSources() {
        openLocalDashboard(path: "/?view=sources")
    }

    @objc private func openReports() {
        openLocalDashboard(path: "/?view=reports&last=month")
    }

    func openSessionInDashboard(provider: String, sessionId: String) {
        var components = URLComponents()
        components.path = "/"
        components.queryItems = [
            URLQueryItem(name: "view", value: "sessions"),
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "session", value: sessionId),
        ]
        openLocalDashboard(path: components.string ?? "/?view=sessions")
    }

    func refreshDashboardStatus() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.model?.dashboardStatus = await Self.dashboardIsReady()
                ? (self.dashboardProcess?.isRunning == true ? "Running · owned by tokitoki" : "Running · external process")
                : "Stopped"
        }
    }

    func stopDashboard() {
        guard dashboardProcess?.isRunning == true else {
            model?.dashboardStatus = "Stopped · no server owned by tokitoki"
            return
        }
        dashboardProcess?.terminate()
        dashboardProcess = nil
        model?.dashboardStatus = "Stopped"
    }

    func toggleMCP() {
        if mcpProcess?.isRunning == true {
            mcpProcess?.terminate()
            mcpProcess = nil
            mcpInput = nil
            model?.mcpStatus = "Stopped · agents start their own stdio connection"
            return
        }
        guard let cli = model?.currentInvocation() else { return }
        let proc = Process()
        proc.executableURL = cli.executable
        proc.arguments = cli.prefixArgs + ["mcp"]
        let input = Pipe()
        proc.standardInput = input
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            mcpInput = input
            mcpProcess = proc
            model?.mcpStatus = "Running · stdio health process (agent connections stay client-owned)"
        } catch {
            model?.mcpStatus = "Could not start MCP: \(error.localizedDescription)"
        }
    }

    /// Open a local dashboard route, starting the web server when the user
    /// does not already have one running. A single launcher keeps Dashboard,
    /// Reports, and Sources consistent from both the popover and context menu.
    func openLocalDashboard(path: String) {
        guard let url = Self.localDashboardURL(path: path) else { return }
        model?.dashboardStatus = "Checking local dashboard…"
        Task { @MainActor [weak self] in
            guard let self else { return }
            var ready = await Self.dashboardIsReady()
            if !ready, self.dashboardProcess?.isRunning != true {
                guard let cli = self.model?.currentInvocation() else {
                    self.model?.dashboardStatus = "Dashboard unavailable"
                    NSSound.beep()
                    return
                }
                let proc = Process()
                proc.executableURL = cli.executable
                proc.arguments = cli.prefixArgs + ["web"]
                do {
                    try proc.run()
                    self.dashboardProcess = proc
                } catch {
                    self.model?.dashboardStatus = "Could not start dashboard: \(error.localizedDescription)"
                    NSSound.beep()
                    return
                }
                ready = await Self.waitForDashboard()
            }
            guard ready else {
                self.model?.dashboardStatus = "Dashboard did not become ready"
                NSSound.beep()
                return
            }
            self.model?.dashboardStatus = "Dashboard ready"
            NSWorkspace.shared.open(url)
        }
    }

    private static func dashboardIsReady() async -> Bool {
        guard let url = localDashboardURL(path: "/") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private static func waitForDashboard() async -> Bool {
        for _ in 0..<30 {
            if await dashboardIsReady() { return true }
            try? await Task.sleep(for: .milliseconds(200))
        }
        return false
    }

    static func localDashboardURL(path: String) -> URL? {
        let suffix = path.hasPrefix("/") ? path : "/\(path)"
        return URL(string: "http://localhost:7788\(suffix)")
    }

    @objc private func copyMCPConfig() {
        let config = #"{"mcpServers":{"tokitoki":{"command":"tokitoki","args":["mcp"]}}}"#
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(config, forType: .string)
    }

    /// Toggle one provider's menubar visibility via `tokitoki ui`, then
    /// refresh so the change shows up immediately.
    @objc private func toggleProviderVisibility(_ sender: NSMenuItem) {
        guard let targets = sender.representedObject as? [String],
              !targets.isEmpty,
              let cli = model?.currentInvocation() else { return }
        let hide = sender.state == .on // checked = visible → clicking hides
        // Optimistic: flip local state so the menu re-renders instantly.
        model?.invalidateRefreshes()
        model?.applyVisibility(targets, visible: !hide)
        // Every target is a separate `ui` invocation. The old code omitted
        // the command name and passed `--hide` directly to the CLI, so it
        // only changed optimistically and then reverted on refresh.
        Task {
            do {
                for target in targets {
                    _ = try await Model.runConfigCLI(cli, ["ui", hide ? "--hide" : "--show", target])
                }
            } catch {
                FileHandle.standardError.write(Data("[tokitoki] provider visibility save failed: \(error)\n".utf8))
            }
            await MainActor.run { self.model?.refresh() }
        }
    }

    @objc private func toggleStartAtLogin() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = isStartAtLogin
            ? ["bootout", "gui/\(getuid())/dev.tokitoki.menubar"]
            : ["bootstrap", "gui/\(getuid())", launchAgentURL.path]
        try? task.run()
        task.waitUntilExit()
    }

    @objc private func quit() {
        // Boot out first: KeepAlive otherwise immediately resurrects us.
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["bootout", "gui/\(getuid())/dev.tokitoki.menubar"]
        try? task.run()
        task.waitUntilExit()
        NSApp.terminate(nil)
    }
}

/// How to invoke the CLI: `bun src/cli.ts` preferred (always current),
/// compiled dist binary only as a bun-less fallback.
struct CLIInvocation {
    let executable: URL
    let prefixArgs: [String]
}

/// Locate the CLI by walking up from this binary (repo layout);
/// $TOKITOKI_BIN override wins.
func resolveInvocation() -> CLIInvocation {
    func cliURL(_ s: String) -> URL {
        URL(fileURLWithPath: (s as NSString).expandingTildeInPath)
    }
    if let override = ProcessInfo.processInfo.environment["TOKITOKI_BIN"], !override.isEmpty {
        return CLIInvocation(executable: URL(fileURLWithPath: override), prefixArgs: [])
    }
    // bun candidates cover brew + the official installer + nix profile links.
    var bunURL: URL?
    for candidate in ["~/.bun/bin/bun", "~/.nix-profile/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"] {
        let u = cliURL(candidate)
        if FileManager.default.fileExists(atPath: u.path) { bunURL = u; break }
    }
    if bunURL == nil {
        // Last resort: whatever `bun` is on PATH (launchd contexts often have
        // no PATH, hence the fixed candidates above).
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["which", "bun"]
        let pipe = Pipe()
        task.standardOutput = pipe
        if (try? task.run()) != nil {
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if task.terminationStatus == 0, !path.isEmpty { bunURL = URL(fileURLWithPath: path) }
        }
    }
    var url = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    for _ in 0..<6 {
        url.deleteLastPathComponent()
        let repoRoot = url
        // Source checkout first: the menubar is developed alongside the repo,
        // and invoking stale dist/cli.js makes settings appear to revert after
        // the next payload refresh. Packaged installs still use dist below.
        let cliTs = repoRoot.appendingPathComponent("src/cli.ts")
        if FileManager.default.fileExists(atPath: cliTs.path), let bun = bunURL {
            return CLIInvocation(executable: bun, prefixArgs: [cliTs.path])
        }
        let cliJs = repoRoot.appendingPathComponent("dist/cli.js")
        if FileManager.default.fileExists(atPath: cliJs.path), let bun = bunURL {
            return CLIInvocation(executable: bun, prefixArgs: [cliJs.path])
        }
        if FileManager.default.fileExists(atPath: repoRoot.appendingPathComponent("dist/tokitoki").path) {
            return CLIInvocation(executable: repoRoot.appendingPathComponent("dist/tokitoki"), prefixArgs: [])
        }
    }
    // Repo not found relative to the binary — try the canonical checkout.
    if let bun = bunURL {
        // Same source-first rule for the installed ~/bin app's canonical
        // checkout fallback. Otherwise settings writes use stale dist/cli.js.
        for rel in ["src/cli.ts", "dist/cli.js"] {
            let u = cliURL("~/dev/tokitoki/" + rel)
            if FileManager.default.fileExists(atPath: u.path) {
                return CLIInvocation(executable: bun, prefixArgs: [u.path])
            }
        }
    }
    return CLIInvocation(executable: cliURL("~/dev/tokitoki/dist/tokitoki"), prefixArgs: [])
}

MainActor.assumeIsolated {
    let model = Model()
    model.start(invocation: resolveInvocation())
    let app = NSApplication.shared
    let delegate = AppDelegate()
    delegate.model = model
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}

/// openusage-style "Customize" sheet: every popover card with a drag handle
/// (reorder) and a native Toggle (visibility). Saved via `tokitoki ui
/// --card-set id:1,id:0,...` then the model refreshes.
/// Reorder-on-drop for popover cards: moves `dragging` before/after `target`
/// inside the full layout (hidden entries ride along), then commits.
struct PopoverCardDrop: DropDelegate {
    let target: String
    let getLayout: () -> [(id: String, hidden: Bool)]
    let setLayout: ([(id: String, hidden: Bool)]) -> Void
    @Binding var dragging: String?
    let onCommit: ([(id: String, hidden: Bool)]) -> Void

    func dropEntered(info: DropInfo) {
        guard let dragging, dragging != target else { return }
        var layout = getLayout()
        guard let from = layout.firstIndex(where: { $0.id == dragging }),
              let to = layout.firstIndex(where: { $0.id == target }) else { return }
        withAnimation(.easeInOut(duration: 0.15)) {
            layout.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
        }
        setLayout(layout)
    }

    func performDrop(info: DropInfo) -> Bool {
        defer { dragging = nil }
        onCommit(getLayout())
        return true
    }

    func validateDrop(info: DropInfo) -> Bool { true }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
}

/// Generic move-on-hover drop delegate for id-list reordering.
struct ReorderDropDelegate: DropDelegate {
    let target: String
    @Binding var dragging: String?
    /// Called with the dragged id when it enters `target`'s bounds.
    let onMove: (String) -> Void

    func dropEntered(info: DropInfo) {
        guard let dragging, dragging != target else { return }
        onMove(dragging)
    }

    func performDrop(info: DropInfo) -> Bool {
        dragging = nil
        return true
    }

    func validateDrop(info: DropInfo) -> Bool { true }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
}

/// Monochrome brand mark for the template strip: real vector path when the
/// provider has one, π for pi, SF symbol otherwise — all solid black so the
/// template image tints correctly in light/dark menu bars.
struct MonoMark: View {
    let provider: String

    var body: some View {
        Group {
            if let vector = BrandIcon.forProvider(provider) {
                AnyView(vector.fill(Color.black))
            } else if provider == "pi" {
                AnyView(Text("π").font(.system(size: 11, weight: .heavy)).foregroundStyle(Color.black))
            } else {
                AnyView(Image(systemName: ProviderLogo.symbol(provider))
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.black))
            }
        }
        .frame(width: 12, height: 12)
    }
}

struct CustomizeSheet: View {
    @ObservedObject var model: Model
    @Binding var isPresented: Bool
    /// Section a — usage-card drafts (order + popover visibility).
    @State private var cards: [CardState] = []
    /// ui.hidden.menubar targets as of load — the save diff baseline.
    @State private var originalHiddenTargets: Set<String> = []

    struct CardState: Identifiable, Equatable {
        /// Display/order id ("provider@accountKey").
        let id: String
        /// ui.hidden.menubar target ("provider:accountKey").
        let target: String
        var visible: Bool
        var ident: String { id }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header bar (macOS has no navigation chrome in popovers).
            HStack {
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("Customize").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Done") { save(); isPresented = false }
                    .buttonStyle(.plain).fontWeight(.semibold)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            List {
                Section(header: sectionHeader("Usage cards")) {
                    ForEach($cards) { $card in
                        CardRow(card: $card)
                            .onDrag {
                                dragging = card.id
                                return NSItemProvider(object: card.id as NSString)
                            }
                            .onDrop(of: [UTType.plainText], delegate: CardDropDelegate(target: card.id, cards: $cards, dragging: $dragging))
                    }
                }
            }
            .listStyle(.inset)
        }
        .frame(width: 320, height: 480)
        .onAppear(perform: load)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    @State private var dragging: String?

    /// One customize row: drag handle + title/id + native switch.
    private struct CardRow: View {
        @Binding var card: CardState

        var body: some View {
            HStack(spacing: 10) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(cardDisplayName)
                        .font(.system(size: 13, weight: .medium))
                    Text(card.id)
                        .font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                Toggle("", isOn: $card.visible)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .controlSize(.small)
            }
        }

        private var cardDisplayName: String {
            // "pi@opencode-go" → "opencode-go (pi)"-style friendly label when
            // the account key already carries the name; harness prefix otherwise.
            let parts = card.id.split(separator: "@", maxSplits: 1)
            if parts.count == 2, parts[1] != "default" {
                return "\(parts[1]) · \(parts[0])"
            }
            return card.id
        }
    }

    /// Reorder-on-drop for the customize list.
    private struct CardDropDelegate: DropDelegate {
        let target: String
        @Binding var cards: [CardState]
        @Binding var dragging: String?

        func performDrop(info: DropInfo) -> Bool {
            dragging = nil
            return true
        }

        func dropEntered(info: DropInfo) {
            guard let dragging, dragging != target else { return }
            guard let from = cards.firstIndex(where: { $0.id == dragging }),
                  let to = cards.firstIndex(where: { $0.id == target }) else { return }
            withAnimation(.easeInOut(duration: 0.15)) {
                cards.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
            }
        }

        func validateDrop(info: DropInfo) -> Bool { true }
        func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    }

    private func load() {
        // Section a: every account card (payload order), visibility from
        // hidden.menubar via the same "provider:accountKey" targets the
        // context menu writes. Hidden pairs keep their drag slot.
        cards = model.limits.map { l in
            let target = "\(l.provider):\(l.accountKey)"
            return CardState(
                id: "\(l.provider)@\(l.accountKey)",
                target: target,
                visible: !model.menubarHidden.contains(target),
            )
        }
        originalHiddenTargets = model.menubarHidden
    }

    private func move(from source: IndexSet, to destination: Int) {
        cards.move(fromOffsets: source, toOffset: destination)
    }

    /// Done: persist account order + visibility changes, batched on a
    /// background queue via the existing `ui` flags.
    private func save() {
        let cli = model.currentInvocation()
        let order = cards.map { $0.id }
        var argsList: [[String]] = [["ui", "--account-order", order.joined(separator: ",")]]
        var newHidden = model.menubarHidden
        for card in cards {
            let wasHidden = originalHiddenTargets.contains(card.target)
            if card.visible && wasHidden {
                argsList.append(["ui", "--show", card.target])
                newHidden.remove(card.target)
            } else if !card.visible && !wasHidden {
                argsList.append(["ui", "--hide", card.target])
                newHidden.insert(card.target)
            }
        }
        // Optimistic: apply locally so the popover reflects Done instantly.
        model.invalidateRefreshes()
        model.accountOrderOverride = order
        model.menubarHidden = newHidden
        Task {
            do {
                for args in argsList {
                    _ = try await Model.runConfigCLI(cli, args)
                }
            } catch {
                FileHandle.standardError.write(Data("[tokitoki] customize save failed: \(error)\n".utf8))
            }
            await MainActor.run { model.refresh() }
        }
    }
}

/// Dedicated provider-key manager. Keys stay in local config; quota polling
/// stores only provider snapshots and UI exposes redacted hints.
struct ApiKeysSheet: View {
    @ObservedObject var model: Model
    @Binding var isPresented: Bool
    @State private var keys: [ProviderKey] = []
    @State private var showAdd = false
    @State private var newId = ""
    @State private var newProvider = "opencode-go"
    @State private var newValue = ""

    struct ProviderKey: Identifiable, Codable, Equatable {
        let id: String
        let label: String?
        let provider: String
        let key: String

        enum CodingKeys: String, CodingKey { case id, label, provider, key }

        init(id: String, label: String? = nil, provider: String, key: String) {
            self.id = id
            self.label = label
            self.provider = provider
            self.key = key
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            label = try values.decodeIfPresent(String.self, forKey: .label)
            provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? "opencode-go"
            key = try values.decode(String.self, forKey: .key)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                Spacer()
                Text("Provider API keys").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Done") { isPresented = false }
                    .buttonStyle(.plain).fontWeight(.semibold)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            List {
                Section {
                    if keys.isEmpty {
                        Text("No manual keys yet")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(keys) { key in
                            HStack(spacing: 8) {
                                ProviderLogo(provider: key.provider)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(key.label ?? key.id).font(.system(size: 12, weight: .medium))
                                    if key.label != nil { Text(key.id).font(.caption2).foregroundStyle(.secondary) }
                                    Text("\(providerName(key.provider)) · \(redactedKeyHint(key.key))")
                                        .font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                                }
                                Spacer()
                                Button { delete(key) } label: {
                                    Image(systemName: "trash")
                                        .font(.system(size: 10)).foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(key.id) API key")
                                .help("Remove API key")
                            }
                        }
                    }
                    Button("Add API key…") {
                        newId = ""
                        newProvider = "opencode-go"
                        newValue = ""
                        showAdd = true
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .accessibilityIdentifier("add-api-key")
                } header: {
                    Text("Saved keys")
                } footer: {
                    Text("Each key is polled separately and appears as its own quota card. Use Refresh quotas now after adding one.")
                }
            }
            .listStyle(.inset)
        }
        .frame(width: 340, height: 390)
        .sheet(isPresented: $showAdd) { addKeyForm }
        .onAppear(perform: load)
    }

    private var addKeyForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add provider API key").font(.system(size: 13, weight: .semibold))
            Picker("Provider", selection: $newProvider) {
                Text("OpenCode Go").tag("opencode-go")
                Text("OpenRouter").tag("openrouter")
            }
            .pickerStyle(.menu)
            TextField("name (e.g. work)", text: $newId)
                .textFieldStyle(.roundedBorder)
            HStack(spacing: 6) {
                SecureField("API key", text: $newValue)
                    .textFieldStyle(.roundedBorder)
                Button("Paste") {
                    if let pasted = NSPasteboard.general.string(forType: .string) {
                        newValue = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                .buttonStyle(.bordered).controlSize(.small)
                .accessibilityIdentifier("paste-api-key")
            }
            HStack {
                Spacer()
                Button("Cancel") { showAdd = false }.keyboardShortcut(.cancelAction)
                Button("Add") { add() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!inputValid)
            }
        }
        .padding(16)
        .frame(width: 310)
    }

    private func load() {
        struct Config: Codable { var poll: Poll? }
        struct Poll: Codable { var extraKeys: [ProviderKey]? }
        let cli = model.currentInvocation()
        Task {
            do {
                let config = try await Model.runJSON(Config.self, cli, ["config", "--json"])
                await MainActor.run { keys = config?.poll?.extraKeys ?? [] }
            } catch {
                // An unavailable CLI should not make the key sheet unusable;
                // the next appearance retries the read.
            }
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(keys), let json = String(data: data, encoding: .utf8) else { return }
        let cli = model.currentInvocation()
        Task {
            do {
                _ = try await Model.runConfigCLI(cli, ["config", "set", "poll.extraKeys", json])
                await MainActor.run { model.refresh() }
            } catch {
                await MainActor.run { model.pollStatus = "Could not save API key: \(error.localizedDescription)" }
            }
        }
    }

    private var inputValid: Bool {
        !newId.isEmpty && !newId.contains(" ") && newValue.count > 10
            && !keys.contains(where: { $0.id == newId && $0.provider == newProvider })
    }

    private func add() {
        guard inputValid else { return }
        keys.append(ProviderKey(id: newId, provider: newProvider, key: newValue))
        persist()
        showAdd = false
    }

    private func delete(_ key: ProviderKey) {
        keys.removeAll { $0.id == key.id && $0.provider == key.provider }
        persist()
    }

    private func providerName(_ provider: String) -> String {
        switch provider {
        case "opencode-go": return "OpenCode Go"
        case "openrouter": return "OpenRouter"
        default: return provider
        }
    }

    private func redactedKeyHint(_ key: String) -> String {
        key.count <= 12 ? "…" : "\(key.prefix(4))…\(key.suffix(4))"
    }
}

/// Settings dedicated to the status-item strip. Kept separate from the
/// popover card editor so each screen answers one clear question.
struct PreviewSettingsSheet: View {
    @ObservedObject var model: Model
    @Binding var isPresented: Bool
    @State private var rows: [ProviderRow] = []

    struct ProviderRow: Identifiable {
        let id: String
        var visible: Bool
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Menubar preview")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Done") { isPresented = false }
                    .buttonStyle(.plain).fontWeight(.semibold)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            List {
                Section {
                    Picker("Display", selection: Binding(
                        get: { model.previewMode },
                        set: { model.setPreviewMode($0) },
                    )) {
                        Text("Always in the menubar").tag("inline")
                        Text("Only while hovering").tag("hover")
                    }
                    Picker("Metric", selection: Binding(
                        get: { model.stripMetric },
                        set: { model.setStripMetric($0) },
                    )) {
                        Text("Remaining percent").tag("percent")
                        Text("Usage tokens").tag("tokens")
                        Text("Smart constraint").tag("smart")
                    }
                    Picker("When a provider is exhausted", selection: Binding(
                        get: { model.stripExhausted },
                        set: { model.setStripExhausted($0) },
                    )) {
                        Text("Show next reset").tag("reset")
                        Text("Hide its mark").tag("hide")
                        Text("Keep showing 0%").tag("show")
                    }
                } header: {
                    Text("Display")
                } footer: {
                    Text("Smart constraint favors the window that limits availability; exhausted providers show the latest required reset.")
                }
                Section {
                    ForEach($rows) { $row in
                        Toggle(isOn: Binding(
                            get: { row.visible },
                            set: { newValue in
                                row.visible = newValue
                                model.setPreviewVisible(row.id, visible: newValue)
                            },
                        )) {
                            HStack(spacing: 9) {
                                MonoMark(provider: row.id)
                                Text(row.id).font(.system(size: 13, weight: .medium))
                            }
                        }
                    }
                    if rows.isEmpty {
                        Text("No quota providers detected")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Providers")
                } footer: {
                    Text("These toggles affect only the compact status-item preview. Popover cards are managed separately.")
                }
            }
            .listStyle(.inset)
        }
        .frame(width: 340, height: 430)
        .onAppear(perform: load)
    }

    private func load() {
        var order: [String] = []
        for l in model.limits {
            guard let up = Model.upstreamProvider(l), !order.contains(up) else { continue }
            order.append(up)
        }
        rows = order.map { ProviderRow(id: $0, visible: !model.previewHidden.contains($0)) }
    }
}

enum PopoverSubview: String, CaseIterable, Hashable {
    case overview
    case quotas
    case tokens
    case reports
    case sources
    case mcp
    case sessions
    case settings

    var title: String {
        switch self {
        case .overview: return "Home"
        case .quotas: return "Quotas"
        case .tokens: return "Tokens"
        case .reports: return "Reports"
        case .sources: return "Sources"
        case .mcp: return "MCP"
        case .sessions: return "Sessions"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .overview: return "house"
        case .quotas: return "chart.bar.xaxis"
        case .tokens: return "circle.hexagongrid.circle"
        case .reports: return "doc.text"
        case .sources: return "doc.text.magnifyingglass"
        case .mcp: return "point.3.connected.trianglepath.dotted"
        case .sessions: return "text.bubble"
        case .settings: return "gearshape"
        }
    }

    static let defaultOrder: [PopoverSubview] = [.overview, .quotas, .tokens, .reports, .sessions, .sources, .mcp, .settings]

    static func normalizedOrder(_ raw: [String]?) -> [PopoverSubview] {
        var result: [PopoverSubview] = []
        for id in raw ?? [] {
            guard let view = PopoverSubview(rawValue: id), !result.contains(view) else { continue }
            result.append(view)
        }
        for view in defaultOrder where !result.contains(view) { result.append(view) }
        return result
    }
}

enum MCPIntegration: String, CaseIterable, Identifiable {
    case claudeDesktop
    case claudeCode
    case codex
    case cursor
    case windsurf
    case vscode

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claudeDesktop: return "Claude Desktop"
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .cursor: return "Cursor"
        case .windsurf: return "Windsurf"
        case .vscode: return "VS Code"
        }
    }

    var location: String {
        switch self {
        case .claudeDesktop: return "Claude Desktop settings → Developer → Edit Config"
        case .claudeCode: return "Claude Code terminal"
        case .codex: return "~/.codex/config.toml"
        case .cursor: return "Cursor → Settings → MCP"
        case .windsurf: return "Windsurf → Settings → MCP"
        case .vscode: return ".vscode/mcp.json"
        }
    }

    var snippet: String {
        switch self {
        case .claudeDesktop:
            return "{\n  \"mcpServers\": {\n    \"tokitoki\": {\n      \"command\": \"tokitoki\",\n      \"args\": [\"mcp\"]\n    }\n  }\n}"
        case .claudeCode:
            return "claude mcp add tokitoki -- tokitoki mcp"
        case .codex:
            return "[mcp_servers.tokitoki]\ncommand = \"tokitoki\"\nargs = [\"mcp\"]"
        case .cursor:
            return "{\n  \"mcpServers\": {\n    \"tokitoki\": {\n      \"command\": \"tokitoki\",\n      \"args\": [\"mcp\"]\n    }\n  }\n}"
        case .windsurf:
            return "{\n  \"mcpServers\": {\n    \"tokitoki\": {\n      \"command\": \"tokitoki\",\n      \"args\": [\"mcp\"]\n    }\n  }\n}"
        case .vscode:
            return "{\n  \"servers\": {\n    \"tokitoki\": {\n      \"type\": \"stdio\",\n      \"command\": \"tokitoki\",\n      \"args\": [\"mcp\"]\n    }\n  }\n}"
        }
    }

    var steps: [String] {
        switch self {
        case .claudeCode: return ["Run the command below in a terminal.", "Restart Claude Code or reconnect MCP."]
        default: return ["Open the integration settings at the location below.", "Paste the snippet into the MCP configuration.", "Restart or reconnect the integration."]
        }
    }
}

struct MCPToolInfo: Identifiable {
    let id: String
    let summary: String
    let inputs: String

    static let all: [MCPToolInfo] = [
        .init(id: "usage_report", summary: "Aggregate tokens, requests, sessions, cache, and cost by model, provider, account, project, repo, machine, or tool.", inputs: "window · dimension · optional provider"),
        .init(id: "usage_totals", summary: "Return only totals for a window when you need a compact budget or activity check.", inputs: "window · optional provider"),
        .init(id: "sessions_top", summary: "Find the most expensive or token-heavy sessions, with provider and time-window context.", inputs: "window · limit 1–100 · optional provider"),
        .init(id: "session_detail", summary: "Expand one session into its per-request timeline and provider attribution.", inputs: "session_id"),
        .init(id: "tool_spend", summary: "Rank spend by the tool that caused each request; MCP server calls are rolled up as mcp:server.", inputs: "window"),
        .init(id: "repo_efficiency", summary: "Rank repositories by cost/request/session and expose cache-hostility signals.", inputs: "window"),
        .init(id: "budgets_status", summary: "Read configured spending caps and their current usage gauges.", inputs: "none"),
        .init(id: "quota_snapshot", summary: "Read the latest provider-reported quota windows for one account.", inputs: "provider · account_key"),
        .init(id: "anomalies", summary: "Detect unusual activity days against the trailing baseline.", inputs: "window"),
        .init(id: "sources", summary: "Explain provider provenance: roots, files, scan freshness, accounts, and models.", inputs: "none"),
        .init(id: "scan_now", summary: "Incrementally scan all registered harness stores and update the local cache; safe to repeat.", inputs: "none"),
        .init(id: "search_sessions", summary: "Full-text search indexed session titles and conversation summaries, returning snippets and usage context.", inputs: "query · limit 1–50 · optional provider"),
        .init(id: "usage_chart", summary: "Return one row per day with tokens, cost, and requests for charting or trend analysis.", inputs: "window · metric tokens|cost|requests"),
        .init(id: "export_report", summary: "Export a grouped report as JSON, CSV, or Markdown for handoff or archival.", inputs: "window · format · dimension · optional provider"),
    ]
}

/// Small, bounded stacked-bar history for the native Tokens view. The CLI
/// sends only the top six providers and one 30-day vector per provider, so
/// rendering never requires a second query or a large Swift-side data set.
struct UsageHistoryChart: View {
    let history: DailyUsageHistory

    private var dayTotals: [Double] {
        history.days.indices.map { index in
            history.series.reduce(0) { total, series in
                total + (index < series.values.count ? series.values[index] : 0)
            }
        }
    }

    var body: some View {
        let maximum = dayTotals.max() ?? 0
        VStack(alignment: .leading, spacing: 5) {
            GeometryReader { proxy in
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(history.days.indices, id: \.self) { index in
                        VStack(alignment: .center, spacing: 0) {
                            ForEach(Array(history.series.enumerated()).reversed(), id: \.offset) { _, series in
                                let value = index < series.values.count ? series.values[index] : 0
                                Rectangle()
                                    .fill(bucketColor(series.bucket, peers: history.series.map(\.bucket)))
                                    .frame(height: maximum > 0 ? max(1, proxy.size.height * value / maximum) : 1)
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    }
                }
            }
            .frame(height: 92)
            if let first = history.days.first, let last = history.days.last {
                HStack {
                    Text(first).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                    Spacer()
                    Text(last).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                }
            }
            HStack(spacing: 8) {
                ForEach(history.series.prefix(4)) { series in
                    HStack(spacing: 3) {
                        Circle().fill(bucketColor(series.bucket, peers: history.series.map(\.bucket))).frame(width: 6, height: 6)
                        Text(series.bucket).font(.caption2).lineLimit(1)
                    }
                }
            }
        }
    }
}

/// GitHub-style contribution grid for the local usage calendar. The payload
/// contains only non-empty days; the view fills the remaining cells locally so
/// the wire format stays small and the popover remains instant to open.
struct ActivityGridView: View {
    let payload: ActivityGridPayload

    private var columns: [[ActivityGridPayload.Cell?]] {
        var byDay: [String: ActivityGridPayload.Cell] = [:]
        for cell in payload.cells { byDay[cell.day] = cell }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let start = calendar.date(byAdding: .day, value: -364, to: today) ?? today
        let monday = calendar.date(byAdding: .day, value: -((calendar.component(.weekday, from: start) + 5) % 7), to: start) ?? start
        let maxValue = payload.cells.map { metricValue($0) }.max() ?? 0
        var result: [[ActivityGridPayload.Cell?]] = []
        for column in 0..<53 {
            var week: [ActivityGridPayload.Cell?] = []
            for row in 0..<7 {
                guard let date = calendar.date(byAdding: .day, value: column * 7 + row, to: monday), date <= today else {
                    week.append(nil)
                    continue
                }
                let key = date.formatted(.iso8601.year().month().day())
                week.append(byDay[key])
            }
            result.append(week)
        }
        _ = maxValue
        return result
    }

    private func metricValue(_ cell: ActivityGridPayload.Cell) -> Double {
        switch payload.metric { case "cost": return cell.costUsd; case "requests": return Double(cell.requests); default: return cell.tokens }
    }

    private func tint(_ cell: ActivityGridPayload.Cell?) -> Color {
        guard let cell else { return Color.primary.opacity(0.08) }
        let maxValue = payload.cells.map { metricValue($0) }.max() ?? 0
        guard maxValue > 0 else { return Color.green.opacity(0.18) }
        let ratio = metricValue(cell) / maxValue
        return Color.green.opacity(0.18 + min(0.76, ratio * 0.76))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 2) {
                ForEach(Array(columns.enumerated()), id: \.offset) { _, week in
                    VStack(spacing: 2) {
                        ForEach(Array(week.enumerated()), id: \.offset) { _, cell in
                            RoundedRectangle(cornerRadius: 1.5).fill(tint(cell)).frame(width: 5, height: 5)
                        }
                    }
                }
            }
            HStack(spacing: 4) {
                Text("less").font(.caption2).foregroundStyle(.tertiary)
                ForEach(0..<5, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.green.opacity(0.18 + Double(level) * 0.19)).frame(width: 5, height: 5)
                }
                Text("more").font(.caption2).foregroundStyle(.tertiary)
                Spacer()
                Text("last year · \(payload.metric)").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .accessibilityLabel("GitHub-style usage activity for the last year")
    }
}

/// Shared collapsible surface for every secondary card in the popover. The
/// disclosure is local UI state: it never mutates account visibility/order
/// preferences and therefore stays instant even while a refresh is running.
struct CollapsibleCard<Content: View>: View {
    let title: String
    let icon: String
    let content: () -> Content
    @State private var isExpanded = true

    init(title: String, icon: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.icon = icon
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded ? 7 : 0) {
            HStack(spacing: 4) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.quaternary)
                    .help("drag to reorder")
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Label(title.uppercased(), systemImage: icon)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .bold))
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") \(title)")
            }
            if isExpanded {
                content()
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Compact hover surface for the status item. It answers "what is tightest
/// right now?" without opening the full popover, while click still opens all
/// details. Rows use the same colors and reset semantics as quota cards.
struct HoverPreviewView: View {
    @ObservedObject var model: Model

    struct Entry: Identifiable {
        let id: String
        let provider: String
        let account: String
        let window: String
        let value: String
        let reset: String
        let remaining: Double?
    }

    private var entries: [Entry] {
        model.limits
            .filter { !model.menubarHidden.contains($0.provider) && !model.menubarHidden.contains("\($0.provider):\($0.accountKey)") }
            .flatMap { limit in
                let account = limit.email ?? limit.credential ?? limit.accountKey
                return limit.windows.prefix(3).map { window in
                    let remaining = window.usedPct.map { max(0, min(100, 100 - $0)) }
                    return Entry(
                        id: "\(limit.id):\(window.kind)",
                        provider: limit.provider,
                        account: account,
                        window: windowDisplayName(window.kind, provider: limit.provider),
                        value: remaining.map { "\(Int($0.rounded()))% left" } ?? "~\(humanCount(window.tokens)) tokens",
                        reset: window.resetsAt.map(countdown) ?? "—",
                        remaining: remaining,
                    )
                }
            }
            .sorted { ($0.remaining ?? 101) < ($1.remaining ?? 101) }
            .prefix(8)
            .map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Quota snapshot", systemImage: "gauge.with.dots.needle.67percent")
                        .font(.subheadline.weight(.semibold))
                    Text(model.lastUpdatedAt.map { "Updated \(relativeDateEnglish($0))" } ?? "Loading latest data…")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Text("Click for details")
                    .font(.caption2.weight(.medium)).foregroundStyle(.tertiary)
            }
            if entries.isEmpty {
                Label("No provider quota data", systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            ProviderLogo(provider: entry.provider)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(entry.account).font(.caption.weight(.medium)).lineLimit(1)
                                Text("\(entry.provider) · \(entry.window)")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            VStack(alignment: .trailing, spacing: 1) {
                                Text(entry.value)
                                    .font(.caption2.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(entry.remaining.map(barTint) ?? .secondary)
                                Text(entry.reset == "now" ? "Available now" : "Resets in \(entry.reset)")
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        if let remaining = entry.remaining {
                            GeometryReader { proxy in
                                ZStack(alignment: .leading) {
                                    Capsule().fill(.quaternary.opacity(0.65))
                                    Capsule()
                                        .fill(barTint(remaining))
                                        .frame(width: proxy.size.width * remaining / 100)
                                }
                            }
                            .frame(height: 4)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(13)
        .frame(width: 340, alignment: .leading)
        .background(.thickMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct TabSettingsSheet: View {
    @ObservedObject var model: Model
    @Binding var isPresented: Bool
    @State private var tabs: [PopoverSubview] = PopoverSubview.defaultOrder

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                Spacer()
                Text("Popover tabs").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Done") {
                    model.setTabOrder(tabs)
                    isPresented = false
                }
                .buttonStyle(.plain).fontWeight(.semibold)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            Text("Drag to reorder. The first four tabs stay visible; the rest appear under More.")
                .font(.caption).foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            List {
                ForEach(tabs, id: \.self) { tab in
                    HStack(spacing: 8) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(.tertiary)
                        Label(tab.title, systemImage: tab.icon)
                        Spacer()
                        Text(tabs.firstIndex(of: tab)! < 4 ? "header" : "More")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .onMove { tabs.move(fromOffsets: $0, toOffset: $1) }
            }
            .listStyle(.inset)
        }
        .frame(width: 340, height: 390)
        .onAppear { tabs = model.tabOrder }
    }
}

struct TokenRangeSheet: View {
    @Binding var isPresented: Bool
    let onSave: (Date, Date) -> Void
    @State private var from = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @State private var to = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Custom token range").font(.system(size: 13, weight: .semibold))
            DatePicker("From", selection: $from, displayedComponents: .date)
            DatePicker("To", selection: $to, in: from..., displayedComponents: .date)
            Text("Custom token totals use the history currently available to the menubar.")
                .font(.caption2).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel") { isPresented = false }.keyboardShortcut(.cancelAction)
                Button("Apply") {
                    onSave(from, to)
                    isPresented = false
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 300)
    }
}

struct PopoverLaunchView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(model.isLoading ? "Loading latest data…" : "Preparing dashboard…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 400, idealWidth: 420, maxWidth: 520,
               minHeight: 560, idealHeight: 700, maxHeight: 860)
        .background(.thinMaterial)
    }
}

struct ContentView: View {
    @ObservedObject var model: Model
    /// Card filter — matches harness/account names, repo paths, tools.
    @State private var searchText = ""
    /// Customize sheet (card toggles + drag reorder).
    @State private var showCustomize = false
    /// Separate status-item preview settings (provider marks and display mode).
    @State private var showPreviewSettings = false
    /// Provider API-key manager, kept separate from card layout editing.
    @State private var showAPIKeys = false
    @State private var showTabSettings = false
    @State private var showTokenRange = false
    /// Repo row currently expanded in the repos card.
    @State private var expandedRepo: String?
    /// Quota card targeted by an attention summary click.
    @State private var quotaScrollTarget: String?
    /// Card order override while a drag session is in flight.
    @State private var localLayout: [(id: String, hidden: Bool)]?
    /// Id currently being dragged (popover card reorder).
    @State private var draggingCard: String?
    /// Account id currently being dragged (limits section reorder).
    @State private var draggingAccount: String?
    /// Native popover subview, inspired by CodexBar's provider/account drill-in.
    @State private var activeSubview: PopoverSubview = .overview
    /// Token-report period selection is local to the lightweight native view.
    @State private var tokenPeriodKey = "today"
    @State private var tokenMetric: SpendMetric = .tokens
    @State private var customTokenFrom = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @State private var customTokenTo = Date()
    @State private var mcpIntegration: MCPIntegration = .claudeDesktop

    /// Default card order when the payload carries no layout yet.
    static let defaultCardOrder = ["limits", "usage", "spend", "harness", "activity", "anomalies", "repos", "tools"]
    static let cardTitles: [String: String] = [
        "limits": "usage limits",
        "usage": "usage distribution",
        "spend": "activity today",
        "harness": "today by harness",
        "activity": "other machines",
        "anomalies": "anomalies",
        "repos": "top repos",
        "tools": "top tools",
    ]

    private var searchActive: Bool { !trimmedQuery.lowercased().isEmpty }
    private var query: String { trimmedQuery.lowercased() }
    private var dataIsStale: Bool {
        guard let updated = model.lastUpdatedAt else { return false }
        return Date().timeIntervalSince(updated) > 10 * 60
    }

    private func matches(_ text: String) -> Bool {
        !searchActive || text.lowercased().contains(query)
    }

    private func accountMatches(_ l: AccountLimits) -> Bool {
        !searchActive
            || [l.provider, l.accountKey, l.email ?? "", l.credential ?? ""]
                .contains(where: { $0.lowercased().contains(query) })
    }

    /// Whether a card survives the current search filter (row-level match).
    private func cardSurvives(_ id: String) -> Bool {
        guard searchActive else { return true }
        switch id {
        case "limits":
            return model.limits.contains(where: accountMatches)
        case "harness":
            return (model.today?.rows ?? []).contains { matches($0.bucket) }
        case "repos":
            return model.repos.contains { matches($0.bucket) }
        case "usage":
            let rows = spendPeriodRows()
            return rows.contains { matches($0.bucket) } || query == "cost" || query == "tokens"
        case "tools":
            return model.topTools.contains { matches($0.tool) }
        default:
            return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            navigationHeader
            Group {
                switch activeSubview {
                case .overview: overviewBody
                case .quotas: quotasBody
                case .tokens: tokensBody
                case .reports: reportsBody
                case .sessions: sessionsBody
                case .sources: sourcesBody
                case .mcp: mcpBody
                case .settings: settingsBody
                }
            }
            popoverFooter
        }
        .frame(minWidth: 400, idealWidth: 420, maxWidth: 520,
               minHeight: 560, idealHeight: 700, maxHeight: 860)
        .background(.thinMaterial)
        .sheet(isPresented: $showCustomize) {
            CustomizeSheet(model: model, isPresented: $showCustomize)
        }
        .sheet(isPresented: $showPreviewSettings) {
            PreviewSettingsSheet(model: model, isPresented: $showPreviewSettings)
        }
        .sheet(isPresented: $showAPIKeys) {
            ApiKeysSheet(model: model, isPresented: $showAPIKeys)
        }
        .sheet(isPresented: $showTabSettings) {
            TabSettingsSheet(model: model, isPresented: $showTabSettings)
        }
        .sheet(isPresented: $showTokenRange) {
            TokenRangeSheet(isPresented: $showTokenRange, onSave: { from, to in
                customTokenFrom = from
                customTokenTo = to
                tokenPeriodKey = "custom"
                tokenMetric = .tokens
                model.loadCustomTokenBreakdowns(from: from, to: to)
            })
        }
    }

    private var navigationHeader: some View {
        HStack(spacing: 4) {
            ForEach(Array(model.tabOrder.prefix(4)), id: \.self) { view in
                navigationButton(view)
            }
            Menu {
                Section("More") {
                    ForEach(Array(model.tabOrder.dropFirst(4)), id: \.self) { view in
                        Button {
                            activeSubview = view
                        } label: {
                            Label(view.title, systemImage: view.icon)
                        }
                    }
                }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "ellipsis.circle")
                    Text("More")
                }
                .font(.caption2.weight(model.tabOrder.dropFirst(4).contains(activeSubview) ? .semibold : .regular))
                .frame(maxWidth: .infinity, minHeight: 30)
            .background(model.tabOrder.dropFirst(4).contains(activeSubview) ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .foregroundStyle(model.tabOrder.dropFirst(4).contains(activeSubview) ? .primary : .secondary)
            .accessibilityLabel("More views")
        }
        .padding(.horizontal, 8).padding(.vertical, 7)
        .background(.thinMaterial)
        .overlay(alignment: .bottom) { Divider() }
    }

    private func navigationButton(_ view: PopoverSubview) -> some View {
        Button {
            // Switch synchronously; view data is already in the model/cache.
            activeSubview = view
        } label: {
            HStack(spacing: 3) {
                Image(systemName: view.icon)
                Text(view.title)
            }
            .font(.caption2.weight(activeSubview == view ? .semibold : .regular))
            .lineLimit(1)
            .frame(maxWidth: .infinity, minHeight: 34)
            .background(activeSubview == view ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear), in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(activeSubview == view ? .primary : .secondary)
        .accessibilityLabel(view.title)
        .accessibilityHint("Switch to the \(view.title) view")
        .help("Open \(view.title)")
    }

    private var overviewBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                if let e = model.errorText {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 7) {
                            Label(e, systemImage: "exclamationmark.triangle.fill")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.red)
                            Spacer(minLength: 4)
                            Button("Retry") { model.refresh(force: true) }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                        if let details = model.errorDetails, !details.isEmpty {
                            DisclosureGroup("Details") {
                                Text(details)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                }
                freshnessRow
                if model.isLoading && model.today == nil {
                    loadingState
                } else {
                    attentionSummary
                    searchBar
                    webDashboardLinks
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(orderedVisibleCards(), id: \.self) { id in
                            Group {
                                if cardSurvives(id) { cardBody(id) }
                            }
                            .onDrag {
                                draggingCard = id
                                return NSItemProvider(object: id as NSString)
                            }
                            .onDrop(of: [UTType.plainText], delegate: PopoverCardDrop(
                                target: id,
                                getLayout: { effectiveLayout() },
                                setLayout: { localLayout = $0 },
                                dragging: $draggingCard,
                                onCommit: { persistCardLayout($0) }
                            ))
                        }
                    }
                }
            }
            .padding(12)
        }
    }

    private var popoverFooter: some View {
        HStack(spacing: 6) {
            Button(action: { model.refresh(force: true) }) {
                Label("Refresh all", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered).controlSize(.small)
            .accessibilityLabel("Refresh all data")
            .accessibilityIdentifier("refresh-all")
            Spacer(minLength: 0)
            Menu {
                Button("Save screenshot to Desktop") { saveScreenshot() }
                Button("Copy summary as Markdown") { copyMarkdownSummary() }
            } label: {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            .menuStyle(.borderlessButton)
            .buttonStyle(.bordered).controlSize(.small)
            .accessibilityIdentifier("share-menu")
            Button(action: { showCustomize = true }) {
                Label("Layout", systemImage: "rectangle.3.group")
            }
            .buttonStyle(.bordered).controlSize(.small)
            .accessibilityIdentifier("popover-layout")
            Button(action: openDashboard) {
                Label("Open", systemImage: "arrow.up.right.square")
            }
            .buttonStyle(.bordered).controlSize(.small)
            .accessibilityLabel("Open full dashboard in browser")
            .accessibilityIdentifier("open-dashboard")
            .help("Open full dashboard in your browser")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .background(.regularMaterial)
        .overlay(alignment: .top) { Divider() }
    }

    private var attentionSummary: some View {
        var attention: [(String, String, String)] = model.limits.compactMap { limit -> (String, String, String)? in
            guard let window = limit.windows.compactMap({ window -> (LimitWindow, Double)? in
                guard let used = window.usedPct else { return nil }
                return (window, max(0, min(100, 100 - used)))
            }).min(by: { $0.1 < $1.1 }), window.1 <= Double(model.quotaCriticalPercent) else { return nil }
            let reset = window.0.resetsAt.map(countdown) ?? "—"
            let timing = reset == "now" ? "available now" : "resets in \(reset)"
            let identity = limit.email ?? "\(limit.provider) · \(limit.accountKey)"
            return ("\(limit.provider)@\(limit.accountKey)", identity, "\(windowDisplayName(window.0.kind, provider: limit.provider)) · \(Int(window.1.rounded()))% left · \(timing)")
        }
        if let health = model.spendHealth, health.state != "ok", let cap = health.monthlyCap {
            attention.append(("spend", "Monthly spend pace", "projected $\(String(format: "%.0f", health.projected)) / $\(String(format: "%.0f", cap))"))
        }
        attention = Array(attention.prefix(3))
        if attention.isEmpty { return AnyView(EmptyView()) }
        return AnyView(
            VStack(alignment: .leading, spacing: 4) {
                Text("Needs attention")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(.orange)
                ForEach(Array(attention.enumerated()), id: \.offset) { _, row in
                    Button {
                        if row.0 != "spend" {
                            quotaScrollTarget = row.0
                            activeSubview = .quotas
                        } else {
                            activeSubview = .reports
                        }
                    } label: {
                        HStack(spacing: 5) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundStyle(.orange)
                        Text(row.1).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(row.2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .contentShape(Rectangle())
                    .font(.caption2)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
        )
    }

    private var quotasBody: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 10) {
                    freshnessRow
                    if model.isLoading && model.today == nil {
                        loadingState
                    } else if model.limits.isEmpty {
                        emptyState("No quota accounts detected", detail: "Enable polling in Settings or scan a provider first.", icon: "chart.bar.xaxis")
                    } else {
                        limitsSection
                    }
                }
                .padding(12)
            }
            .onChange(of: quotaScrollTarget) { target in
                guard let target else { return }
                DispatchQueue.main.async {
                    withAnimation(.easeInOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .top) }
                }
            }
        }
    }

    private var tokensBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                freshnessRow
                if model.isLoading && model.today == nil {
                    loadingState
                } else {
                    tokenPulseCard
                    tokenProviderCard
                    tokenUpstreamProviderCard
                    tokenModelCard
                    tokenMixCard
                    historyCard
                }
            }
            .padding(12)
        }
    }

    private var tokenPulseCard: some View {
        let totals = tokenTotals(for: tokenPeriodKey)
        return card(title: "token pulse", icon: "number") {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(humanCount(totals.tokens))
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .monospacedDigit()
                Text("tokens · \(tokenPeriodLabel(tokenPeriodKey))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 3) {
                    metric("requests", humanCount(Double(totals.requests)))
                    metric("sessions", "\(totals.sessions)")
                    metric("cost", String(format: "$%.2f", totals.cost))
                }
            }
            if totals.tokens == 0 && totals.requests == 0 && tokenPeriodKey == "today" {
                Label("No usage recorded for this local calendar day", systemImage: "calendar")
                    .font(.caption2).foregroundStyle(.secondary)
            }
                tokenPeriodPicker
                tokenMetricPicker
        }
    }

    private var tokenProviderCard: some View {
        let slices = tokenSlices(for: tokenPeriodKey, metric: tokenMetric)
        let total = slices.reduce(0) { $0 + $1.value }
        return card(title: "by harness · \(tokenMetric.rawValue)", icon: "chart.pie.fill") {
            if slices.isEmpty {
                emptyState("No tokens recorded", detail: "Run a scan or widen the selected period.", icon: "number")
            } else {
                HStack(spacing: 14) {
                    DonutChart(slices: slices, centerLabel: tokenMetric == .cost ? String(format: "$%.2f", total) : humanCount(total), centerUnit: tokenMetric.rawValue)
                        .frame(width: 112, height: 112)
                        .accessibilityLabel("harness breakdown donut chart")
                    SpendLegend(slices: Array(slices.prefix(6)), metric: tokenMetric)
                }
            }
        }
    }

    private var tokenUpstreamProviderCard: some View {
        let slices = breakdownSlices(from: model.providerPeriods, key: tokenPeriodKey, metric: tokenMetric, customProvider: true)
        let total = slices.reduce(0) { $0 + $1.value }
        return card(title: "by provider · \(tokenMetric.rawValue)", icon: "building.2.fill") {
            if slices.isEmpty {
                emptyState("No provider attribution", detail: "Provider attribution appears when model or account routing identifies it.", icon: "questionmark.circle")
            } else {
                HStack(spacing: 14) {
                    DonutChart(slices: slices, centerLabel: tokenMetric == .cost ? String(format: "$%.2f", total) : humanCount(total), centerUnit: tokenMetric.rawValue)
                        .frame(width: 112, height: 112)
                        .accessibilityLabel("provider breakdown donut chart")
                    SpendLegend(slices: Array(slices.prefix(6)), metric: tokenMetric)
                }
            }
        }
    }

    private var tokenModelCard: some View {
        let slices = breakdownSlices(from: model.modelPeriods, key: tokenPeriodKey, metric: tokenMetric)
        let total = slices.reduce(0) { $0 + $1.value }
        return card(title: "by model · \(tokenMetric.rawValue)", icon: "cube.fill") {
            if slices.isEmpty {
                emptyState("No model usage recorded", detail: "Run a scan or widen the selected period.", icon: "number")
            } else {
                HStack(spacing: 14) {
                    DonutChart(slices: slices, centerLabel: tokenMetric == .cost ? String(format: "$%.2f", total) : humanCount(total), centerUnit: tokenMetric.rawValue)
                        .frame(width: 112, height: 112)
                        .accessibilityLabel("model breakdown donut chart")
                    SpendLegend(slices: Array(slices.prefix(6)), metric: tokenMetric)
                }
            }
        }
    }

    private var tokenMixCard: some View {
        let slices = tokenMixSlices
        let total = slices.reduce(0) { $0 + $1.value }
        return card(title: "token composition", icon: "circle.hexagongrid.circle") {
            if slices.isEmpty {
                Text("No token composition recorded yet.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 14) {
                    DonutChart(slices: slices, centerLabel: humanCount(total), centerUnit: "last 24h")
                        .frame(width: 112, height: 112)
                        .accessibilityLabel("last 24 hours token composition donut chart")
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(slices.enumerated()), id: \.offset) { _, slice in
                            HStack(spacing: 5) {
                                Circle().fill(slice.color).frame(width: 7, height: 7)
                                Text(slice.name).font(.caption2)
                                Spacer()
                                Text(humanCount(slice.value))
                                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private var historyCard: some View {
        card(title: "usage history · 30 days", icon: "chart.bar.xaxis") {
            if let history = model.history, !history.days.isEmpty, !history.series.isEmpty {
                UsageHistoryChart(history: history)
                    .frame(height: 128)
                    .accessibilityLabel("30 day token usage history")
            } else {
                Text("History appears after the first scan.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var mcpBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                freshnessRow
                card(title: "connect tokitoki to your agent", icon: "point.3.connected.trianglepath.dotted") {
                    Text("TokiToki exposes local usage, reports, and source tools through MCP. Nothing is uploaded by this setup.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 7) {
                        Circle().fill(model.mcpStatus.hasPrefix("Running") ? .green : .secondary).frame(width: 7, height: 7)
                        Text(model.mcpStatus).font(.caption2).foregroundStyle(.secondary)
                        Spacer()
                        Button(model.mcpStatus.hasPrefix("Running") ? "Stop" : "Start") {
                            AppDelegate.shared?.toggleMCP()
                        }
                        .buttonStyle(.bordered).controlSize(.mini)
                    }
                    Text("MCP uses stdio: connected agents normally start their own process. The button starts a local health process so its lifecycle is visible here.")
                        .font(.caption2).foregroundStyle(.tertiary)
                    Picker("Integration", selection: $mcpIntegration) {
                        ForEach(MCPIntegration.allCases) { integration in
                            Text(integration.title).tag(integration)
                        }
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("mcp-integration-picker")
                    Text(mcpIntegration.location)
                        .font(.caption2).foregroundStyle(.tertiary)
                    ForEach(Array(mcpIntegration.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .top, spacing: 7) {
                            Text("\(index + 1)")
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundStyle(.secondary)
                                .frame(width: 15)
                            Text(step).font(.caption2)
                        }
                    }
                    Text(mcpIntegration.snippet)
                        .font(.system(size: 10, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 7))
                    Button {
                        let board = NSPasteboard.general
                        board.clearContents()
                        board.setString(mcpIntegration.snippet, forType: .string)
                        model.pollStatus = "Copied MCP setup for \(mcpIntegration.title)"
                    } label: {
                        Label("Copy setup", systemImage: "doc.on.doc")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("copy-mcp-setup")
                }
                card(title: "available tools", icon: "wrench.and.screwdriver.fill") {
                    Text("14 local tools · read-only by default; scan_now is the only mutating operation.")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(MCPToolInfo.all) { tool in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(tool.id).font(.caption2.monospaced().weight(.semibold))
                            Text(tool.summary).font(.caption2).foregroundStyle(.secondary)
                            Text("Inputs: \(tool.inputs)").font(.caption2).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(alignment: .bottom) { Divider().opacity(0.35) }
                    }
                    Text("Run `tokitoki mcp` over stdio. Credentials and raw event transcripts are not included in the setup snippet.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(12)
        }
    }

    private var reportsBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                freshnessRow
                if model.isLoading && model.today == nil {
                    loadingState
                } else {
                    heroCard
                    if let grid = model.activityGrid { activityGridCard(grid) }
                    if !(model.today?.rows ?? []).isEmpty { pieCard() }
                    if !model.repos.isEmpty { reposCard }
                    if let repoHistory = model.repoHistory, !repoHistory.series.isEmpty {
                        card(title: "repo activity · 30 days", icon: "chart.bar.xaxis") {
                            UsageHistoryChart(history: repoHistory)
                                .frame(height: 128)
                                .accessibilityLabel("30 day repository activity history")
                        }
                    }
                }
                if !model.blocks.isEmpty {
                    card(title: "billing blocks · active timeline", icon: "clock.arrow.circlepath") {
                        ForEach(model.blocks.sorted { $0.startIso > $1.startIso }.prefix(6)) { block in
                            HStack(spacing: 6) {
                                Circle().fill(block.isActive ? .green : .secondary).frame(width: 6, height: 6)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(block.isActive ? "\(block.accountKey) · active" : block.accountKey)
                                        .font(.caption.weight(.medium)).lineLimit(1)
                                    Text("\(shortDateTime(block.startIso)) → \(shortDateTime(block.endIso)) · \(block.requests) requests")
                                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                Text(block.isActive ? countdown(block.endIso) + " left" : humanCount(block.tokens))
                                    .font(.caption2.monospacedDigit()).foregroundStyle(block.isActive ? .green : .secondary)
                            }
                        }
                    }
                }
                if let statusline = model.statuslinePreview {
                    card(title: "statusline preview", icon: "rectangle.bottomthird.inset.filled") {
                        Text(statusline.preview).font(.caption.monospaced()).textSelection(.enabled)
                        Text("Install in Claude Code with: \(statusline.command)")
                            .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                if !model.topTools.isEmpty { toolsCard }
                if let anomalyLine = model.anomalyLine {
                    card(title: "anomalies", icon: "waveform.path.ecg") {
                        Text(anomalyLine).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !model.budgets.isEmpty {
                    card(title: "budget status", icon: "gauge.with.dots.needle.67percent") {
                        ForEach(model.budgets.prefix(5), id: \.label) { budget in
                            HStack(spacing: 6) {
                                Circle().fill(color(for: budget.state)).frame(width: 6, height: 6)
                                Text(budget.label).font(.caption).lineLimit(1)
                                Spacer()
                                Text(String(format: "$%.2f / $%.2f", budget.used, budget.cap))
                                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }.padding(12)
        }
    }

    private func activityGridCard(_ grid: ActivityGridPayload) -> some View {
        card(title: "activity · last year", icon: "calendar") {
            ActivityGridView(payload: grid)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sessionsBody: some View {
        VStack(spacing: 0) {
            if let row = model.selectedSessionRow {
                sessionDetailBody(row)
            } else {
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 10) {
                        freshnessRow
                        card(title: "find conversations", icon: "text.bubble") {
                            HStack(spacing: 6) {
                                TextField("search titles and conversation text…", text: $model.sessionQuery)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.caption)
                                    .onSubmit { model.searchPopoverSessions(model.sessionQuery) }
                                Button("Search") { model.searchPopoverSessions(model.sessionQuery) }
                                    .buttonStyle(.bordered).controlSize(.small)
                            }
                            if let status = model.sessionStatus {
                                Text(status).font(.caption2).foregroundStyle(.secondary)
                                if status == "No sessions found" || status.hasPrefix("Session search failed") {
                                    HStack(spacing: 6) {
                                        Image(systemName: "info.circle")
                                        Text("The local conversation index may be missing or stale.")
                                        Button("Reindex") { model.reindexSessions() }
                                            .buttonStyle(.bordered).controlSize(.mini)
                                    }
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                                }
                            }
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(model.sessionRows) { row in
                                    Button { model.loadPopoverSession(row) } label: {
                                        VStack(alignment: .leading, spacing: 2) {
                                            HStack(spacing: 5) {
                                                Text(row.title?.isEmpty == false ? row.title! : "(no title)")
                                                    .font(.caption.weight(.semibold)).lineLimit(1)
                                                Spacer()
                                                Text("\(row.requests) req · \(humanCount(row.totalTokens))")
                                                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                                            }
                                            HighlightedSnippet(text: row.snippet ?? "No indexed conversation text for this session.")
                                                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                            Text("\(row.provider) · \(row.accountKey) · \(row.startedAt.prefix(16).replacingOccurrences(of: "T", with: " "))")
                                                .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.vertical, 6)
                                    }
                                    .buttonStyle(.plain)
                                    .contentShape(Rectangle())
                                    .overlay(alignment: .bottom) { Divider().opacity(0.3) }
                                }
                            }
                        }
                    }.padding(12)
                }
                sessionPaginationBar
            }
        }
        .onAppear {
            if model.sessionRows.isEmpty && !model.isLoading { model.searchPopoverSessions("") }
        }
        .onReceive(model.$isLoading.removeDuplicates()) { loading in
            if !loading && model.sessionRows.isEmpty && model.selectedSessionRow == nil {
                model.searchPopoverSessions(model.sessionQuery)
            }
        }
    }

    private var sessionPaginationBar: some View {
        Group {
            if model.sessionPage > 1 || model.sessionHasMore {
                HStack {
                    Button("← Previous") { model.previousPopoverSessionPage() }
                        .buttonStyle(.bordered).controlSize(.mini)
                        .disabled(model.sessionPage <= 1)
                    Spacer()
                    Text("Page \(model.sessionPage)")
                        .font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    Button("Next →") { model.nextPopoverSessionPage() }
                        .buttonStyle(.bordered).controlSize(.mini)
                        .disabled(!model.sessionHasMore)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(.regularMaterial)
                .overlay(alignment: .top) { Divider() }
            }
        }
    }

    private func sessionDetailBody(_ row: PopoverSessionRow) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Button {
                        model.clearPopoverSession()
                    } label: {
                        Label("Sessions", systemImage: "chevron.left")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    Spacer()
                    Button {
                        AppDelegate.shared?.openSessionInDashboard(provider: row.provider, sessionId: row.sessionId)
                    } label: {
                        Label("Open in web UI", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(row.title?.isEmpty == false ? row.title! : "Conversation")
                        .font(.headline).lineLimit(2)
                    Spacer()
                    Text("\(row.requests) requests")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
                Text("\(row.provider) · \(row.accountKey) · \(row.startedAt.prefix(16).replacingOccurrences(of: "T", with: " "))")
                    .font(.caption2).foregroundStyle(.secondary)
                if model.sessionEventsLoading && model.selectedSession == nil {
                    card(title: "loading conversation", icon: "hourglass") {
                        ProgressView().frame(maxWidth: .infinity, alignment: .leading)
                        Text("Loading the first 40 requests only…")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if let status = model.sessionStatus, !status.hasPrefix("Loading conversation") {
                    card(title: "session status", icon: "info.circle") {
                        Text(status)
                            .font(.caption)
                            .foregroundStyle(status.hasPrefix("Could not") ? .red : .secondary)
                    }
                }
                if let conversation = model.selectedSession?.conversation {
                    card(title: "conversation", icon: "doc.text") {
                        ConversationBodyView(rawBody: conversation.body, title: conversation.title)
                    }
                }
                if let detail = model.selectedSession, let events = detail.events, !events.isEmpty {
                    card(title: "request timeline · \(detail.eventsTotal ?? events.count)", icon: "timeline.selection") {
                        SessionTimelineView(detail: detail)
                        if detail.eventsHasMore == true {
                            Button(model.sessionEventsLoading ? "Loading…" : "Load next 40 requests") {
                                model.loadMorePopoverSessionEvents()
                            }
                            .buttonStyle(.bordered).controlSize(.small)
                            .disabled(model.sessionEventsLoading)
                            Text("Showing \(events.count) of \(detail.eventsTotal ?? events.count) requests; loading is incremental.")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .padding(12)
    }
}

private struct SessionTimelineView: View {
    let detail: PopoverSessionDetail
    @State private var hoveredIndex: Int?

    private var events: [PopoverSessionDetail.Event] { detail.events ?? [] }
    private var maximumTokens: Double {
        max(1, events.map { $0.inputTokens + $0.outputTokens + $0.cacheReadTokens + $0.cacheWriteTokens }.max() ?? 1)
    }

    private func intervalText(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds > 0 else { return "not enough evidence" }
        let minutes = max(1, Int((seconds / 60).rounded()))
        if minutes < 60 { return "\(minutes)m" }
        let hours = max(1, Int((Double(minutes) / 60).rounded()))
        if hours < 48 { return "\(hours)h" }
        return "\(max(1, Int((Double(hours) / 24).rounded())))d"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let estimate = detail.cacheDuration {
                Label("Estimated cache lifetime ≈ \(intervalText(estimate.estimatedSeconds)) · \(estimate.confidence) confidence", systemImage: "bolt.horizontal")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("Based on \(estimate.busts) observed cache reset\(estimate.busts == 1 ? "" : "s") across \(estimate.samples) requests; this is an estimate, not a provider guarantee.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if !events.isEmpty {
                if let index = hoveredIndex, events.indices.contains(index) {
                    let event = events[index]
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Request \(event.n) · \(String(event.ts.dropFirst(11).prefix(8)))")
                            .font(.caption2.weight(.semibold))
                        Text(event.description ?? "model response · \(event.model)")
                            .font(.caption2)
                            .lineLimit(2)
                        Text("\(event.model) · \(humanCount(event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens)) tokens · \(String(format: "$%.2f", event.costUsd))")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .padding(7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7))
                }
                GeometryReader { geometry in
                    HStack(alignment: .bottom, spacing: 1) {
                        ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                            let tokens = event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens
                            Button {
                                hoveredIndex = index
                            } label: {
                                Rectangle()
                                    .fill(Color.accentColor.opacity(hoveredIndex == index ? 1 : 0.72))
                                    .frame(height: max(3, geometry.size.height * CGFloat(tokens / maximumTokens)))
                            }
                            .buttonStyle(.plain)
                            .onHover { isHovering in hoveredIndex = isHovering ? index : nil }
                            .accessibilityLabel("Request \(event.n), \(String(event.ts.dropFirst(11).prefix(8))), \(event.description ?? event.model)")
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
                .frame(height: 54)
            }
            LazyVStack(alignment: .leading, spacing: 5) {
                ForEach(events) { event in
                    let eventCost = String(format: "$%.2f", event.costUsd)
                    HStack(spacing: 5) {
                        Text("\(event.n)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary).frame(width: 28, alignment: .trailing)
                        Text(String(event.ts.dropFirst(11).prefix(8))).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        Text(event.model).font(.caption2).lineLimit(1)
                        Spacer()
                        Text("\(humanCount(event.runningTokens)) · \(eventCost)")
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// Compact native conversation renderer: markdown gets readable hierarchy and
/// tool calls are summarized separately so a long transcript is not just a
/// wall of `[tool:read]` lines.
private struct ConversationBodyView: View {
    let rawBody: String
    let title: String

    private enum MarkdownBlock {
        case heading(String, Int)
        case code(String, String?)
        case quote(String)
        case list([String], Bool)
        case paragraph(String)
    }

    private func toolName(for rawLine: Substring) -> String? {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("[tool:"), let end = line.firstIndex(of: "]") {
            return String(line[line.index(line.startIndex, offsetBy: 6)..<end])
        }
        for prefix in ["tools.", "functions."] where line.hasPrefix(prefix) {
            let end = line.firstIndex(of: "(") ?? line.endIndex
            return String(line[..<end])
        }
        return nil
    }

    private var toolCounts: [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for line in rawBody.split(separator: "\n") {
            guard let name = toolName(for: line) else { continue }
            counts[name, default: 0] += 1
        }
        return counts.keys.sorted().map { ($0, counts[$0] ?? 0) }
    }

    private var readableBody: String {
        var lines = rawBody.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { toolName(for: $0) == nil }
            .map { line in
                String(line)
                    .replacingOccurrences(of: "\\[tool:[^\\]]+\\]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "(?<![\\w/])(?:tools|functions)\\.[A-Za-z0-9_./-]+(?:\\([^\\n]*\\))?", with: "", options: .regularExpression)
            }
        let normalizedTitle = title.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !normalizedTitle.isEmpty,
           let first = lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           lines[first].replacingOccurrences(of: "^[#>*-]+\\s*", with: "", options: .regularExpression).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalizedTitle {
            lines.remove(at: first)
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var readableBlocks: [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: [String] = []
        var orderedList = false
        var code: [String]?
        var codeLanguage: String?
        func flushParagraph() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { blocks.append(.paragraph(text)) }
            paragraph.removeAll(keepingCapacity: true)
        }
        func flushList() {
            if !list.isEmpty { blocks.append(.list(list, orderedList)) }
            list.removeAll(keepingCapacity: true)
        }
        func flushAll() { flushParagraph(); flushList() }
        for line in readableBody.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if code != nil {
                if trimmed.range(of: "^```\\s*$", options: .regularExpression) != nil {
                    blocks.append(.code(code!.joined(separator: "\n"), codeLanguage))
                    code = nil
                    codeLanguage = nil
                } else {
                    code!.append(line)
                }
                continue
            }
            if let match = trimmed.range(of: "^```\\s*([A-Za-z0-9_-]+)?\\s*$", options: .regularExpression) {
                flushAll()
                let marker = String(trimmed[match])
                codeLanguage = marker.replacingOccurrences(of: "^```\\s*|\\s*$", with: "", options: .regularExpression)
                if codeLanguage?.isEmpty == true { codeLanguage = nil }
                code = []
                continue
            }
            if trimmed.isEmpty { flushAll(); continue }
            if let heading = trimmed.range(of: "^#{1,6}\\s+.+$", options: .regularExpression) {
                flushAll()
                let value = String(trimmed[heading])
                let level = value.prefix(while: { $0 == "#" }).count
                blocks.append(.heading(String(value.dropFirst(level)).trimmingCharacters(in: .whitespaces), level))
                continue
            }
            if trimmed.hasPrefix(">") {
                flushAll()
                blocks.append(.quote(String(trimmed.dropFirst().trimmingCharacters(in: .whitespaces))))
                continue
            }
            if let item = trimmed.range(of: "^(?:[-*+]\\s+|[0-9]+[.)]\\s+).+$", options: .regularExpression) {
                let value = String(trimmed[item])
                let isOrdered = value.first?.isNumber == true
                if !list.isEmpty && orderedList != isOrdered { flushList() }
                orderedList = isOrdered
                list.append(value.replacingOccurrences(of: "^(?:[-*+]\\s+|[0-9]+[.)]\\s+)", with: "", options: .regularExpression))
                continue
            }
            if !list.isEmpty { flushList() }
            paragraph.append(line)
        }
        if let code { blocks.append(.code(code.joined(separator: "\n"), codeLanguage)) }
        flushAll()
        return blocks
    }

    var bodyView: some View {
        VStack(alignment: .leading, spacing: 7) {
            if !toolCounts.isEmpty {
                DisclosureGroup("Tools used · \(toolCounts.reduce(0) { $0 + $1.count })") {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(toolCounts, id: \.name) { tool in
                            Text("\(tool.name) · \(tool.count)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 3)
                }
                .font(.caption2.weight(.semibold))
            }
            if readableBody.isEmpty {
                Text("No conversation body indexed.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(Array(readableBlocks.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case let .code(text, language):
                        VStack(alignment: .leading, spacing: 4) {
                            if let language { Text(language).font(.caption2).foregroundStyle(.secondary) }
                            Text(text)
                            .font(.system(size: 10, design: .monospaced))
                            .textSelection(.enabled)
                        }
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 7))
                    case let .heading(text, level):
                        let role = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                        if role == "user" || role == "assistant" || role == "tool call" {
                            HStack(spacing: 5) {
                                Image(systemName: role == "user" ? "arrow.up.right" : role == "assistant" ? "sparkles" : "wrench.and.screwdriver")
                                Text(role)
                            }
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(role == "user" ? .blue : role == "assistant" ? .green : .orange)
                            .padding(.vertical, 3)
                        } else {
                            markdownText(text)
                                .font(level <= 2 ? .headline.weight(.semibold) : .caption.weight(.semibold))
                                .foregroundStyle(.primary)
                                .padding(.top, level <= 2 ? 3 : 0)
                        }
                    case let .quote(text):
                        markdownText(text)
                            .font(.system(size: 12))
                            .italic()
                            .padding(.leading, 8)
                            .overlay(alignment: .leading) { Rectangle().fill(.tint).frame(width: 2) }
                    case let .list(items, ordered):
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                                HStack(alignment: .firstTextBaseline, spacing: 5) {
                                    Text(ordered ? "\(index + 1)." : "•").foregroundStyle(.secondary)
                                    markdownText(item)
                                }
                            }
                        }
                    case let .paragraph(text):
                        if let markdown = try? AttributedString(markdown: text) {
                        Text(markdown)
                            .font(.system(size: 12, weight: .regular))
                            .lineSpacing(2)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                        Text(text)
                            .font(.system(size: 12, weight: .regular))
                            .lineSpacing(2)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
    }

    private func markdownText(_ text: String) -> Text {
        if let markdown = try? AttributedString(markdown: text) { return Text(markdown) }
        return Text(text)
    }

    var body: some View { bodyView }
}

/// Search snippets use `[[match]]` markers in the CLI contract. Render those
/// markers as an accent instead of exposing the implementation syntax in the
/// native popover.
private struct HighlightedSnippet: View {
    let text: String

    private var rendered: Text {
        let parts = text.split(separator: "[[", omittingEmptySubsequences: false)
        var result = Text("")
        for (index, part) in parts.enumerated() {
            let raw = String(part)
            if index == 0 {
                result = result + Text(raw)
                continue
            }
            let pieces = raw.split(separator: "]]", maxSplits: 1, omittingEmptySubsequences: false)
            if pieces.count == 2 {
                result = result + Text(String(pieces[0]))
                    .bold()
                    .foregroundColor(.orange)
                result = result + Text(String(pieces[1]))
            } else {
                result = result + Text("[[" + raw)
            }
        }
        return result
    }

    var body: some View { rendered }
}

    private var sourcesBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                freshnessRow
                card(title: "tracked sources", icon: "doc.text.magnifyingglass") {
                    Text("tokitoki reads local harness logs and keeps the dashboard projection in sync.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 5) {
                        Circle().fill(model.errorText == nil && !dataIsStale ? .green : .orange).frame(width: 6, height: 6)
                        Text(model.lastUpdatedAt.map { "Payload updated \(relativeDate($0))" } ?? "Payload is loading")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let result = model.pollLastResultDescription {
                        Text(result).font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(model.knownProviders, id: \.self) { provider in
                        HStack(spacing: 6) {
                            ProviderLogo(provider: provider)
                            Text(provider == "cursor" ? "cursor · searchable sessions" : provider).font(.caption)
                            Spacer()
                            Text("detected").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Button {
                        AppDelegate.shared?.rescanForPopover()
                    } label: {
                        Label("Re-scan sources", systemImage: "arrow.triangle.2.circlepath")
                    }.buttonStyle(.bordered).controlSize(.small)
                }
            }.padding(12)
        }
    }

    private var settingsBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                freshnessRow
                card(title: "configuration file", icon: "doc.badge.gearshape") {
                    Text("Popover, preview, polling, notification, sync, and provider-key settings are persisted here so the same file can be managed by Nix or Home Manager.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(model.configFilePath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                    Button {
                        model.openConfigFile()
                    } label: {
                        Label("Open config file", systemImage: "arrow.up.right.square")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .accessibilityIdentifier("open-config-file")
                }
                card(title: "privacy", icon: "eye.slash") {
                    Toggle("Hide account identities in the popover", isOn: Binding(
                        get: { model.privacyHideIdentities },
                        set: { model.setPrivacyHideIdentities($0) },
                    ))
                    .font(.caption)
                    Text("Emails, account ids, and credential hints are replaced with private labels locally. The config remains plain text and contains no secrets.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                card(title: "notifications & spend guard", icon: "bell.badge.fill") {
                    Toggle("Critical quota alerts", isOn: Binding(
                        get: { model.notificationsEnabled },
                        set: { model.setNotificationsEnabled($0) },
                    ))
                    .font(.caption)
                    Toggle("Notify when an exhausted quota resets", isOn: Binding(
                        get: { model.resetAwareNotifications },
                        set: { model.setResetAwareNotifications($0) },
                    ))
                    .font(.caption)
                    .disabled(!model.notificationsEnabled)
                    Picker("Alert when quota has", selection: Binding(
                        get: { model.quotaCriticalPercent },
                        set: { model.setQuotaCriticalPercent($0) },
                    )) {
                        Text("5% left").tag(5)
                        Text("10% left").tag(10)
                        Text("20% left").tag(20)
                    }
                    .pickerStyle(.menu)
                    .disabled(!model.notificationsEnabled)
                    Divider().opacity(0.35)
                    Toggle("Warn when projected spend reaches the cap", isOn: Binding(
                        get: { model.burnWarnings },
                        set: { model.setBurnWarnings($0) },
                    ))
                    .font(.caption)
                    .disabled(!model.notificationsEnabled)
                    Picker("Warn at", selection: Binding(
                        get: { model.burnWarningRatio },
                        set: { model.setBurnWarningRatio($0) },
                    )) {
                        Text("80% of monthly cap").tag(0.8)
                        Text("90% of monthly cap").tag(0.9)
                        Text("100% of monthly cap").tag(1.0)
                    }
                    .pickerStyle(.menu)
                    .disabled(!model.notificationsEnabled || !model.burnWarnings)
                    if let health = model.spendHealth {
                        Text("This month: $\(String(format: "%.2f", health.monthToDate)) · burn $\(String(format: "%.2f", health.perDay))/day · projected $\(String(format: "%.0f", health.projected))")
                            .font(.caption2)
                            .foregroundStyle(health.state == "ok" ? AnyShapeStyle(.secondary) : AnyShapeStyle(.orange))
                    } else {
                        Text("Add a monthly budget to receive burn-rate warnings.")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let status = model.notificationStatus {
                        Text(status).font(.caption2).foregroundStyle(.secondary)
                    }
                    Divider().opacity(0.35)
                    Text("Alert categories").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach([("quotaCritical", "Critical quota"), ("quotaReset", "Quota reset / recovery"), ("burnRate", "Burn-rate"), ("budget", "Budget threshold")], id: \.0) { kind, label in
                        Toggle(label, isOn: Binding(
                            get: { !model.disabledNotifications.contains(kind) },
                            set: { model.setNotificationKindEnabled(kind, enabled: $0) },
                        ))
                        .font(.caption)
                        .disabled(!model.notificationsEnabled)
                    }
                }
                card(title: "recent alerts", icon: "bell.fill") {
                    if model.notificationHistory.isEmpty {
                        Text("No alerts have been emitted yet.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(model.notificationHistory.prefix(5)) { alert in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 5) {
                                    Text(alert.title).font(.caption.weight(.semibold))
                                    Spacer()
                                    Text(relativeDateEnglish(parseISO(alert.at) ?? Date()))
                                        .font(.caption2).foregroundStyle(.tertiary)
                                }
                                Text(alert.body).font(.caption2).foregroundStyle(.secondary)
                                Text("Why: \(alert.reason)").font(.caption2).foregroundStyle(.tertiary)
                                if let kind = alert.kind {
                                    Button(model.disabledNotifications.contains(kind) ? "Enable \(model.notificationKindLabel(kind)) alerts" : "Disable \(model.notificationKindLabel(kind)) alerts") {
                                        model.setNotificationKindEnabled(kind, enabled: model.disabledNotifications.contains(kind))
                                    }
                                    .buttonStyle(.link)
                                    .font(.caption2)
                                }
                            }
                            .padding(.vertical, 3)
                            .overlay(alignment: .bottom) { Divider().opacity(0.3) }
                        }
                    }
                }
                card(title: "background quota polling", icon: "clock.arrow.circlepath") {
                    Toggle("Poll provider quotas automatically", isOn: Binding(
                        get: { model.pollAuto },
                        set: { model.setPolling(enabled: $0) },
                    ))
                    .font(.caption)
                    Text(model.pollScheduleDescription)
                        .font(.caption2).foregroundStyle(.secondary)
                    Picker("Check every", selection: Binding(
                        get: { model.pollIntervalMinutes },
                        set: { model.setPollingInterval(minutes: $0) },
                    )) {
                        Text("5 minutes").tag(5)
                        Text("15 minutes").tag(15)
                        Text("30 minutes").tag(30)
                        Text("60 minutes").tag(60)
                    }
                    .pickerStyle(.menu)
                    .disabled(!model.pollAuto)
                    Toggle("Adapt cadence near a reset", isOn: Binding(
                        get: { model.pollAdaptive },
                        set: { model.setPollingAdaptive($0) },
                    ))
                    .font(.caption)
                    .disabled(!model.pollAuto)
                    Text(model.pollAdaptive
                         ? "Adaptive mode checks every 5–30 minutes based on the nearest reset."
                         : "Fixed cadence is used while automatic polling is on.")
                        .font(.caption2).foregroundStyle(.tertiary)
                    if let status = model.pollStatus {
                        Text(status).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let result = model.pollLastResultDescription {
                        Text(result).font(.caption2).foregroundStyle(.secondary)
                    }
                    Button {
                        model.pollNow()
                    } label: {
                        Label(model.pollInFlight ? "Refreshing…" : "Refresh quotas now", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(model.pollInFlight)
                }
                card(title: "popover layout", icon: "rectangle.3.group") {
                    Text("Choose which cards appear and drag them into your preferred order.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Customize popover…") { showCustomize = true }
                        .buttonStyle(.bordered).controlSize(.small)
                    Button("Customize tabs…") { showTabSettings = true }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                card(title: "menubar preview", icon: "menubar.dock.rectangle") {
                    Text("Choose how the status item shows provider marks, percentages, and reset countdowns.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Customize preview…") { showPreviewSettings = true }
                        .buttonStyle(.bordered).controlSize(.small)
                }
                card(title: "provider API keys", icon: "key.fill") {
                    Text("Add multiple keys for providers that expose quota APIs. Each key gets its own usage card.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Manage API keys…") { showAPIKeys = true }
                    .buttonStyle(.bordered).controlSize(.small)
                }
                card(title: "index & import diagnostics", icon: "stethoscope") {
                    Text("Rebuild conversation search across Codex, Pi, Claude, Cursor, and other configured harness stores, or import a provider CSV backfill.")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 7) {
                        Button("Reindex conversations") { model.reindexSessions() }
                            .buttonStyle(.bordered).controlSize(.small)
                        Button("Import CSV…") { model.importUsageCSV() }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    if let status = model.maintenanceStatus {
                        Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                card(title: "sync", icon: "arrow.triangle.2.circlepath") {
                    Picker("Backend", selection: Binding(
                        get: { model.syncBackend ?? "none" },
                        set: { model.setSyncBackend($0) },
                    )) {
                        Text("Off").tag("none")
                        Text("Shared folder").tag("dir")
                        Text("Private Git repo").tag("git")
                        Text("AT Protocol").tag("atproto")
                    }
                    .pickerStyle(.menu)
                    if model.syncBackend == "dir" {
                        syncField("Shared folder", value: Binding(get: { model.syncPath }, set: { model.syncPath = $0 }), path: "sync.path")
                    } else if model.syncBackend == "git" {
                        syncField("Private Git URL", value: Binding(get: { model.syncUrl }, set: { model.syncUrl = $0 }), path: "sync.url")
                    } else if model.syncBackend == "atproto" {
                        syncField("Bluesky handle", value: Binding(get: { model.syncHandle }, set: { model.syncHandle = $0 }), path: "sync.handle")
                    }
                    Text(model.syncConfigured
                         ? "Backend \(model.syncBackend ?? "configured") is selected. Add its path/URL/handle in config, then sync here."
                         : "Sync is off. Choose a backend, then finish its non-secret settings in config.")
                        .font(.caption2).foregroundStyle(.secondary)
                    HStack(spacing: 7) {
                        Button("Sync now") { model.syncNow() }
                            .buttonStyle(.bordered).controlSize(.small)
                            .disabled(!model.syncConfigured)
                        if let status = model.syncStatus {
                            Text(status).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                card(title: "local dashboard", icon: "safari") {
                    Text("The browser dashboard is local-only and starts on demand. Stopping it only affects a server launched by this app.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let status = model.dashboardStatus {
                        Text(status).font(.caption2).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 7) {
                        Button("Start / open") { openDashboard() }
                            .buttonStyle(.bordered).controlSize(.small)
                        Button("Stop") { AppDelegate.shared?.stopDashboard() }
                            .buttonStyle(.bordered).controlSize(.small)
                            .disabled(model.dashboardStatus?.contains("owned") != true)
                    }
                }
            }
            .padding(12)
            .onAppear { AppDelegate.shared?.refreshDashboardStatus() }
        }
    }

    private func syncField(_ label: String, value: Binding<String>, path: String) -> some View {
        HStack(spacing: 6) {
            TextField(label, text: value)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
            Button("Save") { model.setSyncValue(path: path, value: value.wrappedValue) }
                .buttonStyle(.bordered).controlSize(.mini)
        }
    }

    private var freshnessRow: some View {
        HStack(spacing: 5) {
            Circle().fill(model.isLoading ? .orange : (model.errorText == nil && !dataIsStale ? .green : .orange)).frame(width: 6, height: 6)
            Text(model.isLoading
                ? "\(model.loadingStage) \(model.loadingCompleted)/\(model.loadingTotal)"
                : (model.lastUpdatedAt.map {
                    dataIsStale ? "Stale · updated \(relativeDate($0))" : "Updated \(relativeDate($0))"
                } ?? "Loading latest data…"))
                .font(.caption2).foregroundStyle(.secondary)
            Spacer()
            if model.pollInFlight { ProgressView().controlSize(.small) }
        }
        .accessibilityLabel(model.isLoading
            ? "Loading latest data, step \(model.loadingCompleted) of \(model.loadingTotal)"
            : (model.lastUpdatedAt.map {
                dataIsStale ? "Stale data, updated \(relativeDate($0))" : "Updated \(relativeDate($0))"
            } ?? "Loading latest data"))
    }

    private var loadingState: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Preparing your local usage snapshot")
                    .font(.caption.weight(.semibold))
            }
            Text(model.loadingStage)
                .font(.caption2).foregroundStyle(.secondary)
            ProgressView(value: Double(model.loadingCompleted), total: Double(max(1, model.loadingTotal)))
                .tint(.accentColor)
            Text("Step \(model.loadingCompleted) of \(model.loadingTotal) · your previous snapshot stays visible during refresh")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    }

    private func relativeDate(_ date: Date) -> String {
        relativeDateEnglish(date)
    }

    private func emptyState(_ title: String, detail: String, icon: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.title3).foregroundStyle(.tertiary)
            Text(title).font(.caption.weight(.semibold))
            Text(detail).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(20)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
    }

    /// Effective card order: payload layout first, defaults appended.
    /// A local drag session overrides the payload until persistence confirms.
    private func effectiveLayout() -> [(id: String, hidden: Bool)] {
        var ids = localLayout ?? model.cardLayout
        for id in Self.defaultCardOrder where !ids.contains(where: { $0.id == id }) {
            ids.append((id, false))
        }
        return ids.filter { Self.cardTitles[$0.id] != nil }
    }

    private func orderedVisibleCards() -> [String] {
        effectiveLayout().filter { !$0.hidden }.map { $0.id }
    }

    /// Persist a full card layout (order + visibility) via the CLI, updating
    /// the UI optimistically so the change shows immediately.
    private func persistCardLayout(_ layout: [(id: String, hidden: Bool)]) {
        localLayout = layout
        model.cardLayout = layout
        let cli = model.currentInvocation()
        let spec = layout.map { "\($0.id):\($0.hidden ? "0" : "1")" }.joined(separator: ",")
        Task {
            do {
                _ = try await Model.runConfigCLI(cli, ["ui", "--card-set", spec])
            } catch {
                FileHandle.standardError.write(Data("[tokitoki] card save failed: \(error)\n".utf8))
            }
            await MainActor.run { model.refresh() }
        }
    }

    @ViewBuilder private func cardBody(_ id: String) -> some View {
        switch id {
        case "limits":
            if !model.limits.isEmpty { limitsSection }
        case "usage":
            if !(model.today?.rows ?? []).isEmpty { pieCard() }
        case "spend":
            heroCard
        case "harness":
            harnessCard
        case "activity":
            if model.activeOtherMachines > 0 { activityCard }
        case "anomalies":
            anomaliesRow
        case "repos":
            if !model.repos.isEmpty { reposCard }
        case "tools":
            if !model.topTools.isEmpty { toolsCard }
        default:
            EmptyView()
        }
    }

    /// Search field styled like the system: magnifier + rounded inset field.
    private var searchBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.caption).foregroundStyle(.secondary)
            TextField("search harness, account, repo…", text: $searchText)
                .textFieldStyle(.plain)
                .font(.caption)
                .autocorrectionDisabled()
            if searchActive {
                Button { searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption).foregroundStyle(.secondary)
                }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("popover-search")
    }

    /// The two detailed browser surfaces are visible from the primary
    /// popover, instead of being discoverable only through right-click.
    private var webDashboardLinks: some View {
        HStack(spacing: 7) {
            Label("Browser dashboard", systemImage: "safari")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            Button("Reports") { activeSubview = .reports }
                .controlSize(.mini)
                .help("Show reports inside the popover")
            Button("Sources") { activeSubview = .sources }
                .controlSize(.mini)
                .help("Show tracked sources inside the popover")
            Menu {
                Button("Open full dashboard") { openWebDashboard("/") }
                Button("Open web reports") { openWebDashboard("/?view=reports&last=month") }
                Button("Open web sources") { openWebDashboard("/?view=sources") }
            } label: {
                Image(systemName: "arrow.up.right.square")
            }
            .menuStyle(.borderlessButton)
            .controlSize(.mini)
            .help("Open the full dashboard in your browser")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8))
    }

    private func openWebDashboard(_ path: String) {
        AppDelegate.shared?.openLocalDashboard(path: path)
    }

    /// Capture the popover content and write it as a PNG on the Desktop,
    /// then reveal it in Finder.
    private func saveScreenshot() {
        guard let view = popoverContentAnchorView() else { return }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let desktop = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop")
        let url = desktop.appendingPathComponent("tokitoki-popover-\(stamp).png")
        do {
            try data.write(to: url)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            FileHandle.standardError.write(Data("[tokitoki] screenshot write failed: \(error)\n".utf8))
        }
    }

    /// Plain-text markdown digest of the current payload → clipboard.
    private func copyMarkdownSummary() {
        var md = "# tokitoki summary\n\n_\(DateFormatter.localizedString(from: Date(), dateStyle: .long, timeStyle: .short))_\n\n"
        if let today = model.today {
            md += "**Today**: \(String(format: "$%.2f", today.total.costUsd)) · \(humanCount(Double(today.total.requests))) requests · \(today.total.sessions) sessions\n"
        }
        if let week = model.week {
            md += "**This week**: \(String(format: "$%.2f", week.total.costUsd))\n"
        }
        if !model.limits.isEmpty {
            md += "\n## Accounts\n\n| harness | account | windows |\n|---|---|---|\n"
            for l in model.limits {
                let wins = l.windows.map { w -> String in
                    let pct = w.usedPct.map { " \(Int(max(0, min(100, 100 - $0))))% left" } ?? " \(humanCount(w.tokens))"
                    return "\(windowDisplayName(w.kind, provider: l.provider)):\(pct)"
                }.joined(separator: " · ")
                let who = l.email ?? l.credential ?? l.accountKey
                md += "| \(l.provider) | \(who) | \(wins) |\n"
            }
        }
        if !model.repos.isEmpty {
            md += "\n## Top repos (month)\n\n"
            for r in model.repos.sorted(by: { $0.costUsd > $1.costUsd }).prefix(5) {
                md += "- **\(repoName(r.bucket))** — \(repoUsage(r))\n"
            }
        }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(md, forType: .string)
    }

    /// The popover's key-window content view (anchor for the sharing picker).
    private func popoverContentAnchorView() -> NSView? {
        NSApp.keyWindow?.contentView ?? NSApp.windows.first { $0.isVisible }?.contentView
    }

    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespaces)
    }

    /// Today-by-harness rows (search-filtered).
    private var harnessCard: some View {
        let rows = (model.today?.rows ?? [])
            .filter { matches($0.bucket) }
            .sorted { $0.costUsd > $1.costUsd || ($0.costUsd == $1.costUsd && $0.requests > $1.requests) }
        return card(title: "today by harness", icon: "chart.bar.fill") {
            ForEach(Array(rows.prefix(7).enumerated()), id: \.offset) { _, row in
                HStack(spacing: 6) {
                    ProviderLogo(provider: row.bucket)
                    Text(row.bucket).font(.caption).lineLimit(1)
                    Spacer()
                    Text("\(humanCount(Double(row.requests))) req")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    Text(row.costUsd > 0 ? String(format: "$%.2f", row.costUsd) : "$0")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(row.costUsd > 0 ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var activityCard: some View {
        card(title: "other machines", icon: "network") {
            Label("\(model.activeOtherMachines) other machine\(model.activeOtherMachines == 1 ? "" : "s") active", systemImage: "circle.fill")
                .foregroundStyle(.green).font(.caption)
        }
    }

    private var toolsCard: some View {
        compactList(
            title: "top tools today",
            icon: "wrench.and.screwdriver.fill",
            rows: model.topTools
                .filter { matches($0.tool) }
                .map { ($0.tool, $0.costUsd >= 0.01 ? String(format: "$%.2f", $0.costUsd) : humanCount($0.tokens)) }
        )
    }

    /// Legend rows for the usage donut, honoring the search filter.
    private func spendPeriodRows(for requestedKey: String? = nil) -> [ReportRow] {
        let selectedKey = requestedKey ?? spendPeriodKey
        let rows: [ReportRow]
        if let period = model.spendPeriods.first(where: { $0.key == selectedKey }) {
            rows = period.rows
        } else if selectedKey == "today", let today = model.today {
            rows = today.rows
        } else {
            rows = []
        }
        return rows.filter { matches($0.bucket) }
    }

    private var tokenPeriodPicker: some View {
        HStack(spacing: 0) {
            ForEach(Self.spendPeriodOrder, id: \.self) { key in
                if key == "custom" {
                    Button {
                        showTokenRange = true
                    } label: {
                        Text(Self.spendPeriodLabels[key] ?? key)
                            .font(.caption2.weight(tokenPeriodKey == key ? .semibold : .regular))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(tokenPeriodKey == key ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Button {
                        tokenPeriodKey = key
                    } label: {
                        Text(Self.spendPeriodLabels[key] ?? key)
                            .font(.caption2.weight(tokenPeriodKey == key ? .semibold : .regular))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(tokenPeriodKey == key ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .background(.quaternary.opacity(0.35), in: Capsule())
        .accessibilityIdentifier("token-period-picker")
    }

    private var tokenMetricPicker: some View {
        HStack(spacing: 0) {
            ForEach([SpendMetric.tokens, SpendMetric.cost], id: \.self) { metric in
                Button {
                    if tokenPeriodKey != "custom" || metric == .tokens { tokenMetric = metric }
                } label: {
                    Text(metric.rawValue)
                        .font(.caption2.weight(tokenMetric == metric ? .semibold : .regular))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(tokenMetric == metric ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(tokenPeriodKey == "custom" && metric == .cost)
            }
        }
        .background(.quaternary.opacity(0.35), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tokenPeriodLabel(_ key: String) -> String {
        if key == "today" { return "Today · calendar day" }
        return Self.spendPeriodLabels[key] ?? key
    }

    private func tokenRows(for key: String) -> [ReportRow] {
        if key == "today", let today = model.today {
            return today.rows.filter { matches($0.bucket) }
        }
        return spendPeriodRows(for: key)
    }

    private func breakdownSlices(from periods: [SpendPeriod], key: String, metric: SpendMetric = .tokens, customProvider: Bool = false) -> [(name: String, value: Double, color: Color)] {
        let rows: [ReportRow]
        if key == "custom" {
            rows = customProvider ? model.customProviderRows : model.customModelRows
        } else if let period = periods.first(where: { $0.key == key }) {
            rows = period.rows
        } else {
            return []
        }
        return colorizeSlices(rows.map { (name: $0.bucket, value: metric == .cost ? $0.costUsd : $0.totalTokens) })
    }

    private func tokenTotals(for key: String) -> (tokens: Double, cost: Double, requests: Int, sessions: Int) {
        if key == "today", let p = model.today {
            return (p.total.totalTokens, p.total.costUsd, p.total.requests, p.total.sessions)
        }
        if key == "week", let p = model.week {
            return (p.total.totalTokens, p.total.costUsd, p.total.requests, p.total.sessions)
        }
        if key == "custom" {
            let tokens = customTokenSlices.reduce(0) { $0 + $1.value }
            return (tokens, 0, 0, 0)
        }
        let rows = tokenRows(for: key)
        return (
            rows.reduce(0) { $0 + $1.totalTokens },
            rows.reduce(0) { $0 + $1.costUsd },
            rows.reduce(0) { $0 + $1.requests },
            rows.reduce(0) { $0 + $1.sessions }
        )
    }

    private func tokenSlices(for key: String, metric: SpendMetric = .tokens) -> [(name: String, value: Double, color: Color)] {
        if key == "custom" { return metric == .tokens ? customTokenSlices : [] }
        return colorizeSlices(tokenRows(for: key).map { (name: $0.bucket, value: metric == .cost ? $0.costUsd : $0.totalTokens) })
    }

    private var customTokenSlices: [(name: String, value: Double, color: Color)] {
        if !model.customHarnessRows.isEmpty {
            return colorizeSlices(model.customHarnessRows.map { (name: $0.bucket, value: $0.totalTokens) })
        }
        guard let history = model.history else { return [] }
        let from = localDayKey(customTokenFrom)
        let to = localDayKey(customTokenTo)
        return colorizeSlices(history.series.map { series in
            let value = history.days.indices.reduce(0) { total, index in
                let day = history.days[index]
                guard day >= from && day <= to else { return total }
                return total + (index < series.values.count ? series.values[index] : 0)
            }
            return (name: series.bucket, value: value)
        })
    }

    private func colorizeSlices(_ values: [(name: String, value: Double)]) -> [(name: String, value: Double, color: Color)] {
        let filtered = values.filter { $0.value > 0 }.sorted { $0.value > $1.value }
        let colors = ChartColorRegistry.colors(for: filtered.map(\.name))
        return filtered.map { (name: $0.name, value: $0.value, color: colors[$0.name] ?? bucketColor($0.name)) }
    }

    private func localDayKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private var tokenMixSlices: [(name: String, value: Double, color: Color)] {
        guard let total = (model.rollingDay ?? model.today)?.total else { return [] }
        return [
            ("input", total.inputTokens ?? 0, Color(red: 0.30, green: 0.64, blue: 0.98)),
            ("output", total.outputTokens ?? 0, Color(red: 0.95, green: 0.44, blue: 0.30)),
            ("cache read", total.cacheReadTokens ?? 0, Color(red: 0.22, green: 0.78, blue: 0.48)),
            ("cache write", total.cacheWriteTokens ?? 0, Color(red: 0.66, green: 0.45, blue: 0.90)),
        ].filter { $0.value > 0 }
    }

    private var heroCard: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle().fill(.blue).frame(width: 8, height: 8)
                    Text("ACTIVITY TODAY").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                Text(model.today.map { String(format: "$%.2f", $0.total.costUsd) } ?? "—")
                    .font(.system(size: 30, weight: .bold, design: .rounded)).monospacedDigit()
                Text(model.today.map { "\(humanCount(Double($0.total.requests))) requests" } ?? "loading…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 7) {
                metric("this week", model.week.map { String(format: "$%.0f", $0.total.costUsd) } ?? "—")
                metric("month to date", model.spendHealth.map { String(format: "$%.2f", $0.monthToDate) } ?? "—")
                metric("burn · projected", model.spendHealth.map { String(format: "$%.2f → $%.0f", $0.perDay, $0.projected) } ?? "—")
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.semibold)).monospacedDigit()
        }
    }

    // MARK: - v3: per-account limit cards (the hero)

    /// Account cards in drag-saved order (payload order as fallback).
    private func orderedAccounts() -> [AccountLimits] {
        let all = model.limits.filter { accountCardVisible($0) }
        if let local = model.accountOrderOverride {
            let rank = { (l: AccountLimits) in local.firstIndex(of: "\(l.provider)@\(l.accountKey)") ?? local.count }
            return all.sorted { rank($0) < rank($1) }
        }
        return all
    }

    /// ui.hidden.menubar semantics: an entry is either a bare harness id
    /// ("codex") or a "harness:accountKey" pair.
    private func accountCardVisible(_ l: AccountLimits) -> Bool {
        !model.menubarHidden.contains(l.provider)
            && !model.menubarHidden.contains("\(l.provider):\(l.accountKey)")
    }

    /// Persist a new account-card order via the CLI, optimistically.
    private func persistAccountOrder(_ ids: [String]) {
        model.invalidateRefreshes()
        model.accountOrderOverride = ids
        let cli = model.currentInvocation()
        Task {
            do {
                _ = try await Model.runConfigCLI(cli, ["ui", "--account-order", ids.joined(separator: ",")])
            } catch {
                FileHandle.standardError.write(Data("[tokitoki] account order save failed: \(error)\n".utf8))
            }
            await MainActor.run { model.refresh() }
        }
    }

    @ViewBuilder private var limitsSection: some View {
        // Cards render directly on the popover surface — each account card is
        // its own container; no extra wrapping card.
        let visible = orderedAccounts().filter { accountMatches($0) }
        VStack(alignment: .leading, spacing: 8) {
            LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { idx, l in
                let accountId = "\(l.provider)@\(l.accountKey)"
                AccountLimitCard(
                    limits: l,
                    isRefreshing: model.refreshingAccounts.contains(accountId),
                    onRefresh: { model.refreshAccount(l) },
                    onHide: { model.hideAccount(l) },
                    budgets: matchingBudgets(for: l),
                    tokenScale: tokenMaxima(model.limits),
                    privacyMode: model.privacyHideIdentities,
                )
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                    .id(accountId)
                    .accessibilityLabel("limit-card-\(l.provider)-\(l.accountKey)")
                    .onDrag {
                        draggingAccount = accountId
                        return NSItemProvider(object: accountId as NSString)
                    }
                    .onDrop(of: [UTType.plainText], delegate: ReorderDropDelegate(
                        target: accountId,
                        dragging: $draggingAccount,
                        onMove: { dragged in
                            var ids = orderedAccounts().map { "\($0.provider)@\($0.accountKey)" }
                            guard let from = ids.firstIndex(of: dragged),
                                  let to = ids.firstIndex(of: accountId) else { return }
                            withAnimation(.easeInOut(duration: 0.15)) {
                                ids.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
                            }
                            persistAccountOrder(ids)
                        }
                    ))
            }
            }
            consoleLinksRow
            unmatchedBudgetsRow
        }
        .accessibilityIdentifier("limits-section")
    }

    /// Budgets whose pattern targets this specific account.
    func matchingBudgets(for l: AccountLimits) -> [BudgetRow] {
        model.budgets.filter { b in
            guard let pattern = budgetPatternLabel(of: b) else { return false }
            return budgetMatchesPattern(pattern, l.accountKey)
        }
    }

    /// Global / unmatched budgets collapse into one slim row-group.
    @ViewBuilder private var unmatchedBudgetsRow: some View {
        let unmatched = model.budgets.filter { b in
            guard let pattern = budgetPatternLabel(of: b) else { return true }
            return !model.limits.contains { budgetMatchesPattern(pattern, $0.accountKey) }
        }
        if !unmatched.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(unmatched, id: \.label) { b in
                    HStack(spacing: 4) {
                        Circle().fill(color(for: b.state)).frame(width: 5, height: 5)
                        Text(b.label).font(.caption2).lineLimit(1)
                        Spacer()
                        Text(String(format: "$%.2f / $%.0f", b.used, b.cap))
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// openusage-style links to each provider's console/status page.
    @ViewBuilder private var consoleLinksRow: some View {
        let providers = Array(Set(model.limits.map(\.provider))).sorted()
        let known = providers.compactMap { p -> (String, URL)? in
            guard let url = Self.consoleURL(p) else { return nil }
            return (Model.shortTag(p), url)
        }
        if !known.isEmpty {
            HStack(spacing: 6) {
                Text("consoles").font(.caption2).foregroundStyle(.tertiary)
                ForEach(known, id: \.0) { tag, url in
                    Button { NSWorkspace.shared.open(url) } label: {
                        Text(tag + " ↗").font(.caption2.monospacedDigit())
                    }.buttonStyle(.bordered).controlSize(.mini)
                }
                Spacer()
            }
        }
    }

    static func consoleURL(_ provider: String) -> URL? {
        switch provider {
        case "claude-code": return URL(string: "https://claude.ai/settings/usage")
        case "codex": return URL(string: "https://platform.openai.com/usage")
        case "openrouter": return URL(string: "https://openrouter.ai/activity")
        case "opencode-go", "opencode": return URL(string: "https://opencode.ai/zen")
        case "gemini-cli": return URL(string: "https://aistudio.google.com/usage")
        case "cursor": return URL(string: "https://cursor.com/dashboard")
        default: return nil
        }
    }

    // MARK: - v3: donut spend distribution (openusage-style pie)

    @State private var spendPeriodKey = "today"
    /// Donut sizing metric: USD cost or total tokens.
    @State private var spendMetric: SpendMetric = .cost

    private static let spendPeriodOrder = ["today", "yesterday", "week", "month", "year", "custom"]
    private static let spendPeriodLabels = ["today": "Today", "yesterday": "Yest", "week": "Week", "month": "Month", "year": "Year", "custom": "Custom…"]

    /// Slices for the selected spend period + metric. Falls back to today's
    /// report when the payload predates the spendPeriods field.
    private func pieSlices(metric: SpendMetric) -> [(name: String, value: Double, color: Color)] {
        // spendPeriodRows() honors the popover search filter.
        let rows = spendPeriodRows()
        return colorizeSlices(rows.map { (name: $0.bucket, value: metric == .cost ? $0.costUsd : $0.totalTokens) })
    }

    private func sliceValue(_ value: Double, metric: SpendMetric) -> String {
        metric == .cost ? String(format: "$%.2f", value) : humanCount(value)
    }

    private var topSpenders: [ReportRow] {
        (model.today?.rows ?? []).filter { $0.costUsd > 0 }.sorted { $0.costUsd > $1.costUsd }
    }

    private var spendPeriodPicker: some View {
        HStack(spacing: 0) {
            ForEach(Self.spendPeriodOrder, id: \.self) { key in
                Button {
                    spendPeriodKey = key
                } label: {
                    Text(Self.spendPeriodLabels[key] ?? key)
                        .font(.caption2.weight(spendPeriodKey == key ? .semibold : .regular))
                        .monospacedDigit()
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(
                            spendPeriodKey == key
                                ? AnyShapeStyle(.quaternary.opacity(0.9))
                                : AnyShapeStyle(.clear)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .background(.quaternary.opacity(0.35), in: Capsule())
        .accessibilityIdentifier("spend-period-picker")
    }

    private func pieCard() -> some View {
        let slices = pieSlices(metric: spendMetric)
        let total = slices.reduce(0) { $0 + $1.value }
        return card(title: "usage distribution", icon: "chart.pie.fill") {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    spendPeriodPicker
                    metricPicker
                }
                HStack(spacing: 14) {
                    DonutChart(slices: slices, centerLabel: sliceValue(total, metric: spendMetric), centerUnit: spendMetric.rawValue)
                        .frame(width: 100, height: 100)
                        .accessibilityLabel("spend-pie-chart")
                    SpendLegend(slices: Array(slices.prefix(5)), metric: spendMetric)
                    Spacer(minLength: 0)
                }
            }
        }
        .accessibilityIdentifier("pie-section")
    }

    /// cost ⇄ tokens toggle for the donut (openusage-style).
    private var metricPicker: some View {
        let options: [SpendMetric] = [.cost, .tokens]
        return HStack(spacing: 0) {
            ForEach(options, id: \.self) { m in
                metricOption(m)
            }
        }
        .background(.quaternary.opacity(0.35), in: Capsule())
        .accessibilityIdentifier("spend-metric-picker")
    }

    private func metricOption(_ m: SpendMetric) -> some View {
        let selected = spendMetric == m
        return Button {
            spendMetric = m
        } label: {
            Text(m.rawValue)
                .font(.caption2.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(selected ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func card<Content: View>(title: String, icon: String, @ViewBuilder content: @escaping () -> Content) -> some View {
        CollapsibleCard(title: title, icon: icon, content: content)
    }

    /// CodexBar-style per-repo usage: name + $cost · tokens on one line,
    /// full path underneath; tap a row to expand the request/session/cache
    /// breakdown.
    @ViewBuilder private var reposCard: some View {
        card(title: "top repos this month", icon: "folder.fill") {
            ForEach(Array(model.repos.filter { matches($0.bucket) }.sorted { $0.costUsd > $1.costUsd || ($0.costUsd == $1.costUsd && $0.totalTokens > $1.totalTokens) }.prefix(6).enumerated()), id: \.offset) { i, r in
                VStack(alignment: .leading, spacing: 1) {
                    Button { expandedRepo = expandedRepo == repoName(r.bucket) ? nil : repoName(r.bucket) } label: {
                        HStack(spacing: 6) {
                            Text(repoName(r.bucket))
                                .font(.caption).lineLimit(1)
                            Spacer()
                            Text(repoUsage(r))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(r.costUsd > 0 ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            Image(systemName: "chevron.right")
                                .font(.system(size: 7, weight: .bold))
                                .rotationEffect(.degrees(expandedRepo == repoName(r.bucket) ? 90 : 0))
                                .foregroundStyle(.tertiary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if r.bucket.contains("/") {
                        Text(r.bucket)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    if expandedRepo == repoName(r.bucket) {
                        Text("\(humanCount(Double(r.requests))) requests · \(r.sessions) sessions · cache \(cacheShare(r))%")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .padding(.top, 1)
                    }
                }
                .padding(.vertical, i == 0 ? 0 : 1)
            }
        }
    }

    /// Share of tokens served from cache (0 when nothing recorded).
    private func cacheShare(_ r: ReportRow) -> Int {
        let total = r.totalTokens
        guard total > 0 else { return 0 }
        return Int(((r.cacheReadTokens ?? 0) + (r.cacheWriteTokens ?? 0)) / total * 100)
    }

    private func repoName(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    private func repoUsage(_ r: ReportRow) -> String {
        let tok = humanCount(r.totalTokens)
        if r.costUsd >= 0.01 { return String(format: "$%.2f", r.costUsd) + " · " + tok }
        return tok + " tokens"
    }

    @ViewBuilder private func compactList(title: String, icon: String, rows: [(String, String)]) -> some View {
        card(title: title, icon: icon) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, item in
                HStack { Text(item.0).font(.caption).lineLimit(1); Spacer(); Text(item.1).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
        }
    }

    @ViewBuilder
    private func section(title: String, payload: ReportPayload?) -> some View {
        Text(title).font(.caption).bold()
        if let p = payload {
            row("cost", String(format: "$%.2f", p.total.costUsd))
            row("requests", humanCount(Double(p.total.requests)))
            row("sessions", "\(p.total.sessions)")
            row("cache %", cachePct(p))
            if p.burn.projected > 0 {
                row("burn", String(format: "$%.0f/day → $%.0f mo-end", p.burn.perDay, p.burn.projected))
            }
            ForEach(p.rows.sorted { $0.costUsd > $1.costUsd || ($0.costUsd == $1.costUsd && $0.requests > $1.requests) }.prefix(4), id: \.bucket) { r in
                HStack {
                    Text("  \(r.bucket)").font(.caption).lineLimit(1)
                    Spacer()
                    Text(r.costUsd > 0 ? String(format: "$%.2f", r.costUsd) : "\(humanCount(Double(r.requests))) req")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        } else {
            Text("loading…").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption)
            Spacer()
            Text(value).font(.caption.monospacedDigit())
        }
    }

    private func cachePct(_ p: ReportPayload) -> String {
        let total = p.total.totalTokens
        guard total > 0 else { return "—" }
        return "\(Int(round((p.total.cacheReadTokens ?? 0) / total * 100)))%"
    }

    @ViewBuilder
    private var anomaliesRow: some View {
        if let line = model.anomalyLine {
            Text(line).font(.caption).foregroundStyle(.orange).lineLimit(1)
        }
    }

    private func color(for state: String) -> Color {
        switch state {
        case "exceeded": return .red
        case "warn": return .orange
        default: return .green
        }
    }

    private func openDashboard() {
        AppDelegate.shared?.openLocalDashboard(path: "/")
    }
}

// MARK: - v3 views


/// Budget labels look like "<pattern> <scope>"; no pattern → global budget.
func budgetPatternLabel(of b: BudgetRow) -> String? {
    let parts = b.label.split(separator: " ").map(String.init)
    guard let last = parts.last, ["daily", "weekly", "monthly"].contains(last), parts.count > 1 else {
        return nil
    }
    return parts.dropLast().joined(separator: " ")
}

/// Exact match, or trailing `*` prefix match (same as budgets config).
func budgetMatchesPattern(_ pattern: String, _ key: String) -> Bool {
    pattern.hasSuffix("*") ? key.hasPrefix(pattern.dropLast()) : pattern == key
}

// MARK: - provider identity (SF-Symbol marks tinted with official brand colors)

/// Recognizable per-provider mark. No bundled trademark assets: SF-Symbol
/// approximations tinted with each vendor's brand color, consistent size.
/// Minimal SVG path-data parser covering the command subset used by
/// simple-icons glyphs (M L H V C S Q T A Z and relatives). Arcs are converted
/// to cubic Béziers via the standard kappa endpoint-parameterization.
private enum SvgPath {
    static func path(_ d: String) -> Path {
        var p = Path()
        var i = d.startIndex
        var cmd: Character = " "
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastCtrl: CGPoint? = nil // implicit control for S/T

        func number() -> CGFloat {
            skipSeparators(&i, d)
            var neg = false
            if i < d.endIndex, d[i] == "-" { neg = true; i = d.index(after: i) }
            else if i < d.endIndex, d[i] == "+" { i = d.index(after: i) }
            var v = 0.0 as CGFloat
            while i < d.endIndex, d[i].isNumber || d[i] == "." {
                if d[i] == "." {
                    i = d.index(after: i)
                    var frac = CGFloat(0.1)
                    while i < d.endIndex, d[i].isNumber {
                        v += frac * CGFloat(d[i].wholeNumberValue ?? 0)
                        frac *= 0.1
                        i = d.index(after: i)
                    }
                    break
                }
                v = v * 10 + CGFloat(d[i].wholeNumberValue ?? 0)
                i = d.index(after: i)
            }
            // exponent support (rare in icon sets)
            if i < d.endIndex, d[i] == "e" || d[i] == "E" {
                let next = d.index(after: i)
                if next < d.endIndex, d[next].isNumber || d[next] == "-" || d[next] == "+" {
                    let exp = number()
                    v *= pow(10, exp)
                }
            }
            return neg ? -v : v
        }
        func skipSeparators(_ i: inout String.Index, _ s: String) {
            while i < s.endIndex, s[i] == " " || s[i] == "," { i = s.index(after: i) }
        }
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
        func curveTo(_ c1: CGPoint, _ c2: CGPoint, _ to: CGPoint) {
            p.addCurve(to: to, control1: c1, control2: c2)
            cur = to
            lastCtrl = c2
        }
        func arc(_ r1: CGFloat, _ r2: CGFloat, _ phiDeg: CGFloat, _ large: Bool, _ sweep: Bool, _ to: CGPoint) {
            // Endpoint → center parameterization (W3C SVG spec F.6.5).
            if r1 == 0 || r2 == 0 {
                p.addLine(to: to); cur = to; return
            }
            let phi = phiDeg * .pi / 180
            let cosP = cos(phi), sinP = sin(phi)
            let dx = (cur.x - to.x) / 2, dy = (cur.y - to.y) / 2
            let x1 = cosP * dx + sinP * dy
            let y1 = -sinP * dx + cosP * dy
            var rx = abs(r1), ry = abs(r2)
            let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
            if lambda > 1 {
                let s = sqrt(lambda)
                rx *= s; ry *= s
            }
            let sign: CGFloat = large != sweep ? 1 : -1
            let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
            let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
            let co = sign * sqrt(max(0, num / den))
            let cxp = co * rx * y1 / ry
            let cyp = -co * ry * x1 / rx
            let cx = cosP * cxp - sinP * cyp + (cur.x + to.x) / 2
            let cy = sinP * cxp + cosP * cyp + (cur.y + to.y) / 2
            func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
                let dot = ux * vx + uy * vy
                let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
                var a = acos(min(1, max(-1, dot / len)))
                if ux * vy - uy * vx < 0 { a = -a }
                return a
            }
            let th1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
            var dth = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
            if !sweep && dth > 0 { dth -= 2 * .pi }
            if sweep && dth < 0 { dth += 2 * .pi }
            let segments = Int(ceil(abs(dth) / (.pi / 2)))
            let delta = dth / CGFloat(segments)
            let k = 4.0 / 3.0 * tan(delta / 4)
            var t = th1
            for _ in 0..<segments {
                let cosT = cos(t), sinT = sin(t)
                let t2 = t + delta
                // pt's parameters are (cos θ, sin θ, ellipse x-rotation φ):
                // the sweep angle feeds the trig pair; the third parameter is
                // the SVG x-axis rotation. Calling pt(1, 1, t) evaluated every
                // point at radius r·√2 around a phantom rotation — garbling
                // all arcs.
                func pt(_ a: CGFloat, _ b: CGFloat, _ rot: CGFloat) -> CGPoint {
                    point(cx + rx * a * cos(rot) - ry * b * sin(rot),
                          cy + rx * a * sin(rot) + ry * b * cos(rot))
                }
                let e1 = pt(cosT, sinT, phi)
                let e2 = pt(cos(t2), sin(t2), phi)
                // Derivative of the parametric ellipse point w.r.t. the angle:
                // d/dt P(t) = (-rx·sin t·cosφ − ry·cos t·sinφ, −rx·sin t·sinφ + ry·cos t·cosφ).
                // The previous version had cos/sin swapped here, corrupting
                // every arc (circles rendered as bow-ties).
                func deriv(_ ang: CGFloat) -> CGPoint {
                    point(-rx * sin(ang) * cosP - ry * cos(ang) * sinP,
                          -rx * sin(ang) * sinP + ry * cos(ang) * cosP)
                }
                let d1 = point(k * deriv(t).x, k * deriv(t).y)
                let d2 = point(k * deriv(t2).x, k * deriv(t2).y)
                let c1 = point(e1.x + d1.x, e1.y + d1.y)
                let c2 = point(e2.x - d2.x, e2.y - d2.y)
                curveTo(c1, c2, e2)
                t = t2
            }
        }

        while i < d.endIndex {
            skipSeparators(&i, d)
            guard i < d.endIndex else { break }
            if d[i].isLetter {
                cmd = d[i]
                i = d.index(after: i)
            }
            switch cmd {
            case "M", "m":
                let x = number(), y = number()
                let pt = cmd == "m" ? point(cur.x + x, cur.y + y) : point(x, y)
                p.move(to: pt)
                cur = pt; start = pt; lastCtrl = nil
                cmd = cmd == "m" ? "l" : "L" // subsequent pairs are lineto
            case "L", "l":
                let x = number(), y = number()
                let to = cmd == "l" ? point(cur.x + x, cur.y + y) : point(x, y)
                p.addLine(to: to); cur = to; lastCtrl = nil
            case "H", "h":
                let x = number()
                let to = point(cmd == "h" ? cur.x + x : x, cur.y)
                p.addLine(to: to); cur = to; lastCtrl = nil
            case "V", "v":
                let y = number()
                let to = point(cur.x, cmd == "v" ? cur.y + y : y)
                p.addLine(to: to); cur = to; lastCtrl = nil
            case "C", "c":
                let a1 = number(), a2 = number(), a3 = number(), a4 = number(), a5 = number(), a6 = number()
                let rel = cmd == "c"
                let c1 = rel ? point(cur.x + a1, cur.y + a2) : point(a1, a2)
                let c2 = rel ? point(cur.x + a3, cur.y + a4) : point(a3, a4)
                let to = rel ? point(cur.x + a5, cur.y + a6) : point(a5, a6)
                curveTo(c1, c2, to)
            case "S", "s":
                let a1 = number(), a2 = number(), a3 = number(), a4 = number()
                let rel = cmd == "s"
                let c1: CGPoint
                if let lc = lastCtrl { c1 = point(2 * cur.x - lc.x, 2 * cur.y - lc.y) } else { c1 = cur }
                let c2 = rel ? point(cur.x + a1, cur.y + a2) : point(a1, a2)
                let to = rel ? point(cur.x + a3, cur.y + a4) : point(a3, a4)
                curveTo(c1, c2, to)
            case "Q", "q":
                let a1 = number(), a2 = number(), a3 = number(), a4 = number()
                let rel = cmd == "q"
                let qc = rel ? point(cur.x + a1, cur.y + a2) : point(a1, a2)
                let to = rel ? point(cur.x + a3, cur.y + a4) : point(a3, a4)
                let c1 = point(cur.x + 2 / 3 * (qc.x - cur.x), cur.y + 2 / 3 * (qc.y - cur.y))
                let c2 = point(to.x + 2 / 3 * (qc.x - to.x), to.y + 2 / 3 * (qc.y - to.y))
                curveTo(c1, c2, to)
            case "T", "t":
                let a1 = number(), a2 = number()
                let rel = cmd == "t"
                let qc: CGPoint
                if let lc = lastCtrl { qc = point(2 * cur.x - lc.x, 2 * cur.y - lc.y) } else { qc = cur }
                let to = rel ? point(cur.x + a1, cur.y + a2) : point(a1, a2)
                let c1 = point(cur.x + 2 / 3 * (qc.x - cur.x), cur.y + 2 / 3 * (qc.y - cur.y))
                let c2 = point(to.x + 2 / 3 * (qc.x - to.x), to.y + 2 / 3 * (qc.y - to.y))
                curveTo(c1, c2, to)
            case "A", "a":
                let r1 = number(), r2 = number(), rot = number()
                let laf = number() != 0
                let sf = number() != 0
                let x = number(), y = number()
                let to = cmd == "a" ? point(cur.x + x, cur.y + y) : point(x, y)
                arc(r1, r2, rot, laf, sf, to)
            case "Z", "z":
                if cur != start { p.addLine(to: start) }
                p.closeSubpath()
                cur = start; lastCtrl = nil
            default:
                // Unknown command — abort parsing rather than corrupt the glyph.
                i = d.endIndex
            }
        }
        return p
    }
}

/// Official brand marks (CC0 path data from the simple-icons project, 24×24
/// viewBox) rendered as vectors — recognizable logos instead of SF-symbol
/// approximations. Providers without an available mark fall back to their
/// previous glyph.
enum BrandIcon {
    static let openai = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
    static let anthropic = "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"
    static let cursor = "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
    static let googlegemini = "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
    static let x = "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"
    static let opencode = "M22 24H2V0h20zM17 4.8H7v14.4h10z"
    // GitHub Copilot mascot mark from simple-icons (24×24 viewBox).
    static let githubcopilot = "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"

    /// Provider id → mark, nil = no official vector available (caller falls
    /// back to its own glyph).
    static func forProvider(_ provider: String) -> Path? {
        let d: String?
        switch provider {
        case "codex", "openai": d = openai
        case "claude-code", "claude": d = anthropic
        case "cursor": d = cursor
        case "gemini-cli": d = googlegemini
        case "copilot": d = githubcopilot
        case "grok": d = x
        case "opencode", "opencode-go": d = opencode
        default: d = nil
        }
        guard let d else { return nil }
        let s: CGFloat = 14.0 / 24.0
        return SvgPath.path(d).applying(CGAffineTransform(scaleX: s, y: s))
    }
}

struct ProviderLogo: View {
    let provider: String

    var body: some View {
        Group {
            if let vector = BrandIcon.forProvider(provider) {
                AnyView(vector.fill(Self.brandColor(provider)))
            } else if provider == "pi" {
                // The agent's own glyph: bold π reads instantly at caption size.
                AnyView(Text("π")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(Self.brandColor(provider)))
            } else {
                AnyView(Image(systemName: Self.symbol(provider))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Self.brandColor(provider)))
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityLabel(provider)
    }

    static func symbol(_ p: String) -> String {
        switch p {
        case "claude-code": return "asterisk"
        case "codex": return "hexagon.fill"
        case "cursor": return "cursorarrow.rays"
        case "gemini-cli": return "sparkle"
        case "copilot": return "person.crop.circle.fill"
        case "grok": return "xmark"
        case "openrouter": return "arrow.triangle.branch"
        case "pi", "opencode-go", "opencode": return "diamond.fill"
        case "t3code", "antigravity-cli": return "triangle.fill"
        default: return "circle.fill"
        }
    }

    static func brandColor(_ p: String) -> Color {
        switch p {
        case "claude-code", "claude": return Color(red: 0.851, green: 0.467, blue: 0.341) // #D97757 Anthropic clay
        case "codex", "openai": return Color(red: 0.063, green: 0.639, blue: 0.498)  // #10A37F OpenAI
        case "cursor": return Color(red: 0.400, green: 0.400, blue: 0.440)
        case "gemini-cli": return Color(red: 0.259, green: 0.522, blue: 0.957)  // #4285F4
        case "copilot": return .primary
        case "grok": return .primary
        case "openrouter": return Color(red: 0.545, green: 0.361, blue: 0.965)  // #8B5CF6
        case "pi", "opencode-go", "opencode": return Color(red: 0.655, green: 0.545, blue: 0.980) // #A78BFA violet
        default: return .accentColor
        }
    }
}

/// One chart palette shared by donut sectors, legends, and history bars.
/// Swift's `hashValue` is intentionally randomized per process, so use a
/// tiny deterministic FNV-1a hash for unknown model/tool names instead.
enum ChartColorRegistry {
    /// Deliberately separated hues. The previous six-color fallback mapped
    /// unrelated models/providers to near-identical violet/pink colors.
    private static let palette: [Color] = [
        Color(red: 0.11, green: 0.58, blue: 0.96), // blue
        Color(red: 0.96, green: 0.55, blue: 0.12), // orange
        Color(red: 0.08, green: 0.70, blue: 0.48), // emerald
        Color(red: 0.84, green: 0.24, blue: 0.89), // magenta
        Color(red: 0.04, green: 0.72, blue: 0.78), // cyan
        Color(red: 0.98, green: 0.25, blue: 0.39), // rose
        Color(red: 0.55, green: 0.38, blue: 0.94), // violet
        Color(red: 0.65, green: 0.78, blue: 0.12), // lime
        Color(red: 0.96, green: 0.36, blue: 0.20), // vermilion
        Color(red: 0.16, green: 0.78, blue: 0.68), // turquoise
        Color(red: 0.38, green: 0.45, blue: 0.95), // indigo
        Color(red: 0.95, green: 0.30, blue: 0.64), // pink
    ]

    private static func hash(_ name: String) -> Int {
        var value: UInt64 = 14695981039346656037
        for byte in name.utf8 {
            value ^= UInt64(byte)
            value &*= 1099511628211
        }
        return Int(value % UInt64(palette.count))
    }

    /// Allocate a distinct palette slot for every peer in one chart. This
    /// keeps the assignment deterministic while preventing exact collisions
    /// when a chart has several models with similar names.
    static func colors(for names: [String]) -> [String: Color] {
        var result: [String: Color] = [:]
        var used = Set<Int>()
        for name in Array(Set(names)).sorted() {
            let start = hash(name)
            let index = (0..<palette.count)
                .map { (start + $0) % palette.count }
                .first { !used.contains($0) } ?? start
            used.insert(index)
            result[name] = palette[index]
        }
        return result
    }

    static func color(for name: String) -> Color {
        colors(for: [name])[name] ?? palette[0]
    }

    static func color(for name: String, among peers: [String]) -> Color {
        colors(for: peers)[name] ?? color(for: name)
    }
}

func bucketColor(_ name: String, peers: [String] = []) -> Color {
    peers.isEmpty ? ChartColorRegistry.color(for: name) : ChartColorRegistry.color(for: name, among: peers)
}

/// CodexBar-style per-account limit card: primary window bar + resets-in
/// countdown, stacked secondary windows, banked resets. Raw token numbers
/// when no quota denominator is known (honest: no fake percentages).
/// Per-kind max token totals across all accounts (bar normalization).
private func tokenMaxima(_ limits: [AccountLimits]) -> [String: Double] {
    var maxima: [String: Double] = [:]
    for l in limits {
        for w in l.windows { maxima[w.kind] = max(maxima[w.kind] ?? 0, w.tokens) }
    }
    return maxima
}

struct AccountLimitCard: View {
    let limits: AccountLimits
    let isRefreshing: Bool
    let onRefresh: () -> Void
    let onHide: () -> Void
    /// Budget rows whose pattern matches this account — rendered as a slim footer.
    var budgets: [BudgetRow] = []
    /// Per-kind max token totals across ALL accounts — used to normalize
    /// progress bars for windows without a real quota denominator so every
    /// card renders bars consistently (fill = tokens / kind-max, clamped).
    var tokenScale: [String: Double] = [:]
    /// Local-only redaction for screenshots/shared screens.
    var privacyMode = false
    /// openusage-style collapsible "details" disclosure.
    @State private var showDetails = false
    /// Account cards default open but can be collapsed independently.
    @State private var isExpanded = true

    private var orderedWindows: [LimitWindow] {
        let order = ["day": 0, "week": 1, "month": 2]
        return lwindows.sorted { (order[$0.kind] ?? 9) < (order[$1.kind] ?? 9) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            headerRow
            if isExpanded {
                ForEach(Array(orderedWindows.enumerated()), id: \.offset) { _, w in
                    windowBarRow(w)
                }
                if orderedWindows.isEmpty {
                    Text("no usage recorded").font(.caption2).foregroundStyle(.tertiary)
                }
                bankedRow
                if !budgets.isEmpty { budgetFooter }
                detailsDisclosure
            }
        }
        .padding(.vertical, 2)
    }

    /// Collapsible per-window detail rows — compact: window name + reset date
    /// (no source jargon, no durations). Data provenance lives in a tooltip.
    @ViewBuilder private var detailsDisclosure: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { showDetails.toggle() } } label: {
                HStack(spacing: 3) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .rotationEffect(.degrees(showDetails ? 90 : 0))
                        Text("Details · source and reset dates")
                        .font(.caption2)
                    Spacer()
                }
                .foregroundStyle(.tertiary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("limit-details-toggle")
            if showDetails {
                VStack(alignment: .leading, spacing: 2) {
                    // Provenance ALWAYS shown — users must be able to tell
                    // where an account's numbers come from (SCR-ffhr).
                    let originNote = originExplanation(limits.origin ?? "scan")
                    Text("source: \(originNote)")
                        .font(.caption2).foregroundStyle(.tertiary)
                        .lineLimit(1)
                    if let observed = limits.observedAt, let date = parseISO(observed) {
                        Text("last observed " + date.formatted(date: .abbreviated, time: .shortened) + (limits.freshness == "stale" ? " · stale" : ""))
                            .font(.caption2).foregroundStyle(limits.freshness == "stale" ? AnyShapeStyle(.orange) : AnyShapeStyle(.tertiary))
                    } else if limits.freshness == "unknown" {
                        Text("no provider observation available")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                    ForEach(Array(orderedWindows.enumerated()), id: \.offset) { _, w in
                        HStack(spacing: 6) {
                            Text(windowDisplayName(w.kind, provider: limits.provider))
                                .font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            if let r = w.resetsAt, let target = parseISO(r) {
                                Text("resets " + target.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                            }
                        }
                        .help(sourceExplanation(w.source))
                    }
                }
                .padding(.top, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    /// Account-level provenance line for the details disclosure.
    private func originExplanation(_ origin: String) -> String {
        switch origin {
        case "polled": return "polled live from the provider API"
        case "opencodex": return "read from the opencodex account pool"
        case "manual": return "from a manually registered key"
        case "scan": return "estimated from locally scanned sessions (no provider-reported quota)"
        default: return origin
        }
    }

    /// Plain-language explanation of where a window's numbers come from.
    private func sourceExplanation(_ source: String) -> String {
        switch source {
        case "embedded": return "reported directly by the provider"
        case "polled": return "fetched live from the provider API (tokitoki poll)"
        default: return "estimated from recorded usage — the provider does not report this limit locally"
        }
    }

    /// openusage-style labeled bar per window: name · bar · % left / resets-in.
    /// The track ALWAYS renders (empty fill at zero usage); fill tint follows
    /// the traffic palette when a real % exists, emerald otherwise.
    private func windowBarRow(_ w: LimitWindow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(windowDisplayName(w.kind, provider: limits.provider))
                    .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                if let pct = w.usedPct {
                    let remaining = max(0, min(100, 100 - pct))
                    HStack(spacing: 4) {
                        Text(w.source == "embedded" ? "Reported" : "Estimated")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text("\(Int(remaining.rounded()))% left")
                            .font(.caption2.monospacedDigit().weight(.semibold))
                            .foregroundStyle(barTint(remaining))
                    }
                } else if w.tokens > 0 {
                    Text("Estimated · \(humanCount(w.tokens)) tokens")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            progressBarRow(w)
            HStack {
                Spacer()
                if let r = w.resetsAt {
                    let reset = countdown(r)
                    Text(reset == "now" ? "Available now" : "Resets in " + reset)
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder private func progressBarRow(_ w: LimitWindow) -> some View {
        if let pct = w.usedPct {
            let remaining = max(0, min(100, 100 - pct))
            explicitProgressBar(fraction: remaining / 100, tint: barTint(remaining))
        } else if w.tokens > 0, let scale = tokenScale[w.kind], scale > 0 {
            // No real quota denominator (estimate window): RELATIVE bar vs the
            // largest same-kind window — informational only. Use an explicit
            // blue tint; semantic secondary colors can resolve to black in a
            // dark/translucent popover and make a filled bar look broken.
            let frac = min(1.0, max(0.05, w.tokens / scale))
            explicitProgressBar(fraction: frac, tint: Color(red: 0.33, green: 0.62, blue: 0.96))
        } else {
            // Zero usage: empty track so every window keeps its row rhythm.
            Capsule()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 4)
        }
    }

    /// Native ProgressView tinting varies between macOS control styles. A
    /// capsule pair keeps the track and fill deterministic on translucent
    /// popovers, including the dark appearance shown by the menubar app.
    private func explicitProgressBar(fraction: Double, tint: Color) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.16))
                Capsule()
                    .fill(tint)
                    .frame(width: max(2, proxy.size.width * max(0, min(1, fraction))))
            }
        }
        .frame(height: 6)
    }

    private var budgetFooter: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(budgets, id: \.label) { b in
                HStack(spacing: 4) {
                    Image(systemName: b.state == "exceeded" ? "exclamationmark.circle.fill" : "chart.bar.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(color(for: b.state))
                    Text(b.label).font(.caption2).lineLimit(1)
                    Spacer()
                    Text(String(format: "$%.2f / $%.0f", b.used, b.cap))
                        .font(.caption2.monospacedDigit()).foregroundStyle(color(for: b.state))
                    if let d = b.daysLeft {
                        Text(String(format: "%.0fd left", d))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.top, 3)
    }

    private var headerRow: some View {
        HStack(spacing: 5) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .foregroundStyle(.secondary)
                    .frame(width: 18, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(isExpanded ? "Collapse" : "Expand") account card")
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.quaternary)
                .help("drag to reorder")
            ProviderLogo(provider: limits.provider)
            VStack(alignment: .leading, spacing: 1) {
                Text(accountPrimaryLabel)
                    .font(.caption.weight(.medium)).lineLimit(1)
                Text(accountSecondaryLabel)
                    .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer()
            Button(action: onRefresh) {
                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(isRefreshing)
            .accessibilityIdentifier("refresh-limit-\(limits.provider)-\(limits.accountKey)")
            .help(limits.origin == "scan" ? "Re-scan \(limits.provider)" : "Refresh quotas for \(limits.provider)")
            Button(action: onHide) {
                Image(systemName: "eye.slash")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Hide \(limits.provider) \(limits.accountKey) card")
            .accessibilityIdentifier("hide-limit-\(limits.provider)-\(limits.accountKey)")
            .help("Hide this card; restore it in Customize")
            planBadge
        }
    }

    private var accountPrimaryLabel: String {
        if privacyMode { return "Private account" }
        if let email = limits.email, !email.isEmpty { return email }
        if let cred = limits.credential, !cred.isEmpty { return "\(limits.provider) \(cred)" }
        return limits.provider
    }

    private var accountSecondaryLabel: String {
        if privacyMode { return limits.provider + " · identities hidden" }
        var label = limits.accountKey
        if let also = limits.alsoOn, !also.isEmpty {
            label += " · via " + also.joined(separator: ", ")
        }
        return label
    }

    @ViewBuilder private var planBadge: some View {
        if let plan = limits.planLabel {
            Text(plan.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(.quaternary.opacity(0.6), in: Capsule())
        }
    }

    @ViewBuilder private var bankedRow: some View {
        if let banked = limits.bankedResets, banked > 0 {
            HStack(spacing: 3) {
                Image(systemName: "banknote.fill").font(.caption2)
                Text("\(banked) banked reset\(banked == 1 ? "" : "s")")
                if let exp = limits.bankedExpiresAt {
                    Text("(expires " + shortDateTime(exp) + " · " + countdown(exp) + ")")
                }
            }
            .font(.caption2).foregroundStyle(.mint)
        }
    }

    // `limits` shadows the member when accessed unqualified inside SwiftUI
    // property initializers; explicit accessor keeps the intent obvious.
    private var lwindows: [LimitWindow] { limits.windows }
}

/// Donut metric selector.
enum SpendMetric: String {
    case cost
    case tokens
}

private func windowDisplayName(_ kind: String, provider: String? = nil) -> String {
    switch kind {
    case "day":
        return provider == "codex" || provider == "claude-code" || provider == "commandcode" ? "Session" : "Day"
    case "week": return "Weekly"
    case "month": return "Monthly"
    default: return kind.capitalized
    }
}


private func shortDate(_ iso: String) -> String {
    String(iso.prefix(10))
}

private func shortDateTime(_ iso: String) -> String {
    guard let date = parseISO(iso) else { return shortDate(iso) }
    return date.formatted(date: .abbreviated, time: .shortened)
}

/// Humanized time-until-reset ("4h 12m", "3d", "42m").
func countdown(_ iso: String?) -> String {
    guard let iso, let target = parseISO(iso) else { return "—" }
    return countdown(target)
}

func countdown(_ target: Date) -> String {
    let secs = Int(target.timeIntervalSinceNow)
    if secs <= 0 { return "now" }
    let d = secs / 86_400
    let h = (secs % 86_400) / 3_600
    let m = (secs % 3_600) / 60
    if d >= 1 { return "\(d)d \(h)h" }
    if h >= 1 { return "\(h)h \(m)m" }
    return "\(m)m"
}

/// The app's copy is English even when macOS uses another locale. Keeping the
/// formatter locale explicit avoids strings such as "Updated il y a 1 minute".
func relativeDateEnglish(_ date: Date, relativeTo now: Date = Date()) -> String {
    if abs(date.timeIntervalSince(now)) < 5 { return "just now" }
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: "en_US")
    formatter.unitsStyle = .full
    return formatter.localizedString(for: date, relativeTo: now)
}

/// Parsers live behind type-level statics: file-scope `let`s declared after
/// the top-level app.run() are NOT reliably initialized when first touched
/// from inside the run loop (observed: formatOptions came back 0 → every
/// countdown rendered "—"). Statics on a type get guaranteed lazy init.
private enum IsoParsers {
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain = ISO8601DateFormatter()
}

/// Tolerant parse: payload timestamps may omit fractional seconds.
func parseISO(_ s: String) -> Date? {
    IsoParsers.fractional.date(from: s) ?? IsoParsers.plain.date(from: s)
}

private func providerConsoleURL(_ provider: String) -> URL? {
    switch provider {
    case "claude-code": return URL(string: "https://claude.ai/settings/usage")
    case "codex": return URL(string: "https://platform.openai.com/usage")
    case "openrouter": return URL(string: "https://openrouter.ai/activity")
    case "opencode-go", "opencode": return URL(string: "https://opencode.ai/zen")
    case "gemini-cli": return URL(string: "https://aistudio.google.com/usage")
    case "cursor": return URL(string: "https://cursor.com/dashboard")
    default: return nil
    }
}

private func color(for state: String) -> Color {
    switch state {
    case "exceeded": return .red
    case "warn": return .orange
    default: return .green
    }
}

/// openusage-style traffic colors (softer emerald/amber/rose per user pref).
private func barTint(_ remaining: Double) -> Color {
    switch remaining {
    case ..<20: return Color(red: 0.94, green: 0.26, blue: 0.35)   // rose
    case ..<50: return Color(red: 1.0, green: 0.62, blue: 0.04)    // amber
    default: return Color(red: 0.16, green: 0.78, blue: 0.47)      // emerald
    }
}

/// openusage-style ring: hairline angular gaps between sectors, rounded
/// sector corners, golden-ratio hole, minimum sliver share so tiny providers
/// stay visible; center carries the period total. Ported from openusage's
/// RingSectorShape.
struct DonutChart: View {
    let slices: [(name: String, value: Double, color: Color)]
    var centerLabel: String? = nil
    var centerUnit: String? = nil

    private static let innerRadiusRatio: CGFloat = 0.618
    private static let gapWidth: CGFloat = 1.6
    private static let cornerRadius: CGFloat = 3
    private static let minimumSliceShare = 0.025

    var body: some View {
        let total = slices.reduce(0) { $0 + $1.value }
        return ZStack {
            if total > 0 {
                ForEach(Array(arcs(total: total).enumerated()), id: \.offset) { _, arc in
                    RingSectorShape(startFraction: arc.start, endFraction: arc.end)
                        .fill(arc.color)
                }
            }
            if let centerLabel {
                VStack(spacing: 1) {
                    Text(centerLabel)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .foregroundStyle(.primary)
                    if let centerUnit {
                        Text(centerUnit)
                            .font(.system(size: 8, weight: .medium))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 8)
            }
        }
        .accessibilityHidden(false)
    }

    /// Ranked slices as cumulative ring fractions with the min-sliver floor
    /// applied and renormalized so the ring closes exactly.
    private func arcs(total: Double) -> [(start: Double, end: Double, color: Color)] {
        let floored = slices.map { max($0.value / total, Self.minimumSliceShare) }
        let sum = floored.reduce(0, +)
        var out: [(start: Double, end: Double, color: Color)] = []
        var cursor = 0.0
        for (i, slice) in slices.enumerated() {
            let width = floored[i] / sum
            out.append((cursor, cursor + width, slice.color))
            cursor += width
        }
        return out
    }
}

/// One donut sector with hairline angular gaps and rounded corners (openusage
/// RingSectorShape). Fractions run clockwise from 12 o'clock, 0...1.
struct RingSectorShape: Shape {
    var startFraction: Double
    var endFraction: Double
    var innerRadiusRatio: CGFloat = 0.618
    var gapWidth: CGFloat = 1.6
    var cornerRadius: CGFloat = 3

    func path(in rect: CGRect) -> Path {
        let outer = Double(min(rect.width, rect.height) / 2)
        let inner = outer * Double(innerRadiusRatio)
        let center = CGPoint(x: rect.midX, y: rect.midY)

        // Angles in radians; screen y grows downward → increasing angles read
        // clockwise from noon.
        let top = -Double.pi / 2
        let halfGap = Double(gapWidth) / outer / 2
        let a0 = top + startFraction * 2 * .pi + halfGap
        let a1 = top + endFraction * 2 * .pi - halfGap
        let width = a1 - a0
        guard width > 0.001 else { return Path() }

        // Corners shrink on narrow slices so the two corner arcs of one edge
        // never cross.
        let s = sin(min(width / 2, .pi / 2))
        var corner = min(Double(cornerRadius), (outer - inner) / 2)
        corner = min(corner, outer * s / (1 + s))
        if s < 1 {
            corner = min(corner, inner * s / (1 - s))
        }

        if corner < 0.25 {
            return plainWedge(center: center, inner: inner, outer: outer, a0: a0, a1: a1)
        }
        return roundedWedge(center: center, inner: inner, outer: outer, a0: a0, a1: a1, corner: corner)
    }

    private func plainWedge(center: CGPoint, inner: Double, outer: Double, a0: Double, a1: Double) -> Path {
        var path = Path()
        path.addArc(center: center, radius: outer, startAngle: .radians(a0), endAngle: .radians(a1), clockwise: false)
        path.addArc(center: center, radius: inner, startAngle: .radians(a1), endAngle: .radians(a0), clockwise: true)
        path.closeSubpath()
        return path
    }

    private func roundedWedge(center: CGPoint, inner: Double, outer: Double, a0: Double, a1: Double, corner: Double) -> Path {
        let betaOuter = asin(min(1, corner / (outer - corner)))
        let betaInner = asin(min(1, corner / (inner + corner)))

        func polar(_ radius: Double, _ angle: Double) -> CGPoint {
            CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
        }
        func around(_ point: CGPoint, _ radius: Double, _ angle: Double) -> CGPoint {
            CGPoint(x: point.x + radius * cos(angle), y: point.y + radius * sin(angle))
        }

        var path = Path()
        path.addArc(center: center, radius: outer, startAngle: .radians(a0 + betaOuter), endAngle: .radians(a1 - betaOuter), clockwise: false)
        let trailingOuter = polar(outer - corner, a1 - betaOuter)
        path.addArc(center: trailingOuter, radius: corner, startAngle: .radians(a1 - betaOuter), endAngle: .radians(a1 + .pi / 2), clockwise: false)
        let trailingInner = polar(inner + corner, a1 - betaInner)
        path.addLine(to: around(trailingInner, corner, a1 + .pi / 2))
        path.addArc(center: trailingInner, radius: corner, startAngle: .radians(a1 + .pi / 2), endAngle: .radians(a1 - betaInner + .pi), clockwise: false)
        path.addArc(center: center, radius: inner, startAngle: .radians(a1 - betaInner), endAngle: .radians(a0 + betaInner), clockwise: true)
        let leadingInner = polar(inner + corner, a0 + betaInner)
        path.addArc(center: leadingInner, radius: corner, startAngle: .radians(a0 + betaInner + .pi), endAngle: .radians(a0 + 3 * .pi / 2), clockwise: false)
        let leadingOuter = polar(outer - corner, a0 + betaOuter)
        path.addLine(to: around(leadingOuter, corner, a0 - .pi / 2))
        path.addArc(center: leadingOuter, radius: corner, startAngle: .radians(a0 + 3 * .pi / 2), endAngle: .radians(a0 + betaOuter), clockwise: false)
        path.closeSubpath()
        return path
    }
}



/// Legend beside the donut: name + absolute value per slice ($ or tokens).
struct SpendLegend: View {
    let slices: [(name: String, value: Double, color: Color)]
    var metric: SpendMetric = .cost

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(slices.enumerated()), id: \.offset) { _, slice in
                HStack(spacing: 5) {
                    // The legend is part of the chart contract: use the exact
                    // sector color instead of independently-derived provider
                    // branding (which made every model dot pink).
                    Circle()
                        .fill(slice.color)
                        .frame(width: 8, height: 8)
                    Text(slice.name).font(.caption2).lineLimit(1)
                    Spacer()
                    Text(metric == .cost ? String(format: "$%.2f", slice.value) : humanCount(slice.value))
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
