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
            Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
                if FileManager.default.fileExists(atPath: closeFile.path) {
                    try? FileManager.default.removeItem(at: closeFile)
                    Task { @MainActor in
                        AppDelegate.shared?.closePopover()
                        FileHandle.standardError.write(Data("[tokitoki-menubar] test-close fired\n".utf8))
                    }
                }
            }
        }
    }

    func refresh() {
        Task { @MainActor in
            do {
                let p = try await Self.runJSON(MenubarPayload.self, invocation, ["menubar-payload", "--json"])!
                dbg("fetched · budgets=\(p.budgets.count) anomalies=\(p.anomalies?.anomalies.count ?? -1)")
                self.today = p.today
                self.week = p.week
                if let rm = p.reposMonth {
                    self.repos = Array(rm.rows.sorted { $0.requests > $1.requests }.prefix(3))
                }
                self.topTools = Array((p.topTools?.tools ?? []).prefix(3))
                let local = ProcessInfo.processInfo.hostName
                self.activeOtherMachines = (p.presence ?? []).filter { $0.state == "active" && $0.machineId != local }.count
                applyBudgets(p.budgets)
                var newTitle = Self.title(for: p.today)
                newTitle = Self.badged(newTitle, worst: worstState)
                setTitleIfChanged(newTitle)
                self.errorText = nil
                applyAnomalies(p.anomalies)
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

    static func title(for p: ReportPayload) -> String {
        if p.total.costUsd > 0 { return String(format: "$%.2f", p.total.costUsd) }
        return humanCount(Double(p.total.requests)) + " req"
    }

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

final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?

    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var monitors: [Any] = []
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
        item.button?.action = #selector(togglePopover(_:))
        statusItem = item
        FileHandle.standardError.write(Data(
            "[tokitoki-menubar] statusItem created · button=\(item.button != nil ? "ok" : "NIL") title=[\(model.title)]\n".utf8))

        let content = ContentView(model: model)
        popover.contentViewController = NSHostingController(rootView: content)
        // .transient: AppKit's own outside-click dismissal — works for real
        // user clicks without any TCC permissions. Synthetic HID events don't
        // route here (they never activate the accessory app), so tests use
        // the dev.tokitoki.menubar.close distributed notification instead.
        popover.behavior = .transient
        popover.animates = false

        installEventMonitors()
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
    }

    @objc func togglePopover(_ sender: Any?) {
        guard let button = statusItem?.button else { return }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            // Accessory apps must activate before showing or the popover
            // never becomes key — synthetic AND real outside clicks/escapes
            // then fail to close it.
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}

/// How to invoke the CLI: compiled dist binary preferred, `bun src/cli.ts`
/// fallback when dist hasn't been built yet.
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
        if FileManager.default.fileExists(atPath: repoRoot.appendingPathComponent("dist/tokitoki").path) {
            return CLIInvocation(executable: repoRoot.appendingPathComponent("dist/tokitoki"), prefixArgs: [])
        }
        let cliTs = repoRoot.appendingPathComponent("src/cli.ts")
        if FileManager.default.fileExists(atPath: cliTs.path) {
            let bunCandidates = ["~/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
            for candidate in bunCandidates where FileManager.default.fileExists(atPath: cliURL(candidate).path) {
                return CLIInvocation(executable: cliURL(candidate), prefixArgs: [cliTs.path])
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
        // Fixed frame + ScrollView: an unconstrained-height NSHostingView lets
        // the popover balloon toward full screen height as rows appear
        // (observed 346x988); this pins the dropdown geometry.
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 6) {
            if let e = model.errorText {
                Text("error: \(e)").font(.caption).foregroundStyle(.red)
            }
            section(title: "today", payload: model.today)
            Divider()
            section(title: "this week", payload: model.week)
            Divider()
            budgetsSection
            if model.activeOtherMachines > 0 {
                Text("other machines active: \(model.activeOtherMachines)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            anomaliesRow
            if !model.repos.isEmpty {
                Text("top repos (month)").font(.caption).bold()
                ForEach(model.repos, id: \.bucket) { r in
                    HStack {
                        Text(r.bucket).lineLimit(1)
                        Spacer()
                        Text("\(humanCount(Double(r.requests))) req").foregroundStyle(.secondary)
                    }.font(.caption)
                }
                Divider()
            }
            if !model.topTools.isEmpty {
                Text("top tools (today)").font(.caption).bold()
                ForEach(model.topTools, id: \.tool) { t in
                    HStack {
                        Text(t.tool).lineLimit(1)
                        Spacer()
                        Text(t.costUsd >= 0.01 ? String(format: "$%.2f", t.costUsd) : humanCount(t.tokens))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }.font(.caption)
                }
                Divider()
            }
            HStack {
                Button("Open dashboard") { openDashboard() }
                    .keyboardShortcut("o")
                Spacer()
                Button("Refresh") { model.refresh() }
                    .keyboardShortcut("r")
            }
            Text("every 5 min · \(invocation.executable.path)")
                .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(10)
        .frame(width: 320, height: 480)
        .onAppear { model.refresh() } // refresh-on-menu-open (polling runs regardless)
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
            try? proc.run()
            dashboardProcess = proc
        }
        if let url = URL(string: "http://localhost:7788") {
            NSWorkspace.shared.open(url)
        }
    }
}
