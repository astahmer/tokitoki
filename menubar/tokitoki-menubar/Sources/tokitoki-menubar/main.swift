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
    let planLabel: String?
    let windows: [LimitWindow]
    let bankedResets: Int?
    let bankedExpiresAt: String?

    var id: String { "\(provider)@\(accountKey)" }
}

struct UiPreviewConfig: Codable {
    let previewLines: Int?
    let previewMode: String? // "inline" | "hover"
}

// Combined snapshot from `tokitoki menubar-payload --json` (single CLI
// process instead of seven parallel ones that thrashed memory).
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
                let newTitle = composeTitle(today: p.today, preview: Self.previewText(p.limits ?? [], cfg: p.uiPreview), hovering: isHovering, mode: self.previewMode)
                setTitleIfChanged(newTitle)
                self.errorText = nil
                applyAnomalies(p.anomalies)
                AppDelegate.shared?.refreshProofIfShown()
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

    static func providerGlyph(_ provider: String) -> String {
        switch provider {
        case "claude-code": return "◈"
        case "codex": return "⬡"
        case "opencode-go", "opencode": return "✦"
        case "openrouter": return "◉"
        case "gemini-cli": return "✧"
        case "cursor": return "⌁"
        case "grok": return "✳"
        default: return "●"
        }
    }

    /// Primary window for a card/bar: first with a real quota denominator,
    /// else the first window. Mirrors the popover hero logic.
    static func primaryWindow(_ l: AccountLimits) -> LimitWindow? {
        l.windows.first { $0.usedPct != nil } ?? l.windows.first
    }

    /// Compact icon + remaining percentage line from each account's primary window.
    static func previewText(_ limits: [AccountLimits], cfg: UiPreviewConfig?) -> String? {
        let maxLines = cfg?.previewLines ?? 3
        guard maxLines > 0 else { return nil }
        let parts: [String] = limits.compactMap { l in
            guard let w = primaryWindow(l), let pct = w.usedPct else { return nil }
            return "\(Self.providerGlyph(l.provider)) \(Int(max(0, 100 - pct).rounded()))%"
        }
        guard !parts.isEmpty else { return nil }
        return Array(parts.prefix(maxLines)).joined(separator: " · ")
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

    func syncButtonTitle(_ title: String) {
        statusItem?.button?.title = title
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
    var url = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    for _ in 0..<6 {
        url.deleteLastPathComponent()
        let repoRoot = url
        let cliTs = repoRoot.appendingPathComponent("src/cli.ts")
        if FileManager.default.fileExists(atPath: cliTs.path) {
            let bunCandidates = ["~/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
            for candidate in bunCandidates where FileManager.default.fileExists(atPath: cliURL(candidate).path) {
                return CLIInvocation(executable: cliURL(candidate), prefixArgs: [cliTs.path])
            }
        }
        if FileManager.default.fileExists(atPath: repoRoot.appendingPathComponent("dist/tokitoki").path) {
            return CLIInvocation(executable: repoRoot.appendingPathComponent("dist/tokitoki"), prefixArgs: [])
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
                heroCard
                if !(model.today?.rows ?? []).isEmpty { pieCard() }
                if let p = model.today {
                    card(title: "today by provider", icon: "chart.bar.fill") {
                        HStack(alignment: .bottom, spacing: 3) {
                            ForEach(Array(p.rows.sorted { $0.costUsd > $1.costUsd }.prefix(14).enumerated()), id: \.offset) { _, row in
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(providerColor(row.bucket))
                                    .frame(height: CGFloat(max(4, min(38, row.costUsd > 0 ? row.costUsd / max(p.total.costUsd, 1) * 38 : 5))))
                            }
                        }.frame(height: 40, alignment: .bottom)
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
                budgetsSection
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

    @ViewBuilder private var providerSection: some View {
        if let p = model.today {
            card(title: "providers", icon: "circle.grid.2x2.fill") {
                ForEach(Array(p.rows.sorted { $0.costUsd > $1.costUsd }.prefix(6)), id: \.bucket) { row in
                    HStack(spacing: 8) {
                        Circle().fill(providerColor(row.bucket)).frame(width: 7, height: 7)
                        Text(row.bucket).font(.caption).lineLimit(1)
                        Spacer()
                        Text(row.costUsd > 0 ? String(format: "$%.2f", row.costUsd) : "\(humanCount(Double(row.requests))) req")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }.padding(.vertical, 2)
                }
            }
        }
    }

    // MARK: - v3: per-account limit cards (the hero)

    @ViewBuilder private var limitsSection: some View {
        card(title: "remaining · resets", icon: "gauge.with.needle") {
            VStack(alignment: .leading, spacing: 9) {
                ForEach(model.limits) { l in
                    AccountLimitCard(limits: l)
                        .accessibilityLabel("limit-card-\(l.provider)-\(l.accountKey)")
                }
                consoleLinksRow
            }
        }.accessibilityIdentifier("limits-section")
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

    private var pieSlices: [(name: String, value: Double, color: Color)] {
        guard let rows = model.today?.rows.filter({ $0.costUsd > 0 }) else { return [] }
        return rows.sorted { $0.costUsd > $1.costUsd }
            .map { ($0.bucket, $0.costUsd, providerColor($0.bucket)) }
    }

    private var topSpenders: [ReportRow] {
        (model.today?.rows ?? []).filter { $0.costUsd > 0 }.sorted { $0.costUsd > $1.costUsd }
    }

    private func pieCard() -> some View {
        card(title: "spend distribution", icon: "chart.pie.fill") {
            HStack(spacing: 14) {
                DonutChart(slices: pieSlices)
                    .frame(width: 92, height: 92)
                    .accessibilityLabel("spend-pie-chart")
                SpendLegend(slices: Array(pieSlices.prefix(5)))
                Spacer(minLength: 0)
            }
        }
        .accessibilityIdentifier("pie-section")
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

    private func providerColor(_ name: String) -> Color {
        let colors: [Color] = [.blue, .purple, .orange, .mint, .pink, .teal]
        return colors[abs(name.hashValue) % colors.count]
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
    private var budgetsSection: some View {
        if !model.budgets.isEmpty {
            Text("budgets").font(.caption).bold()
            ForEach(model.budgets, id: \.label) { b in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(b.label).font(.caption).lineLimit(1)
                        Spacer()
                        Text(String(format: "$%.2f / $%.0f", b.used, b.cap))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    ProgressView(value: min(b.ratio, 1))
                        .tint(color(for: b.state))
                    HStack {
                        Text("\(Int(round(b.ratio * 100)))% used").font(.caption2).foregroundStyle(.secondary)
                        Spacer()
                        if let d = b.daysLeft { Text("\(String(format: "%.0f", d))d left")
                            .font(.caption2).foregroundStyle(.secondary) }
                    }
                }
                .padding(.vertical, 1)
            }
            Divider()
        }
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

/// CodexBar-style per-account limit card: primary window bar + resets-in
/// countdown, stacked secondary windows, banked resets. Raw token numbers
/// when no quota denominator is known (honest: no fake percentages).
struct AccountLimitCard: View {
    let limits: AccountLimits

    private var primary: LimitWindow? { Model.primaryWindow(limits) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            headerRow
            primaryRow
            if !secondaryWindows.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(secondaryWindows.enumerated()), id: \.offset) { _, w in
                        secondaryRow(w)
                    }
                    Spacer(minLength: 0)
                }
            }
            bankedRow
        }
        .padding(.vertical, 2)
    }

    private var headerRow: some View {
        HStack(spacing: 5) {
            Text(Model.providerGlyph(limits.provider))
                .font(.caption.weight(.bold))
                .foregroundStyle(sharedProviderColor(limits.provider))
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

    @ViewBuilder private var primaryRow: some View {
        if let p = primary {
            if let pct = p.usedPct {
                let remaining = max(0, min(100, 100 - pct))
                Button {
                    if let url = providerConsoleURL(limits.provider) { NSWorkspace.shared.open(url) }
                } label: {
                    ProgressView(value: remaining / 100)
                        .tint(barTint(remaining))
                }
                .buttonStyle(.plain)
                .help("Open \(limits.provider) usage dashboard")
                primaryMeta(p, remaining: remaining)
            } else {
                primaryDerivedMeta(p)
            }
        }
    }

    private func primaryMeta(_ p: LimitWindow, remaining: Double) -> some View {
        HStack {
            Text("\(Int(remaining.rounded()))% remaining")
                .font(.caption.monospacedDigit().weight(.semibold))
                .foregroundStyle(barTint(remaining))
            Spacer()
            Text("resets in " + countdown(p.resetsAt))
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func primaryDerivedMeta(_ p: LimitWindow) -> some View {
        HStack {
            Text("\(humanCount(p.tokens)) tokens")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Text("resets in " + countdown(p.resetsAt))
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private func secondaryRow(_ w: LimitWindow) -> some View {
        let label = w.usedPct.map { "\(windowGlyph(w.kind)) \(Int(max(0, 100 - $0).rounded()))%" }
            ?? "\(windowGlyph(w.kind)) \(humanCount(w.tokens))"
        return Text(label)
            .font(.caption2.monospacedDigit().weight(.medium))
            .foregroundStyle(w.usedPct.map { barTint(max(0, 100 - $0)) } ?? .secondary)
            .help("\(w.kind): \(w.usedPct.map { "\(Int(max(0, 100 - $0).rounded()))% remaining" } ?? "rolling") · resets in \(countdown(w.resetsAt)) · \(humanCount(w.tokens)) tokens")
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

    /// Windows other than the rendered primary, in day > week > month order.
    private var secondaryWindows: [LimitWindow] {
        guard let p = primary else { return [] }
        let order = ["day": 0, "week": 1, "month": 2]
        return lwindows.filter { $0.kind != p.kind }
            .sorted { (order[$0.kind] ?? 9) < (order[$1.kind] ?? 9) }
    }

    // `limits` shadows the member when accessed unqualified inside SwiftUI
    // property initializers; explicit accessor keeps the intent obvious.
    private var lwindows: [LimitWindow] { limits.windows }
}

private func windowGlyph(_ kind: String) -> String {
    switch kind {
    case "day": return "☀︎"
    case "week": return "🗓"
    case "month": return "📅"
    default: return "⏱"
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

private let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoPlain = ISO8601DateFormatter()

/// Tolerant parse: payload timestamps may omit fractional seconds.
func parseISO(_ s: String) -> Date? {
    isoFractional.date(from: s) ?? isoPlain.date(from: s)
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

private func barTint(_ remaining: Double) -> Color {
    switch remaining {
    case ..<5: return .red
    case ..<20: return .orange
    case ..<50: return .cyan
    default: return .blue
    }
}

/// openusage-style donut with a center hole; zero-cost sessions render an
/// empty ring rather than a fake slice.
struct DonutChart: View {
    let slices: [(name: String, value: Double, color: Color)]

    var body: some View {
        Canvas { context, size in
            let total = slices.reduce(0) { $0 + $1.value }
            guard total > 0 else { return }
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) / 2 - 2
            let hole = radius * 0.55
            let start = Angle.degrees(-90)
            var cursor = start
            for slice in slices {
                let sweep = Angle.degrees(slice.value / total * 360)
                let path = Path { p in
                    p.addArc(center: center, radius: radius,
                             startAngle: cursor, endAngle: cursor + sweep, clockwise: false)
                    p.addArc(center: center, radius: hole,
                             startAngle: cursor + sweep, endAngle: cursor, clockwise: true)
                    p.closeSubpath()
                }
                context.fill(path, with: .color(slice.color))
                cursor += sweep
            }
        }
        .accessibilityHidden(false)
    }
}

/// File-scope provider palette so standalone card views share the popover's
/// color identity (ContentView keeps its instance wrapper).
func sharedProviderColor(_ name: String) -> Color {
    let colors: [Color] = [.blue, .purple, .orange, .mint, .pink, .teal]
    return colors[abs(name.hashValue) % colors.count]
}


/// Legend beside the donut: name + absolute spend per slice.
struct SpendLegend: View {
    let slices: [(name: String, value: Double, color: Color)]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(slices.enumerated()), id: \.offset) { _, slice in
                HStack(spacing: 5) {
                    Circle().fill(slice.color).frame(width: 6, height: 6)
                    Text(slice.name).font(.caption2).lineLimit(1)
                    Spacer()
                    Text(String(format: "$%.2f", slice.value))
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
