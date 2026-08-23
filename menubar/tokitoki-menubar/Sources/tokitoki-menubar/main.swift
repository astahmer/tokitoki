import SwiftUI
import AppKit
import UserNotifications

// tokitoki menu-bar extra: native SwiftUI MenuBarExtra that shells out to the
// compiled `dist/tokitoki` CLI. No Electron, no webview.

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

@MainActor
final class Model: ObservableObject {
    @Published var title: String = "…"
    @Published var today: ReportPayload?
    @Published var week: ReportPayload?
    @Published var repos: [ReportRow] = []
    @Published var errorText: String?

    private var timer: Timer?

    func start(binURL: URL) {
        refresh(binURL: binURL)
        timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh(binURL: binURL) }
        }
    }

    func refresh(binURL: URL) {
        Task { @MainActor in
            async let t = Self.runReport(binURL, ["report", "--last", "day", "--by", "provider", "--json"])
            async let w = Self.runReport(binURL, ["report", "--last", "week", "--by", "provider", "--json"])
            async let r = Self.runReport(binURL, ["report", "--last", "month", "--by", "repo", "--json"])
            do {
                let (t0, w0, r0) = try await (t, w, r)
                self.today = t0
                self.week = w0
                self.repos = Array((r0?.rows ?? []).sorted { $0.requests > $1.requests }.prefix(3))
                if let t0 { self.title = Self.title(for: t0) } else { self.title = "tokitoki" }
                self.errorText = nil
            } catch {
                self.errorText = "\(error.localizedDescription)"
                self.title = "tokitoki ⚠️"
            }
        }
    }

    static func title(for p: ReportPayload) -> String {
        if p.total.costUsd > 0 { return String(format: "$%.2f", p.total.costUsd) }
        return humanCount(Double(p.total.requests)) + " req"
    }

    static func runReport(_ binURL: URL, _ args: [String]) async throws -> ReportPayload? {
        let out = try await runCLI(binURL, args)
        guard !out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let data = out.data(using: .utf8) else { return nil }
        return try JSONDecoder().decode(ReportPayload.self, from: data)
    }

    static func runCLI(_ binURL: URL, _ args: [String]) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                let proc = Process()
                proc.executableURL = binURL
                proc.arguments = args
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

@main
struct TokitokiApp: App {
    @StateObject private var model = Model()

    var body: some Scene {
        MenuBarExtra {
            ContentView(model: model)
        } label: {
            Text(model.title)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Locate dist/tokitoki by walking up from this binary (repo layout),
/// $TOKITOKI_BIN override wins.
func resolveBin() -> URL {
    if let override = ProcessInfo.processInfo.environment["TOKITOKI_BIN"], !override.isEmpty {
        return URL(fileURLWithPath: override)
    }
    var url = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    for _ in 0..<6 {
        url.deleteLastPathComponent()
        let candidate = url.appendingPathComponent("dist/tokitoki")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    return URL(fileURLWithPath: "~/dev/tokitoki/dist/tokitoki", resolvingTildeInPath: true)
}

struct ContentView: View {
    @ObservedObject var model: Model
    let binURL = resolveBin()
    @State var dashboardProcess: Process?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let e = model.errorText {
                Text("error: \(e)").font(.caption).foregroundStyle(.red)
            }
            section(title: "today", payload: model.today)
            Divider()
            section(title: "this week", payload: model.week)
            Divider()
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
            HStack {
                Button("Open dashboard") { openDashboard() }
                    .keyboardShortcut("o")
                Spacer()
                Button("Refresh") { model.refresh(binURL: binURL) }
                    .keyboardShortcut("r")
            }
            Text("every 5 min · \(binURL.path)")
                .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
        .padding(10)
        .frame(width: 320)
        .onAppear { model.start(binURL: binURL) }
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

    private func openDashboard() {
        if dashboardProcess?.isRunning != true {
            let proc = Process()
            proc.executableURL = binURL
            proc.arguments = ["web"]
            try? proc.run()
            dashboardProcess = proc
        }
        if let url = URL(string: "http://localhost:7788") {
            NSWorkspace.shared.open(url)
        }
    }
}
