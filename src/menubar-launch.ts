/**
 * Launcher for the menubar app behind `tokitoki menubar`.
 *
 * This is the inverse map of the Swift app's `resolveInvocation()` (which
 * locates the CLI): here the CLI locates the app, same priority order —
 * keep the two lists in sync (see main.swift "Locate the CLI by walking up").
 *
 * Pure decision logic (resolution order, pidfile liveness, darwin branch
 * choice) is separated from side effects via injectable `opts` so tests can
 * stub binaries, runners and plists without touching the real system.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawn } from "node:child_process";

import { dataDir } from "./store.ts";

const LAUNCH_AGENT_LABEL = "dev.tokitoki.menubar";
export const MENUBAR_BIN_NAME = "tokitoki-menubar";

/** Executable runner abstraction — real impl shells out, tests stub. */
export type Runner = (
  file: string,
  args: string[],
) => { ok: boolean } | Promise<{ ok: boolean }>;

function runReal(file: string, args: string[]): { ok: boolean } {
  try {
    // Synchronous one-shot shell-out (launchctl); Bun's spawnSync is fine here.
    const res = Bun.spawnSync([file, ...args], { stdout: "ignore", stderr: "ignore" });
    return { ok: res.exitCode === 0 };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------- resolution

export interface ResolveOpts {
  /** Overrides process.env.TOKITOKI_MENUBAR_BIN (tests). */
  envBin?: string;
  /** Overrides process.cwd() for the repo-walk (tests). */
  cwd?: string;
  /** Overrides os.homedir() (tests). */
  home?: string;
  exists?: (p: string) => boolean;
}

export type ResolvedMenubarBin = {
  path: string;
  source: "env" | "repo-build" | "home-bin";
};

/**
 * Locate the menubar app binary. Priority mirrors main.swift's inverse map:
 *   1. $TOKITOKI_MENUBAR_BIN
 *   2. <cwd-walk>/menubar/tokitoki-menubar/.build/release/tokitoki-menubar
 *   3. ~/bin/tokitoki-menubar
 */
export function resolveMenubarBin(opts: ResolveOpts = {}): ResolvedMenubarBin | null {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const home = opts.home ?? os.homedir();

  const envBin =
    opts.envBin ?? process.env.TOKITOKI_MENUBAR_BIN;
  if (envBin !== undefined && envBin.length > 0 && exists(envBin)) {
    return { path: envBin, source: "env" };
  }

  // Walk up from cwd like the Swift app walks up looking for dist/tokitoki.
  let url = path.resolve(opts.cwd ?? process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(
      url,
      "menubar",
      "tokitoki-menubar",
      ".build",
      "release",
      MENUBAR_BIN_NAME,
    );
    if (exists(candidate)) return { path: candidate, source: "repo-build" };
    const parent = path.dirname(url);
    if (parent === url) break;
    url = parent;
  }

  const homeBin = path.join(home, "bin", MENUBAR_BIN_NAME);
  if (exists(homeBin)) return { path: homeBin, source: "home-bin" };

  return null;
}

// ------------------------------------------------------------------ pidfile

export function menubarPidFile(): string {
  return path.join(dataDir(), "menubar.pid");
}

interface PidIdentityOpts {
  /** Injected identity probe (tests). Returns the process command line or null when unknown. */
  identity?: (pid: number) => string | null;
}

function commandForPid(pid: number): string | null {
  try {
    const res = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return new TextDecoder().decode(res.stdout).trim();
  } catch {
    return null;
  }
}

/**
 * True when `pid` belongs to a live tokitoki-menubar process. Two checks:
 * signal-0 liveness, then identity via `ps -p <pid> -o command=` (argv[0]
 * match) so a recycled pid isn't mistaken for our app. When identity can't
 * be determined (ps missing/failed), liveness wins — no false negatives.
 */
export async function isMenubarRunning(pid: number, opts: PidIdentityOpts = {}): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // ESRCH: no such process
  }
  const comm = (opts.identity ?? commandForPid)(pid);
  if (comm === null || comm.length === 0) return true;
  return comm.includes(MENUBAR_BIN_NAME);
}

async function readLivePid(opts: PidIdentityOpts & { pidFile?: string } = {}): Promise<number | null> {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.pidFile ?? menubarPidFile(), "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // Garbage pidfile — clean it.
    try {
      fs.unlinkSync(opts.pidFile ?? menubarPidFile());
    } catch {
      // ignore
    }
    return null;
  }
  if (await isMenubarRunning(pid, opts)) return pid;
  // Stale pidfile — clean it.
  try {
    fs.unlinkSync(opts.pidFile ?? menubarPidFile());
  } catch {
    // ignore
  }
  return null;
}

// -------------------------------------------------------------- darwin bits

export function launchAgentPlistPath(home?: string): string {
  return path.join(home ?? os.homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * Read the executable configured as the first LaunchAgent ProgramArgument.
 * The plist is intentionally parsed narrowly: this is only used to verify
 * that a rebuild will update the binary launchd actually executes.
 */
export function launchAgentProgramPath(home?: string): string | null {
  let plist: string;
  try {
    plist = fs.readFileSync(launchAgentPlistPath(home), "utf8");
  } catch {
    return null;
  }
  const match = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
  );
  return match?.[1] ?? null;
}

/**
 * Install a freshly rebuilt repo binary only when the user's LaunchAgent
 * explicitly points at the conventional ~/bin target. This avoids silently
 * overwriting an unrelated custom binary or an env-selected app.
 */
export function installRebuiltMenubarBinary(
  sourcePath: string,
  home = os.homedir(),
): string | null {
  const expectedTarget = path.join(home, "bin", MENUBAR_BIN_NAME);
  if (launchAgentProgramPath(home) !== expectedTarget) return null;
  fs.mkdirSync(path.dirname(expectedTarget), { recursive: true });
  fs.copyFileSync(sourcePath, expectedTarget);
  fs.chmodSync(expectedTarget, 0o755);
  return expectedTarget;
}

function uid(): number {
  return process.getuid?.() ?? 501;
}

interface LaunchCtlOpts {
  home?: string;
  runner?: Runner;
  plistExists?: boolean;
}

/**
 * Darwin start preference: when the LaunchAgent plist exists, manage the app
 * through launchd (KeepAlive owns restarts) instead of raw-spawning — mirror
 * of main.swift's toggleStartAtLogin/quit paths.
 *
 * Returns "bootstrapped" | "already-bootstrapped" | "failed" | "no-plist".
 */
export async function startViaLaunchCtlIfConfigured(opts: LaunchCtlOpts = {}): Promise<
  "bootstrapped" | "already-bootstrapped" | "failed" | "no-plist"
> {
  const plist = launchAgentPlistPath(opts.home);
  const plistExists = opts.plistExists ?? fs.existsSync(plist);
  if (!plistExists) return "no-plist";
  const runner = opts.runner ?? runReal;
  const label = LAUNCH_AGENT_LABEL;

  const listed = await runner("/bin/launchctl", ["print", `gui/${uid()}/${label}`]);
  if (listed.ok) return "already-bootstrapped";
  const res = await runner("/bin/launchctl", ["bootstrap", `gui/${uid()}`, plist]);
  if (!res.ok) {
    const already = await runner("/bin/launchctl", ["print", `gui/${uid()}/${label}`]);
    return already.ok ? "already-bootstrapped" : "failed";
  }
  return "bootstrapped";
}

export async function stopLaunchAgent(opts: LaunchCtlOpts = {}): Promise<boolean> {
  const plist = launchAgentPlistPath(opts.home);
  const plistExists = opts.plistExists ?? fs.existsSync(plist);
  if (!plistExists) return false;
  const runner = opts.runner ?? runReal;
  const res = await runner("/bin/launchctl", ["bootout", `gui/${uid()}/${LAUNCH_AGENT_LABEL}`]);
  return res.ok;
}

// ------------------------------------------------------------ start / stop

export interface StartOpts extends ResolveOpts, PidIdentityOpts, Omit<LaunchCtlOpts, "runner"> {
  runner?: Runner;
  /** Test seam for launchd's asynchronously spawned process. */
  findPid?: () => number | null | Promise<number | null>;
  pidFile?: string;
  /** Test hook: spawn this instead of the real binary. */
  spawnBin?: string;
  platform?: NodeJS.Platform;
}

export type StartResult =
  | { status: "running"; pid: number; mode: "launchd" }
  | { status: "started"; pid: number; mode: "launchd" | "detached" };

export async function startMenubar(opts: StartOpts = {}): Promise<StartResult> {
  // Idempotency first: a live instance wins regardless of how it was started.
  const livePid = await readLivePid(opts);
  if (livePid !== null) {
    return { status: "running", pid: livePid, mode: "launchd" };
  }

  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const launchctl = await startViaLaunchCtlIfConfigured({
      home: opts.home,
      runner: opts.runner,
      plistExists: opts.plistExists,
    });
    if (launchctl !== "no-plist") {
      if (launchctl === "failed") throw new Error("launchd could not bootstrap the menubar LaunchAgent");
      // launchd owns the process and starts it asynchronously. Wait briefly
      // so the CLI cannot report a successful PID -1 startup.
      const findPid = opts.findPid ?? findAppPid;
      const pid = await waitForAppPid(findPid);
      if (pid === null && opts.runner === undefined) {
        throw new Error("launchd accepted the menubar LaunchAgent but the app did not start");
      }
      const finalPid = pid ?? -1;
      if (pid !== null) fs.writeFileSync(opts.pidFile ?? menubarPidFile(), String(pid));
      return { status: "started", pid: finalPid, mode: "launchd" };
    }
  }

  const resolved = resolveMenubarBin({ ...opts });
  if (resolved === null) {
    throw new Error(
      "tokitoki-menubar binary not found (looked at $TOKITOKI_MENUBAR_BIN, repo build, ~/bin). " +
        "Build it: cd menubar/tokitoki-menubar && swift build -c release",
    );
  }
  const bin = opts.spawnBin ?? resolved.path;
  const child = spawn(bin, [], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`failed to spawn ${bin}`);
  fs.writeFileSync(opts.pidFile ?? menubarPidFile(), String(child.pid));
  return { status: "started", pid: child.pid, mode: "detached" };
}

async function findAppPid(): Promise<number | null> {
  // pgrep -x matches exact process name; cheap and avoids parsing ps output twice.
  try {
    const proc = Bun.spawnSync(["pgrep", "-x", MENUBAR_BIN_NAME], { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    const first = new TextDecoder().decode(proc.stdout).trim().split("\n")[0];
    const pid = Number.parseInt(first ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForAppPid(findPid: () => number | null | Promise<number | null>): Promise<number | null> {
  // SwiftUI/AppKit startup can take several seconds while the first payload
  // is loaded. Keep `bun run menubar` deterministic instead of reporting a
  // false failure during launchd's asynchronous hand-off.
  // A cold SwiftUI/AppKit launch after a freshly linked binary can take more
  // than ten seconds while LaunchServices registers the app. Keep the CLI
  // deterministic without declaring a false failure during that window.
  for (let i = 0; i < 300; i++) {
    const pid = await findPid();
    if (pid !== null) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export interface StopOpts extends PidIdentityOpts, Omit<LaunchCtlOpts, "runner"> {
  runner?: Runner;
  pidFile?: string;
  platform?: NodeJS.Platform;
}

export type StopResult = { status: "stopped"; via: "launchd" | "signal" } | { status: "not-running" };

export async function stopMenubar(opts: StopOpts = {}): Promise<StopResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const viaLaunchd = await stopLaunchAgent({
      home: opts.home,
      runner: opts.runner,
      plistExists: opts.plistExists,
    });
    if (viaLaunchd) {
      try {
        fs.unlinkSync(opts.pidFile ?? menubarPidFile());
      } catch {
        // The pidfile is best-effort state and may already be absent.
      }
      return { status: "stopped", via: "launchd" };
    }
  }
  const pid = await readLivePid(opts);
  if (pid === null) return { status: "not-running" };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  try {
    fs.unlinkSync(opts.pidFile ?? menubarPidFile());
  } catch {
    // ignore
  }
  return { status: "stopped", via: "signal" };
}

export interface StatusOpts extends PidIdentityOpts, Omit<LaunchCtlOpts, "runner"> {
  pidFile?: string;
  platform?: NodeJS.Platform;
}

export type StatusResult = { status: "running"; pid: number } | { status: "stopped" };

export async function menubarStatus(opts: StatusOpts = {}): Promise<StatusResult> {
  const pid = await readLivePid(opts);
  if (pid !== null) return { status: "running", pid };

  // launchd can restart a KeepAlive job without going through this CLI, so
  // the best-effort pidfile may lag behind the real process. Recover status
  // from the configured LaunchAgent and refresh the pidfile for later calls.
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const plist = opts.plistExists ?? fs.existsSync(launchAgentPlistPath(opts.home));
    if (plist) {
      const launchdPid = await findAppPid();
      if (launchdPid !== null) {
        try {
          fs.writeFileSync(opts.pidFile ?? menubarPidFile(), String(launchdPid));
        } catch {
          // Status remains useful even when pidfile repair is unavailable.
        }
        return { status: "running", pid: launchdPid };
      }
    }
  }
  return { status: "stopped" };
}
