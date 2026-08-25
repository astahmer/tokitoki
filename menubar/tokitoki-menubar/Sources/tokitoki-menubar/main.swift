import SwiftUI
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
    let period: String
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
    let email: String?
    /** Redacted api-key/credential hint ("sk-x…12ab") when key-based. */
    let credential: String?
    let planLabel: String?
    let windows: [LimitWindow]
    let bankedResets: Int?
    let bankedExpiresAt: String?

    var id: String { "\(provider)@\(accountKey)" }
}

struct UiPreviewConfig: Codable {
    let previewLines: Int?
    let previewMode: String? // "inline" | "hover"
    // Provider visibility (context-menu Settings ▸ toggles).
    let providers: [String]?
    let menubarHidden: [String]?
}

// Combined snapshot from `tokitoki menubar-payload --json` (single CLI
// process instead of seven parallel ones that thrashed memory).
/// Provider cost rows for one selectable period (today|yesterday|week|month).
/// Backed by `tokitoki report --by provider --sort cost --json` per period.
struct SpendPeriod: Codable {
    let key: String
    let rows: [ReportRow]
}

struct MenubarPayload: Codable {
    let today: ReportPayload
    let week: ReportPayload
    let reposMonth: ReportPayload?
    let budgets: [BudgetRow]
    let anomalies: AnomaliesPayload?
    let topTools: ToolsPayload?
    let presence: [MachineHeartbeat]?
    let limits: [AccountLimits]?
    let uiPreview: UiPreviewConfig?
    let spendPeriods: [SpendPeriod]?
}

@MainActor
final class Model: ObservableObject {
    @Published var title: String = "…"
    @Published var today: ReportPayload?
    @Published var week: ReportPayload?
    @Published var repos: [ReportRow] = []
    @Published var topTools: [ToolRow] = []
    @Published var activeOtherMachines = 0
    @Published var budgets: [BudgetRow] = []
    @Published var anomalyLine: String?
    @Published var limits: [AccountLimits] = []
    @Published var previewMode: String = "inline"
    /// (provider, % remaining) pairs behind the status-item preview — drives
    /// the attributed title with inline brand logos.
    @Published var previewEntries: [(provider: String, remaining: Int)] = []
    @Published var knownProviders: [String] = []
    @Published var menubarHidden: Set<String> = []
    @Published var spendPeriods: [SpendPeriod] = []
    /// nil = no budgets configured; "ok" | "warn" | "exceeded"
    @Published var worstState: String?
    @Published var errorText: String?

    private var timer: Timer?
    private var invocation: CLIInvocation = CLIInvocation(executable: URL(fileURLWithPath: "/usr/bin/false"), prefixArgs: [])
    private var lastLevels: [String: Int] = [:]
    private var notifiedKeys: Set<String> = []

    private static let debug = ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_DEBUG"] == "1"

    /// Env-gated stderr tracing (`TOKITOKI_MENUBAR_DEBUG=1`) — no-op normally.
    fileprivate func dbg(_ msg: @autoclosure () -> String) {
        if Self.debug { FileHandle.standardError.write(Data(("[tokitoki-menubar] " + msg() + "\n").utf8)) }
    }

    /// Accessor for AppDelegate context-menu actions.
    func currentInvocation() -> CLIInvocation { invocation }

    func start(invocation: CLIInvocation) {
        self.invocation = invocation
        dbg("start · exec=\(invocation.executable.path) prefix=\(invocation.prefixArgs)")
        notifiedKeys = Self.loadNotifiedKeys()
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

    func refresh() {
        Task { @MainActor in
            do {
                let p = try await Self.runJSON(MenubarPayload.self, invocation, ["menubar-payload", "--json"])!
                dbg("fetched · budgets=\(p.budgets.count) anomalies=\(p.anomalies?.anomalies.count ?? -1) limits=\(p.limits?.count ?? -1)")
                if let ui = p.uiPreview {
                    self.previewMode = ui.previewMode ?? "inline"
                    self.knownProviders = ui.providers ?? []
                    self.menubarHidden = Set(ui.menubarHidden ?? [])
                }
                self.spendPeriods = p.spendPeriods ?? []
                self.today = p.today
                self.week = p.week
                self.currentPayloadForTitle = p
                self.currentPreviewCfg = p.uiPreview
                if let rm = p.reposMonth {
                    self.repos = Array(rm.rows.sorted { $0.requests > $1.requests }.prefix(3))
                }
                self.topTools = Array((p.topTools?.tools ?? []).prefix(3))
                let local = ProcessInfo.processInfo.hostName
                self.activeOtherMachines = (p.presence ?? []).filter { $0.state == "active" && $0.machineId != local }.count
                applyBudgets(p.budgets)
                self.limits = p.limits ?? []
                self.previewMode = p.uiPreview?.previewMode ?? "inline"
                let maxLines = p.uiPreview?.previewLines ?? 3
                previewEntries = (p.limits ?? []).compactMap { l in
                    guard let w = Model.primaryWindow(l), let pct = w.usedPct else { return nil }
                    return (l.provider, Int(max(0, min(100, 100 - pct)).rounded()))
                }.prefix(maxLines).map { $0 }
                let newTitle = composeTitle(today: p.today, preview: Self.previewText(p.limits ?? [], cfg: p.uiPreview), hovering: isHovering, mode: self.previewMode)
                setTitleIfChanged(newTitle)
                self.errorText = nil
                applyAnomalies(p.anomalies)
                AppDelegate.shared?.refreshProofIfShown()
                // Test-mode diagnostics don't require the popover to be open.
                if ProcessInfo.processInfo.environment["TOKITOKI_MENUBAR_TEST"] == "1" {
                    AppDelegate.shared?.writeTestProof()
                }
            } catch {
                self.errorText = "\(error.localizedDescription)"
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

        // Notify only on transitions INTO warn/exceeded (not while staying there).
        // State is persisted BEFORE attempting delivery so a crash/missing
        // bundle can never cause re-notification spam.
        dbg("levels=\(current) notified=\(notifiedKeys.count)")
        for (label, level) in current where level > 0 {
            let prev = lastLevels[label] ?? 0
            guard level > prev else { continue }
            let key = "\(label)|\(level)"
            guard !notifiedKeys.contains(key) else { continue }
            notifiedKeys.insert(key)
            let row = rows.first { $0.label == label }
            saveNotifiedKeys()
            dbg("transition · \(key) · state-file=\(Self.stateFileURL.path)")
            notify(label: label, level: level, used: row?.used ?? 0, cap: row?.cap ?? 0)
        }
        lastLevels = current
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

    private static func loadNotifiedKeys() -> Set<String> {
        guard let data = try? Data(contentsOf: stateFileURL),
              let keys = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return Set(keys)
    }

    private func saveNotifiedKeys() {
        let url = Self.stateFileURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(Array(notifiedKeys).sorted()) {
            try? data.write(to: url)
        }
    }

    private func notify(label: String, level: Int, used: Double, cap: Double) {
        // UNUserNotificationCenter hard-crashes outside a real .app bundle
        // (bare swift-build binary): degrade to badge-only in that case.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return } // badge already reflects the state
            let content = UNMutableNotificationContent()
            content.title = "tokitoki budget \(level)%"
            content.body = "\(label): $\(String(format: "%.2f", used)) / $\(String(format: "%.2f", cap))"
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request)
        }
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
    static func primaryWindow(_ l: AccountLimits) -> LimitWindow? {
        l.windows.first { $0.usedPct != nil } ?? l.windows.first
    }

    /// Status-item preview: per account, EVERY quota-bearing window's remaining
    /// % space-separated (openusage kqvu style — e.g. Claude shows "44% 99%"),
    /// accounts joined by " · ". No icons/tags; the status bar is text-only.
    static func previewText(_ limits: [AccountLimits], cfg: UiPreviewConfig?) -> String? {
        let maxLines = cfg?.previewLines ?? 3
        guard maxLines > 0 else { return nil }
        var groups: [String] = []
        for l in limits {
            let pcts = l.windows.compactMap { w -> String? in
                guard let pct = w.usedPct else { return nil }
                let remaining = Int(max(0, min(100, 100 - pct)).rounded())
                return "\(remaining)%"
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
                                 preview: Self.previewText(p?.limits ?? [], cfg: currentPreviewCfg),
                                 hovering: isHovering,
                                 mode: previewMode)
            setTitleIfChanged(t)
        }
    }
    var currentPayloadForTitle: MenubarPayload?
    var currentPreviewCfg: UiPreviewConfig?
    var trackingArea: NSTrackingArea?

    static func runJSON<T: Decodable>(_ type: T.Type, _ cli: CLIInvocation, _ args: [String]) async throws -> T? {
        let out = try await runCLI(cli, args)
        guard !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let data = out.data(using: .utf8) else { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func runCLI(_ cli: CLIInvocation, _ args: [String]) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let proc = Process()
                proc.executableURL = cli.executable
                proc.arguments = cli.prefixArgs + args
                let pipe = Pipe()
                let errPipe = Pipe()
                proc.standardOutput = pipe
                proc.standardError = errPipe
                do {
                    try proc.run()
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    proc.waitUntilExit()
                    if proc.terminationStatus == 0 {
                        cont.resume(returning: String(data: data, encoding: .utf8) ?? "")
                    } else {
                        let err = errPipe.fileHandleForReading.readDataToEndOfFile()
                        let msg = String(data: err, encoding: .utf8) ?? "exit \(proc.terminationStatus)"
                        cont.resume(throwing: NSError(domain: "tokitoki", code: 1, userInfo: [NSLocalizedDescriptionKey: msg]))
                    }
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
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
    private var monitors: [Any] = []
    private var testContextObserver: NSObjectProtocol?
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

        let content = ContentView(model: model)
        popover.contentViewController = NSHostingController(rootView: content)
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
                guard let self, let button = self.statusItem?.button else { return }
                self.showContextMenu(for: button, event: nil)
            }
        }
    }

    func showTestContextMenu() {
        guard let button = statusItem?.button else { return }
        // Leave a deterministic, non-user-facing proof for the e2e harness:
        // AX cannot enumerate an NSMenu while it is owned by WindowServer.
        let labels = ["Open Dashboard", "Refresh Now", "Start at Login", "Quit tokitoki"]
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
        let entries = showPreview ? model.previewEntries : []

        // Fingerprint of everything the strip renders, for memoization.
        let fingerprint = entries.map { "\($0.provider):\($0.remaining)" }.joined(separator: ",")
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
            content = Self.renderStrip(entries: entries, badge: badgeKind)
        }

        Self.lastStrip = (fingerprint, content)
        if let img = content {
            button.image = img
            button.title = ""
        } else {
            button.image = nil
            button.title = fallback
        }
        refreshHoverMonitor()
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

    /// Render [mark] 94% · [mark] 44% … as black-on-clear SwiftUI, then rasterize
    /// via ImageRenderer, trim transparent margins, and wrap in a template NSImage
    /// (openusage MenuBarStripRenderer pattern).
    static func renderStrip(entries: [(provider: String, remaining: Int)], badge: String?) -> NSImage? {
        struct Strip: View {
            let entries: [(provider: String, remaining: Int)]
            let badge: String?
            var body: some View {
                HStack(spacing: 6) {
                    if let badge {
                        Image(systemName: badge == "exceeded" ? "exclamationmark.circle.fill" : "exclamationmark.circle")
                    }
                    ForEach(Array(entries.enumerated()), id: \.offset) { i, e in
                        if i > 0 { Text("·") }
                        HStack(spacing: 2) {
                            MonoMark(provider: e.provider)
                                .frame(width: 10, height: 10)
                            Text("\(e.remaining)%").font(.system(size: 11, weight: .semibold)).monospacedDigit()
                        }
                    }
                }
                .foregroundStyle(Color.black)
            }
        }
        let renderer = ImageRenderer(content: Strip(entries: entries, badge: badge))
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
        if let hoverMonitor { NSEvent.removeMonitor(hoverMonitor); self.hoverMonitor = nil }
        guard model?.previewMode == "hover", statusItem?.button != nil else { return }
        hoverMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseUp, .rightMouseUp]) { [weak self] event in
            guard let self, let button = self.statusItem?.button,
                  let window = button.window else { return }
            let inside = window.frame.contains(NSEvent.mouseLocation)
            DispatchQueue.main.async { self.model?.isHovering = inside }
        }
    }

    @objc private func statusItemAction(_ sender: Any?) {
        FileHandle.standardError.write(Data("[tokitoki-menubar] statusItemAction fired\n".utf8))
        guard let button = statusItem?.button else { return }
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
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            FileHandle.standardError.write(Data("[tokitoki-menubar] popover.show called · shown=\(popover.isShown)\n".utf8))
            popover.contentViewController?.view.window?.makeKey()
            writePopoverProof()
        }
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
            "sections": ["limits", "pie", "providers", "budgets"],

            "accounts": model.limits.map { "\($0.provider)@\($0.accountKey)" },
            "hasPie": hasPie,
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

        let dashboard = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
        dashboard.target = self
        menu.addItem(dashboard)
        let refresh = NSMenuItem(title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)
        menu.addItem(.separator())

        // Settings ▸ per-provider menubar visibility (backs onto `tokitoki ui`).
        let providers = model?.knownProviders ?? []
        if !providers.isEmpty {
            let settings = NSMenuItem(title: "Menubar Providers", action: nil, keyEquivalent: "")
            let sub = NSMenu()
            sub.autoenablesItems = false
            for id in providers {
                let toggle = NSMenuItem(title: id, action: #selector(toggleProviderVisibility(_:)), keyEquivalent: "")
                toggle.representedObject = id
                toggle.state = (model?.menubarHidden.contains(id) ?? false) ? .off : .on
                toggle.target = self
                sub.addItem(toggle)
            }
            settings.submenu = sub
            menu.addItem(settings)
            menu.addItem(.separator())
        }

        let login = NSMenuItem(title: "Start at Login", action: #selector(toggleStartAtLogin), keyEquivalent: "")
        login.state = isStartAtLogin ? .on : .off
        login.target = self
        menu.addItem(login)
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

    @objc private func openDashboard() {
        if let url = URL(string: "http://localhost:7788") { NSWorkspace.shared.open(url) }
    }

    @objc private func refreshNow() { model?.refresh() }

    /// Toggle one provider's menubar visibility via `tokitoki ui`, then
    /// refresh so the change shows up immediately.
    @objc private func toggleProviderVisibility(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let cli = model?.currentInvocation() else { return }
        let hide = sender.state == .on // checked = visible → clicking hides
        let task = Process()
        task.executableURL = cli.executable
        task.arguments = cli.prefixArgs + ["ui", hide ? "--hide" : "--show", id]
        try? task.run()
        task.waitUntilExit()
        model?.refresh()
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
        // Portable JS build first (current packaging strategy): needs bun.
        let cliJs = repoRoot.appendingPathComponent("dist/cli.js")
        if FileManager.default.fileExists(atPath: cliJs.path), let bun = bunURL {
            return CLIInvocation(executable: bun, prefixArgs: [cliJs.path])
        }
        let cliTs = repoRoot.appendingPathComponent("src/cli.ts")
        if FileManager.default.fileExists(atPath: cliTs.path), let bun = bunURL {
            return CLIInvocation(executable: bun, prefixArgs: [cliTs.path])
        }
        if FileManager.default.fileExists(atPath: repoRoot.appendingPathComponent("dist/tokitoki").path) {
            return CLIInvocation(executable: repoRoot.appendingPathComponent("dist/tokitoki"), prefixArgs: [])
        }
    }
    // Repo not found relative to the binary — try the canonical checkout.
    if let bun = bunURL {
        for rel in ["dist/cli.js", "src/cli.ts"] {
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

struct ContentView: View {
    @ObservedObject var model: Model
    let invocation = resolveInvocation()
    @State var dashboardProcess: Process?

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 10) {
                if let e = model.errorText {
                    Label(e, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.red)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                }
                if !model.limits.isEmpty { limitsSection }
                if !(model.today?.rows ?? []).isEmpty { pieCard() }
                heroCard
                if let p = model.today {
                    card(title: "today by provider", icon: "chart.bar.fill") {
                        ForEach(Array(p.rows.sorted { $0.costUsd > $1.costUsd || ($0.costUsd == $1.costUsd && $0.requests > $1.requests) }.prefix(7).enumerated()), id: \.offset) { _, row in
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
                if model.activeOtherMachines > 0 {
                    card(title: "activity", icon: "network") {
                        Label("\(model.activeOtherMachines) other machine\(model.activeOtherMachines == 1 ? "" : "s") active", systemImage: "circle.fill")
                            .foregroundStyle(.green).font(.caption)
                    }
                }
                anomaliesRow
                if !model.repos.isEmpty { compactList(title: "top repos this month", icon: "folder.fill", rows: model.repos.map { ( $0.bucket, "\(humanCount(Double($0.requests))) req") }) }
                if !model.topTools.isEmpty { compactList(title: "top tools today", icon: "wrench.and.screwdriver.fill", rows: model.topTools.map { ($0.tool, $0.costUsd >= 0.01 ? String(format: "$%.2f", $0.costUsd) : humanCount($0.tokens)) }) }
                HStack(spacing: 8) {
                    Button(action: openDashboard) { Label("Dashboard", systemImage: "safari") }.buttonStyle(.borderedProminent)
                    Button(action: { model.refresh() }) { Label("Refresh", systemImage: "arrow.clockwise") }.buttonStyle(.bordered)
                }.frame(maxWidth: .infinity)
                Text("updated automatically every 5 min")
                    .font(.caption2).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(12)
        }
        .scrollIndicators(.hidden)
        .frame(width: 340, height: 520)
        .background(.thinMaterial)
        .onAppear { model.refresh() }
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
                metric("month projection", model.today.map { String(format: "$%.0f", $0.burn.projected) } ?? "—")
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

    @ViewBuilder private var limitsSection: some View {
        // Cards render directly on the popover surface — each account card is
        // its own container; no extra wrapping card.
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(model.limits.enumerated()), id: \.element.id) { idx, l in
                if idx > 0, model.limits[idx - 1].provider == l.provider {
                    Divider()
                }
                AccountLimitCard(limits: l, budgets: matchingBudgets(for: l), tokenScale: tokenMaxima(model.limits))
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityLabel("limit-card-\(l.provider)-\(l.accountKey)")
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

    private static let spendPeriodOrder = ["today", "yesterday", "week", "month"]
    private static let spendPeriodLabels = ["today": "Today", "yesterday": "Yest", "week": "Week", "month": "Month"]

    /// Slices for the selected spend period + metric. Falls back to today's
    /// report when the payload predates the spendPeriods field.
    private func pieSlices(metric: SpendMetric) -> [(name: String, value: Double, color: Color)] {
        let rows: [ReportRow]
        if let period = model.spendPeriods.first(where: { $0.key == spendPeriodKey }) {
            rows = period.rows
        } else if spendPeriodKey == "today", let today = model.today {
            rows = today.rows
        } else {
            rows = []
        }
        var out: [(name: String, value: Double, color: Color)] = []
        for row in rows {
            let value = metric == .cost ? row.costUsd : row.totalTokens
            if value > 0 { out.append((row.bucket, value, bucketColor(row.bucket))) }
        }
        return out.sorted { $0.value > $1.value }
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
                Text(Self.spendPeriodLabels[key] ?? key)
                    .font(.caption2.weight(spendPeriodKey == key ? .semibold : .regular))
                    .monospacedDigit()
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(
                        spendPeriodKey == key
                            ? AnyShapeStyle(.quaternary.opacity(0.9))
                            : AnyShapeStyle(.clear)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { spendPeriodKey = key }
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
                    DonutChart(slices: slices, centerLabel: sliceValue(total, metric: spendMetric))
                        .frame(width: 92, height: 92)
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
        return Text(m.rawValue)
            .font(.caption2.weight(selected ? .semibold : .regular))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(selected ? AnyShapeStyle(.quaternary.opacity(0.9)) : AnyShapeStyle(.clear))
            .contentShape(Rectangle())
            .onTapGesture { spendMetric = m }
    }

    @ViewBuilder private func card<Content: View>(title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title.uppercased(), systemImage: icon).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }.padding(10).background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
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
        if dashboardProcess?.isRunning != true {
            let proc = Process()
            proc.executableURL = invocation.executable
            proc.arguments = invocation.prefixArgs + ["web"]
            do {
                try proc.run()
                dashboardProcess = proc
            } catch {
                NSSound.beep()
                return
            }
        }
        // The CLI binds asynchronously. Waiting briefly avoids opening the
        // browser into a connection-refused/503 page on a cold launch.
        let url = URL(string: "http://localhost:7788")!
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            NSWorkspace.shared.open(url)
        }
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

    /// Provider id → mark, nil = no official vector available (caller falls
    /// back to its own glyph).
    static func forProvider(_ provider: String) -> Path? {
        let d: String?
        switch provider {
        case "codex", "openai": d = openai
        case "claude-code": d = anthropic
        case "cursor": d = cursor
        case "gemini-cli": d = googlegemini
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
        case "grok": return "xmark"
        case "openrouter": return "arrow.triangle.branch"
        case "pi", "opencode-go", "opencode": return "diamond.fill"
        case "t3code", "antigravity-cli": return "triangle.fill"
        default: return "circle.fill"
        }
    }

    static func brandColor(_ p: String) -> Color {
        switch p {
        case "claude-code": return Color(red: 0.851, green: 0.467, blue: 0.341) // #D97757 Anthropic clay
        case "codex": return Color(red: 0.063, green: 0.639, blue: 0.498)       // #10A37F OpenAI
        case "cursor": return Color(red: 0.400, green: 0.400, blue: 0.440)
        case "gemini-cli": return Color(red: 0.259, green: 0.522, blue: 0.957)  // #4285F4
        case "grok": return .primary
        case "openrouter": return Color(red: 0.545, green: 0.361, blue: 0.965)  // #8B5CF6
        case "pi", "opencode-go", "opencode": return Color(red: 0.655, green: 0.545, blue: 0.980) // #A78BFA violet
        default: return .accentColor
        }
    }
}

/// Bucket color for charts: brand color when known, stable hash palette otherwise.
func bucketColor(_ name: String) -> Color {
    if ProviderLogo.symbol(name) != "circle.fill" { return ProviderLogo.brandColor(name) }
    let colors: [Color] = [.blue, .purple, .orange, .mint, .pink, .teal]
    return colors[abs(name.hashValue) % colors.count]
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
    /// Budget rows whose pattern matches this account — rendered as a slim footer.
    var budgets: [BudgetRow] = []
    /// Per-kind max token totals across ALL accounts — used to normalize
    /// progress bars for windows without a real quota denominator so every
    /// card renders bars consistently (fill = tokens / kind-max, clamped).
    var tokenScale: [String: Double] = [:]
    /// openusage-style collapsible "details" disclosure.
    @State private var showDetails = false

    private var orderedWindows: [LimitWindow] {
        let order = ["day": 0, "week": 1, "month": 2]
        return lwindows.sorted { (order[$0.kind] ?? 9) < (order[$1.kind] ?? 9) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            headerRow
            ForEach(Array(orderedWindows.enumerated()), id: \.offset) { _, w in
                windowBarRow(w)
            }
            if orderedWindows.isEmpty {
                Text("no usage recorded").font(.caption2).foregroundStyle(.tertiary)
            }
            bankedRow
            if !budgets.isEmpty { budgetFooter }
            if let cred = limits.credential, !cred.isEmpty {
                Text(cred)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .help("key-based account (redacted)")
            }
            detailsDisclosure
        }
        .padding(.vertical, 2)
    }

    /// Collapsible per-window detail rows: source, window length, exact reset.
    @ViewBuilder private var detailsDisclosure: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { showDetails.toggle() } } label: {
                HStack(spacing: 3) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .rotationEffect(.degrees(showDetails ? 90 : 0))
                    Text("details")
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
                    ForEach(Array(orderedWindows.enumerated()), id: \.offset) { _, w in
                        HStack(spacing: 6) {
                            Text(windowDisplayName(w.kind))
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(w.source)
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 4).padding(.vertical, 0.5)
                                .background(.quaternary.opacity(0.6), in: Capsule())
                            Spacer()
                            if let mins = windowMinutes(w) {
                                Text("\(mins)min")
                                    .font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                            }
                            if let r = w.resetsAt, let target = parseISO(r) {
                                Text("resets " + target.formatted(date: .abbreviated, time: .shortened))
                                    .font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .padding(.top, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    /// Window length in minutes derived from start/end ISO stamps.
    private func windowMinutes(_ w: LimitWindow) -> Int? {
        guard let s = w.windowStart.flatMap(parseISO),
              let e = w.windowEnd.flatMap(parseISO) else { return nil }
        let mins = Int(e.timeIntervalSince(s) / 60)
        return mins > 0 ? mins : nil
    }

    /// openusage-style labeled bar per window: name · bar · % left / resets-in.
    private func windowBarRow(_ w: LimitWindow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(windowDisplayName(w.kind))
                    .font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                if let pct = w.usedPct {
                    let remaining = max(0, min(100, 100 - pct))
                    Text("\(Int(remaining.rounded()))% left")
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(barTint(remaining))
                } else {
                    Text("\(humanCount(w.tokens)) tokens")
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            if let pct = w.usedPct {
                let remaining = max(0, min(100, 100 - pct))
                ProgressView(value: remaining / 100)
                    .tint(barTint(remaining))
                    .frame(height: 6)
            } else if w.tokens > 0, let scale = tokenScale[w.kind], scale > 0 {
                // No real quota denominator (derived/estimate window): render a
                // RELATIVE bar normalized against the largest same-kind window
                // across accounts — visual comparison only, never a fake %.
                let frac = min(1.0, max(0.05, w.tokens / scale))
                ProgressView(value: frac)
                    .tint(Color.secondary.opacity(0.45))
                    .frame(height: 6)
            }
            HStack {
                Spacer()
                if let r = w.resetsAt {
                    Text("Resets in " + countdown(r))
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
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
            ProviderLogo(provider: limits.provider)
            Text(accountLabel)
                .font(.caption.weight(.medium)).lineLimit(1)
            Spacer()
            if let url = providerConsoleURL(limits.provider) {
                Button { NSWorkspace.shared.open(url) } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Open \(limits.provider) usage dashboard")
            }
            planBadge
        }
    }

    private var accountLabel: String {
        if let email = limits.email, !email.isEmpty {
            return "\(email) · \(limits.accountKey)"
        }
        return "\(limits.provider) · \(limits.accountKey)"
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
                    Text("(exp " + shortDate(exp) + ")")
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

private func windowDisplayName(_ kind: String) -> String {
    switch kind {
    case "day": return "Session"
    case "week": return "Weekly"
    case "month": return "Monthly"
    default: return kind.capitalized
    }
}


private func shortDate(_ iso: String) -> String {
    String(iso.prefix(10))
}

/// Humanized time-until-reset ("4h 12m", "3d", "42m").
func countdown(_ iso: String?) -> String {
    guard let iso, let target = parseISO(iso) else { return "—" }
    let secs = Int(target.timeIntervalSinceNow)
    if secs <= 0 { return "now" }
    let d = secs / 86_400
    let h = (secs % 86_400) / 3_600
    let m = (secs % 3_600) / 60
    if d >= 1 { return "\(d)d \(h)h" }
    if h >= 1 { return "\(h)h \(m)m" }
    return "\(m)m"
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

/// openusage-style donut: center hole carries the period total, slices get a
/// small angular gap so segments read separately; zero-value input renders an
/// empty ring rather than a fake slice.
struct DonutChart: View {
    let slices: [(name: String, value: Double, color: Color)]
    var centerLabel: String? = nil

    /// Angular gap between adjacent slices (degrees). Only applied when there
    /// is more than one slice — a single full-circle slice stays seamless.
    private static let gapDegrees = 2.5

    var body: some View {
        Canvas { context, size in
            let total = slices.reduce(0) { $0 + $1.value }
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) / 2 - 2
            let hole = radius * 0.55
            guard total > 0 else {
                if let centerLabel {
                    context.draw(Text(centerLabel).font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary), at: center)
                }
                return
            }
            let gap = slices.count > 1 ? Angle.degrees(Self.gapDegrees) : .zero
            let start = Angle.degrees(-90)
            var cursor = start
            for slice in slices {
                let sweep = Angle.degrees(slice.value / total * 360)
                // Shrink each slice by half the gap on both ends so outer
                // edges line up but visible spacing separates the slices.
                let a0 = cursor + gap / 2
                let a1 = cursor + sweep - gap / 2
                if a1 > a0 {
                    let path = Path { p in
                        p.addArc(center: center, radius: radius,
                                 startAngle: a0, endAngle: a1, clockwise: false)
                        p.addArc(center: center, radius: hole,
                                 startAngle: a1, endAngle: a0, clockwise: true)
                        p.closeSubpath()
                    }
                    context.fill(path, with: .color(slice.color))
                }
                cursor += sweep
            }
            if let centerLabel {
                context.draw(Text(centerLabel).font(.system(size: 9, weight: .semibold)).foregroundColor(.primary), at: center)
            }
        }
        .accessibilityHidden(false)
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
                    ProviderLogo(provider: slice.name)
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




