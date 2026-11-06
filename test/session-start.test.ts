import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  electrobunDirectory,
  installSessionStart,
  panelLaunch,
  removeSessionStart,
  sessionStartLayout,
} from "../src/session-start.ts";

describe("panelLaunch", () => {
  it("uses the Swift menu bar on macOS", () => {
    expect(
      panelLaunch({
        platform: "darwin",
        menubarBinary: "/Users/me/bin/tokitoki-menubar",
        bunBinary: "/Users/me/.bun/bin/bun",
        electrobunDirectory: "/Users/me/tokitoki/menubar/electrobun",
      }),
    ).toEqual({ command: ["/Users/me/bin/tokitoki-menubar"] });
    expect(panelLaunch({ platform: "darwin" })).toBeNull();
  });

  it("prefers the Quickshell launcher, then the Electrobun checkout", () => {
    expect(
      panelLaunch({
        platform: "linux",
        quickshellBinary: "/nix/store/tokitoki-quickshell",
        bunBinary: "/usr/bin/bun",
        electrobunDirectory: "/src/tokitoki/menubar/electrobun",
      }),
    ).toEqual({ command: ["/nix/store/tokitoki-quickshell", "--no-duplicate"] });
    expect(
      panelLaunch({
        platform: "win32",
        bunBinary: "C:\\Users\\me\\.bun\\bin\\bun.exe",
        electrobunDirectory: "C:\\src\\tokitoki\\menubar\\electrobun",
      }),
    ).toEqual({
      command: [
        "C:\\Users\\me\\.bun\\bin\\bun.exe",
        "--cwd=C:\\src\\tokitoki\\menubar\\electrobun",
        "run",
        "dev",
      ],
    });
    expect(panelLaunch({ platform: "linux", bunBinary: "/usr/bin/bun" })).toBeNull();
  });
});

describe("sessionStartLayout", () => {
  it("writes a RunAtLoad LaunchAgent on macOS", () => {
    const layout = sessionStartLayout({
      platform: "darwin",
      home: "/Users/me",
      userId: 501,
      dataDirectory: "/Users/me/.local/share/tokitoki",
      launch: { command: ["/Users/me/bin/tokitoki-menubar"] },
    });
    expect(layout.files[0]?.path).toBe("/Users/me/Library/LaunchAgents/dev.tokitoki.menubar.plist");
    expect(layout.files[0]?.contents).toContain("<key>RunAtLoad</key><true/>");
    expect(layout.files[0]?.contents).toContain("<key>KeepAlive</key><true/>");
    expect(layout.files[0]?.contents).toContain("<string>/Users/me/bin/tokitoki-menubar</string>");
    expect(layout.bootstrap?.args).toEqual([
      "bootstrap",
      "gui/501",
      "/Users/me/Library/LaunchAgents/dev.tokitoki.menubar.plist",
    ]);
  });

  it("escapes plist text", () => {
    const layout = sessionStartLayout({
      platform: "darwin",
      home: "/Users/me",
      userId: 501,
      dataDirectory: "/tmp/tokitoki",
      launch: { command: ["/Users/me/bin/a&b"] },
    });
    expect(layout.files[0]?.contents).toContain("<string>/Users/me/bin/a&amp;b</string>");
  });

  it("writes an XDG autostart entry for the Electrobun tray", () => {
    const layout = sessionStartLayout({
      platform: "linux",
      home: "/home/me",
      configHome: "/home/me/.config",
      dataDirectory: "/home/me/.local/share/tokitoki",
      launch: {
        command: ["/home/me/.bun/bin/bun", "--cwd=/src/menubar/electrobun", "run", "dev"],
      },
    });
    expect(layout.files).toHaveLength(1);
    expect(layout.files[0]?.contents).toContain(
      "Exec=/home/me/.bun/bin/bun --cwd=/src/menubar/electrobun run dev",
    );
  });

  it("points the desktop entry straight at Quickshell", () => {
    const layout = sessionStartLayout({
      platform: "linux",
      home: "/home/me",
      dataDirectory: "/home/me/.local/share/tokitoki",
      launch: { command: ["/nix/store/tokitoki-quickshell", "--no-duplicate"] },
    });
    expect(layout.files).toHaveLength(1);
    expect(layout.files[0]?.contents).toContain("Exec=/nix/store/tokitoki-quickshell --no-duplicate");
  });

  it("writes a Startup command on Windows", () => {
    const layout = sessionStartLayout({
      platform: "win32",
      home: "C:\\Users\\me",
      appData: "C:\\Users\\me\\AppData\\Roaming",
      dataDirectory: "C:\\Users\\me\\.local\\share\\tokitoki",
      launch: {
        command: [
          "C:\\Users\\me\\.bun\\bin\\bun.exe",
          "--cwd=C:\\src\\tokitoki\\menubar\\electrobun",
          "run",
          "dev",
        ],
      },
    });
    expect(layout.files[0]?.path).toBe(
      "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\tokitoki.cmd",
    );
    expect(layout.files[0]?.contents).toContain(
      'start "" "C:\\Users\\me\\.bun\\bin\\bun.exe" "--cwd=C:\\src\\tokitoki\\menubar\\electrobun" "run" "dev"',
    );
  });
});

describe("install and remove", () => {
  it("writes the files and deletes them again", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tk-session-"));
    try {
      const layout = sessionStartLayout({
        platform: "linux",
        home: root,
        configHome: path.join(root, "config"),
        dataDirectory: path.join(root, "share"),
        launch: { command: ["/bin/bun", "--cwd=/src/electrobun", "run", "dev"] },
      });
      const written = installSessionStart(layout);
      expect(written).toHaveLength(1);
      expect(readFileSync(written[0] ?? "", "utf8")).toContain("--cwd=/src/electrobun");
      removeSessionStart(layout);
      expect(() => readFileSync(written[0]!, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("electrobunDirectory", () => {
  it("finds a checkout above the working directory", () => {
    const root = "/repo";
    const found = electrobunDirectory("/repo/src/cli", (candidate) => candidate === "/repo/menubar/electrobun/package.json");
    expect(found).toBe("/repo/menubar/electrobun");
  });
});
