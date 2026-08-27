import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isMenubarRunning,
  installRebuiltMenubarBinary,
  launchAgentProgramPath,
  menubarPidFile,
  menubarStatus,
  resolveMenubarBin,
  startMenubar,
  stopMenubar,
  type Runner,
} from "../src/menubar-launch.ts";

function tmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "tk-menubar-"));
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
});

describe("resolveMenubarBin", () => {
  it("prefers env override > repo-build > home-bin > null", () => {
    const home = tmpdir();
    const repo = tmpdir();
    cleanupDirs.push(home, repo);

    // Nothing exists → null
    expect(resolveMenubarBin({ cwd: repo, home, envBin: "" })).toBeNull();

    // home-bin found
    mkdirSync(path.join(home, "bin"), { recursive: true });
    writeFileSync(path.join(home, "bin", "tokitoki-menubar"), "");
    expect(resolveMenubarBin({ cwd: repo, home, envBin: "" })).toEqual({
      path: path.join(home, "bin", "tokitoki-menubar"),
      source: "home-bin",
    });

    // repo-build beats home-bin
    const buildDir = path.join(repo, "menubar", "tokitoki-menubar", ".build", "release");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(path.join(buildDir, "tokitoki-menubar"), "");
    expect(resolveMenubarBin({ cwd: repo, home, envBin: "" })).toEqual({
      path: path.join(buildDir, "tokitoki-menubar"),
      source: "repo-build",
    });
    // walk-up finds it from a nested cwd too
    const nested = path.join(repo, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(resolveMenubarBin({ cwd: nested, home, envBin: "" })?.source).toBe("repo-build");

    // env beats everything
    const envPath = path.join(home, "env-menubar");
    writeFileSync(envPath, "");
    expect(resolveMenubarBin({ cwd: repo, home, envBin: envPath })).toEqual({
      path: envPath,
      source: "env",
    });
  });

  it("ignores nonexistent env paths and caps the repo walk", () => {
    const home = tmpdir();
    const deep = path.join(tmpdir(), "a", "b", "c", "d", "e", "f", "g"); // >6 levels below any repo
    cleanupDirs.push(home);
    mkdirSync(deep, { recursive: true });
    expect(resolveMenubarBin({ cwd: deep, home, envBin: "/nonexistent/bin" })).toBeNull();
  });
});

describe("LaunchAgent deployment", () => {
  it("updates only the conventional home-bin target configured by the plist", () => {
    const home = tmpdir();
    cleanupDirs.push(home);
    const launchAgents = path.join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(
      path.join(launchAgents, "dev.tokitoki.menubar.plist"),
      [
        "<plist><dict>",
        "<key>ProgramArguments</key>",
        "<array><string>" + path.join(home, "bin", "tokitoki-menubar") + "</string><string>--x</string></array>",
        "</dict></plist>",
      ].join(""),
    );
    const source = path.join(home, "rebuilt-menubar");
    writeFileSync(source, "new build");

    expect(launchAgentProgramPath(home)).toBe(path.join(home, "bin", "tokitoki-menubar"));
    const installed = installRebuiltMenubarBinary(source, home);
    expect(installed).toBe(path.join(home, "bin", "tokitoki-menubar"));
    expect(readFileSync(installed!, "utf8")).toBe("new build");

    const custom = path.join(home, "custom-menubar");
    writeFileSync(
      path.join(launchAgents, "dev.tokitoki.menubar.plist"),
      `<key>ProgramArguments</key><array><string>${custom}</string></array>`,
    );
    expect(installRebuiltMenubarBinary(source, home)).toBeNull();
  });

  it("makes the installed binary executable", () => {
    const home = tmpdir();
    cleanupDirs.push(home);
    const launchAgents = path.join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    const target = path.join(home, "bin", "tokitoki-menubar");
    writeFileSync(
      path.join(launchAgents, "dev.tokitoki.menubar.plist"),
      `<key>ProgramArguments</key><array><string>${target}</string></array>`,
    );
    const source = path.join(home, "rebuilt-menubar");
    writeFileSync(source, "binary");
    chmodSync(source, 0o644);
    installRebuiltMenubarBinary(source, home);
    expect(statSync(target).mode & 0o111).toBeGreaterThan(0);
  });
});

describe("pidfile liveness", () => {
  it("treats own pid as running when identity matches", async () => {
    const dir = tmpdir();
    process.env.TOKITOKI_DATA_DIR = dir;
    try {
      // identity probe returns our own command line (contains 'bun')
      const own = await isMenubarRunning(process.pid, { identity: () => "tokitoki-menubar helper" });
      expect(own).toBe(true);
      const foreign = await isMenubarRunning(process.pid, { identity: () => "/usr/sbin/cron" });
      expect(foreign).toBe(false);
      const unknown = await isMenubarRunning(process.pid, { identity: () => null });
      expect(unknown).toBe(true); // liveness wins when identity unavailable
      const dead = await isMenubarRunning(999_999_999);
      expect(dead).toBe(false);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("cleans up stale pidfiles and reports stopped", async () => {
    const dir = tmpdir();
    process.env.TOKITOKI_DATA_DIR = dir;
    try {
      writeFileSync(menubarPidFile(), "999999999\n");
      const status = await menubarStatus({ identity: () => "tokitoki-menubar" });
      expect(status).toEqual({ status: "stopped" });
      // stale pidfile was removed
      let existed = false;
      try {
        readExists(menubarPidFile());
        existed = true;
      } catch {
        existed = false;
      }
      expect(existed).toBe(false);
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }

    function readExists(p: string): void {
      // throws when missing
      // eslint-disable-next-line
      require("node:fs").readFileSync(p);
    }
  });
});

describe("start/stop flow with stubbed binary", () => {
  it("transitions started -> running -> stopped with pidfile cleanup", async () => {
    if (!fsExists("/bin/sleep")) return; // skip gracefully
    const dir = tmpdir();
    process.env.TOKITOKI_DATA_DIR = dir;
    const pidFile = path.join(dir, "menubar.pid");
    try {
      // /bin/sleep as a stand-in long-running "app"
      const started = await startMenubar({
        spawnBin: "/bin/sleep",
        platform: "linux", // bypass darwin launchctl branch entirely
        pidFile,
        envBin: "/bin/sleep", // satisfy resolution so startMenubar proceeds to spawn
        home: "/nonexistent-home",
        cwd: "/nonexistent-cwd",
      });
      expect(started.status).toBe("started");
      if (started.status !== "started") return;
      expect(started.mode).toBe("detached");
      const sleepPid = started.pid;

      // Running now: identity probe reports the app name.
      const running = await menubarStatus({
        pidFile,
        identity: (pid) => (pid === sleepPid ? "/bin/sleep 30 tokitoki-menubar" : null),
      });
      expect(running).toEqual({ status: "running", pid: sleepPid });

      // Idempotent: starting again does NOT spawn a second instance.
      const again = await startMenubar({
        spawnBin: "/bin/sleep",
        platform: "linux",
        pidFile,
        envBin: "/bin/sleep",
        home: "/nonexistent-home",
        cwd: "/nonexistent-cwd",
        identity: (pid) => (pid === sleepPid ? "tokitoki-menubar" : null),
      });
      expect(again).toEqual({ status: "running", pid: sleepPid, mode: "launchd" });

      const stopped = await stopMenubar({
        platform: "linux",
        pidFile,
        plistExists: false,
        identity: (pid) => (pid === sleepPid ? "tokitoki-menubar" : null),
      });
      expect(stopped.status === "stopped" && stopped.via === "signal").toBe(true);
      expect(await menubarStatus({ pidFile, identity: () => "tokitoki-menubar" })).toEqual({
        status: "stopped",
      });
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  }, 15_000);
});

describe("darwin launchctl branch", () => {
  const recordedCalls: Array<{ file: string; args: string[] }> = [];
  const fakeRunner: Runner = (_file, args) => {
    recordedCalls.push({ file: _file, args });
    // `print` fails (= not bootstrapped), everything else succeeds
    return { ok: !args.includes("print") };
  };

  it("bootstraps via launchd instead of raw-spawning when plist exists", async () => {
    const dir = tmpdir();
    process.env.TOKITOKI_DATA_DIR = dir;
    const home = tmpdir();
    cleanupDirs.push(home);
    try {
      const result = await startMenubar({
        platform: "darwin",
        plistExists: true,
        runner: fakeRunner,
        pidFile: path.join(dir, "menubar.pid"),
        home,
        envBin: "", // resolution must not matter on this branch
        cwd: "/nonexistent",
        identity: () => null,
      });
      expect(result.mode).toBe("launchd");
      const bootstrapCall = recordedCalls.find((c) => c.args[0] === "bootstrap");
      expect(bootstrapCall?.args[1]).toMatch(/^gui\/\d+$/);
      expect(bootstrapCall?.args[2]).toContain("dev.tokitoki.menubar.plist");
      expect(recordedCalls.some((c) => c.args[0] === "print")).toBe(true);
      // No raw spawn happened — pgrep would only find a real app; assert pidfile untouched or empty
    } finally {
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("stop prefers bootout when plist exists", async () => {
    recordedCalls.length = 0;
    const okRunner: Runner = () => ({ ok: true });
    const dir = tmpdir();
    const pidFile = path.join(dir, "menubar.pid");
    writeFileSync(pidFile, "1234");
    const res = await stopMenubar({
      platform: "darwin",
      plistExists: true,
      runner: okRunner,
      pidFile,
    });
    expect(res).toEqual({ status: "stopped", via: "launchd" });
    expect(() => readFileSync(pidFile)).toThrow();
  });
});

function fsExists(p: string): boolean {
  try {
    require("node:fs").accessSync(p);
    return true;
  } catch {
    return false;
  }
}
