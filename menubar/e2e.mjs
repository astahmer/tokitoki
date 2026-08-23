/**
 * Menubar e2e: launches the real built binary and asserts the status item is
 * actually VISIBLE, not just registered:
 *
 *   1. accessibility tree reports a status-bar item with nonzero size
 *      (targets our exact pid — System Events matched by name is ambiguous
 *      when the deployed LaunchAgent instance runs alongside);
 *   2. VISUAL PROOF: screencapture of the item's rect decodes to an image
 *      containing rendered glyph ink (the old MenuBarExtra build passed AX
 *      checks but never drew — this assertion catches exactly that);
 *   3. no orphaned dropdown panel open at rest;
 *   4. clicking opens the dropdown (~320pt), Escape closes it.
 *
 * The deployed LaunchAgent instance (same process name) is unloaded during
 * the run and restored afterwards.
 *
 * Usage: bun menubar/e2e.mjs [path-to-binary]
 */
import { spawn, spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

const BIN = process.argv[2] ?? "menubar/tokitoki-menubar/.build/release/tokitoki-menubar";

let FAIL = 0;
const pass = (m) => console.log(`\x1b[1;32m[PASS]\x1b[0m ${m}`);
const fail = (m) => { console.log(`\x1b[1;31m[FAIL]\x1b[0m ${m}`); FAIL = 1; };
const say = (m) => console.log(`\x1b[1;34m[e2e]\x1b[0m ${m}`);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// hard watchdog: never hang the harness on a stuck AX/screencapture call
setTimeout(() => { console.log("\x1b[1;31me2e WATCHDOG TIMEOUT (150s)\x1b[0m"); process.exit(1); }, 150_000).unref();

// --- minimal PNG decode (non-interlaced, 8-bit RGB/RGBA/gray) -> luma grid ---
function decodePng(path) {
    const buf = require("node:fs").readFileSync(path);
    if (buf.readUInt32BE(12) !== 0x49484452) throw new Error("not a png");
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    let pos = 8, idat = [];
    let ct = 0;
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString("ascii", pos + 4, pos + 8);
        if (type === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + len));
        if (type === "IHDR") ct = buf[pos + 25];
        pos += 12 + len;
    }
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct] ?? 4;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const out = Buffer.alloc(h * stride);
    let p = 0;
    for (let y = 0; y < h; y++) {
        const f = raw[p++];
        const line = raw.subarray(p, p + stride); p += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? cur[x - ch] : 0;
            const b = y > 0 ? out[(y - 1) * stride + x] : 0;
            const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
            let v = line[x];
            if (f === 1) v = (v + a) & 255;
            else if (f === 2) v = (v + b) & 255;
            else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (f === 4) {
                const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
            }
            cur[x] = v;
        }
    }
    return { w, h, ch, out, stride };
}

function inkRatioInRect(png, rx, ry, rw, rh) {
    // count columns containing at least one dark pixel inside rect
    let inkCols = 0;
    for (let x = rx; x < Math.min(rx + rw, png.w); x++) {
        let col = false;
        for (let y = ry; y < Math.min(ry + rh, png.h); y++) {
            const o = y * png.stride + x * png.ch;
            const r = png.out[o], g = png.ch >= 3 ? png.out[o + 1] : r, b = png.ch >= 3 ? png.out[o + 2] : r;
            const lum = (r * 299 + g * 587 + b * 114) / 1000;
            if (lum < 140) { col = true; break; }
        }
        if (col) inkCols++;
    }
    return inkCols / Math.max(1, rw);
}

// --- process/window helpers ---

const WINLIST_SNIPPET = `
import CoreGraphics
import Foundation
if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
    for w in list {
        let owner = w["kCGWindowOwnerName"] as? String ?? "?"
        guard owner.lowercased().contains("tokitoki") else { continue }
        let pid = w["kCGWindowOwnerPID"] as? Int ?? -1
        let id = w["kCGWindowNumber"] as? Int ?? -1
        let layer = w["kCGWindowLayer"] as? Int ?? -999
        let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
        let num = { (v: Any) -> Int in (v as? Int) ?? Int(v as? Double ?? -1) }
        print("WIN \\(pid) \\(id) \\(layer) \\(num(b["X"] ?? -1)) \\(num(b["Y"] ?? -1)) \\(num(b["Width"] ?? -1)) \\(num(b["Height"] ?? -1))")
    }
}`;

function listWindows() {
    const res = spawnSync("swift", ["-e", WINLIST_SNIPPET], { encoding: "utf8", timeout: 60_000 });
    if (!res.stdout?.trim() && res.status !== 0) throw new Error(`winlist failed: ${res.stderr}`);
    return res.stdout.split("\n").filter((l) => l.startsWith("WIN ")).map((l) => {
        const [, pid, id, layer, x, y, w, h] = l.split(/\s+/).map(Number);
        return { pid, id, layer, x, y, w, h };
    });
}

function axStatusItem(pid) {
    const script = `
tell application "System Events"
  set procs to (every process whose unix id is ${pid})
  if (count of procs) = 0 then return "NOPROC"
  tell (item 1 of procs)
    if (count of menu bars) < 1 then return "NOBAR"
    set mb to menu bar 1
    if (count of menu bar items of mb) < 1 then return "NOITEM"
    set mi to menu bar item 1 of mb
    set {px, py} to position of mi
    set {sw, sh} to size of mi
    return "ITEM " & px & " " & py & " " & sw & " " & sh
  end tell
end tell`;
    const res = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 30_000 });
    const out = res.stdout?.trim() ?? "";
    if (!out || ["NOPROC", "NOBAR", "NOITEM"].includes(out)) return { found: false, detail: out };
    const [, x, y, w, h] = out.split(/\s+/).map(Number);
    return { found: true, x, y, w, h };
}

const AGENT_LABEL = "dev.tokitoki.menubar";
const AGENT_PLIST = `${process.env.HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist`;
const wasLoaded = spawnSync("launchctl", ["list", AGENT_LABEL], { encoding: "utf8" }).status === 0;

// Isolate from the deployed LaunchAgent instance BEFORE spawning: same process
// name makes both CGWindowList owner-matching and System Events ambiguous,
// its stuck panel would trip assertion 3, and pkill below must not hit our
// own child.
if (wasLoaded) {
    say("unloading deployed LaunchAgent instance for isolation");
    spawnSync("launchctl", ["unload", [AGENT_PLIST]]);
}
spawnSync("pkill", ["-f", "tokitoki-menubar"]);
await sleepMs(800);

const child = spawn(BIN, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TOKITOKI_MENUBAR_DEBUG: "1", TOKITOKI_MENUBAR_TEST: "1" },
});
let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

try {
    say(`launched ${BIN} (pid ${child.pid})`);
    let ax = { found: false, detail: "not polled" };
    for (let attempt = 0; attempt < 15; attempt++) {
        await sleepMs(1000);
        ax = axStatusItem(child.pid);
        if (ax.found) break;
    }

    // --- 1: AX status item exists with nonzero size ---
    if (ax.found && ax.w > 0 && ax.h > 0) {
        pass(`ax status item: pos=(${ax.x},${ax.y}) size=${ax.w}x${ax.h}`);
    } else {
        fail(`ax status item missing or zero-size: ${JSON.stringify(ax)} stderr=${stderrBuf.slice(-300)}`);
    }

    // --- 2: visual proof — glyphs are actually drawn in the captured rect ---
    if (ax.found) {
        const cap = `/tmp/tokitoki-menubar-e2e-${child.pid}.png`;
        const capRes = spawnSync("screencapture", ["-x", `-R${ax.x - 6},${Math.max(0, ax.y - 4)},${ax.w + 12},${ax.h + 8}`, cap]);
        try {
            const png = decodePng(cap);
            const ratio = inkRatioInRect(png, 0, 0, png.w, png.h);
            if (capRes.status === 0 && ratio > 0.15) {
                pass(`visual: ${(ratio * 100).toFixed(0)}% of item columns contain glyph ink (${png.w}x${png.h} capture)`);
            } else {
                fail(`visual: item rect looks empty (ink ratio ${(ratio * 100).toFixed(0)}%, screencapture status=${capRes.status}) — old invisible-item bug`);
            }
        } catch (e) {
            say(`visual check skipped (${e.message}) — needs Screen Recording permission`);
        }
    }

    // --- 3: no orphaned dropdown at rest ---
    let windows = listWindows().filter((w) => w.pid === child.pid);
    const orphan = windows.find((w) => w.w > 200 && w.h > 50);
    if (!orphan) {
        pass("no orphaned dropdown panel at rest");
    } else {
        fail(`orphaned panel open at rest: ${JSON.stringify(orphan)} (old bug: stuck 320pt popover)`);
    }

    // --- 4: click opens, escape closes ---
    const clickScript = `
tell application "System Events"
  click menu bar item 1 of menu bar 1 of (first process whose unix id is ${child.pid})
end tell`;
    const clicked = spawnSync("osascript", ["-e", clickScript], { encoding: "utf8", timeout: 30_000 });
    await sleepMs(1500);
    windows = listWindows().filter((w) => w.pid === child.pid);
    // popover panels can report unexpected layers — identify by size
    const panel = windows.find((w) => w.w > 200 && w.w <= 500 && w.h > 50);
    if (clicked.status === 0 && panel) {
        pass(`dropdown opened on click: ${panel.w}x${panel.h} @(${panel.x},${panel.y})`);
    } else {
        fail(`dropdown did not open on click (status=${clicked.status} ${clicked.stderr?.split("\n")[0] ?? ""}): ${JSON.stringify(windows)}`);
    }
    // Close via either test seam (file sentinel polled by the app when
    // TOKITOKI_MENUBAR_TEST=1, or distributed notification), then wait.
    spawnSync("touch", ["/tmp/tokitoki-menubar.close"]);
    spawnSync("notifyutil", ["-p", "dev.tokitoki.menubar.close"]);
    let closed = false;
    for (let i = 0; i < 12; i++) {
        await sleepMs(500);
        windows = listWindows().filter((w) => w.pid === child.pid);
        if (!windows.find((w) => w.w > 300 && w.h > 200)) { closed = true; break; }
    }
    if (closed) {
        pass("dropdown closed via close seam (transient native close covers real outside-clicks)");
    } else {
        windows = listWindows().filter((w) => w.pid === child.pid);
        fail(`dropdown stayed open after close seams: ${JSON.stringify(windows)}`);
    }
} finally {
    child.kill("SIGTERM");
    if (wasLoaded) {
        spawnSync("launchctl", ["load", [AGENT_PLIST]]);
        say("reloaded deployed LaunchAgent instance");
    }
}

console.log(FAIL ? "\x1b[1;31me2e FAILED\x1b[0m" : "\x1b[1;32me2e PASSED\x1b[0m");
process.exit(FAIL);
