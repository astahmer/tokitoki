/**
 * Login items for the panel. macOS uses a LaunchAgent, Linux an XDG autostart
 * entry, Windows a Startup-folder command. Each one runs when the user signs
 * in, which is when a tray icon can appear.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PanelLaunch {
  command: string[];
  workingDirectory?: string;
}

export interface SessionStartFile {
  path: string;
  contents: string;
  executable: boolean;
}

export interface SessionStartLayout {
  files: SessionStartFile[];
  /** Removed together with the files above when login start is turned off. */
  removePaths: string[];
  /** Present on macOS so launchd loads the new agent. */
  bootstrap?: { file: string; args: string[] };
  bootout?: { file: string; args: string[] };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function quoteDesktop(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function quoteCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function panelLaunch(input: {
  platform: "darwin" | "linux" | "win32";
  menubarBinary?: string;
  quickshellBinary?: string;
  bunBinary?: string;
  electrobunDirectory?: string;
}): PanelLaunch | null {
  if (input.platform === "darwin") {
    if (input.menubarBinary === undefined || input.menubarBinary.length === 0) return null;
    return { command: [input.menubarBinary] };
  }
  if (input.quickshellBinary !== undefined && input.quickshellBinary.length > 0) {
    return { command: [input.quickshellBinary, "--no-duplicate"] };
  }
  if (input.bunBinary === undefined || input.bunBinary.length === 0) return null;
  if (input.electrobunDirectory === undefined || input.electrobunDirectory.length === 0) return null;
  // --cwd keeps the checkout path in the process command line, so a later
  // status check can tell this tray apart from an unrelated bun process.
  return { command: [input.bunBinary, `--cwd=${input.electrobunDirectory}`, "run", "dev"] };
}

export function sessionStartLayout(input: {
  platform: "darwin" | "linux" | "win32";
  home: string;
  launch: PanelLaunch;
  configHome?: string;
  appData?: string;
  dataDirectory: string;
  userId?: number;
}): SessionStartLayout {
  if (input.platform === "darwin") {
    const plistPath = `${input.home}/Library/LaunchAgents/dev.tokitoki.menubar.plist`;
    const args = input.launch.command.map((part) => `    <string>${xmlEscape(part)}</string>`).join("\n");
    const plist = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0"><dict>`,
      `  <key>Label</key><string>dev.tokitoki.menubar</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      args,
      `  </array>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key><true/>`,
      `</dict></plist>`,
      ``,
    ].join("\n");
    if (input.userId === undefined) throw new Error("macOS login start needs the user id");
    const uid = input.userId;
    return {
      files: [{ path: plistPath, contents: plist, executable: false }],
      removePaths: [plistPath],
      bootstrap: { file: "/bin/launchctl", args: ["bootstrap", `gui/${uid}`, plistPath] },
      bootout: { file: "/bin/launchctl", args: ["bootout", `gui/${uid}/dev.tokitoki.menubar`] },
    };
  }

  if (input.platform === "linux") {
    const configHome = input.configHome ?? `${input.home}/.config`;
    const desktopPath = `${configHome}/autostart/tokitoki.desktop`;
    const scriptPath = `${input.dataDirectory}/start-panel.sh`;
    const direct = input.launch.workingDirectory === undefined;
    const exec = direct
      ? input.launch.command.map(quoteDesktop).join(" ")
      : quoteDesktop(scriptPath);
    const desktop = [
      `[Desktop Entry]`,
      `Type=Application`,
      `Name=tokitoki`,
      `Comment=Coding-agent usage panel`,
      `Exec=${exec}`,
      `Terminal=false`,
      `X-GNOME-Autostart-enabled=true`,
      ``,
    ].join("\n");
    const files: SessionStartFile[] = [{ path: desktopPath, contents: desktop, executable: false }];
    const removePaths = [desktopPath];
    if (!direct) {
      const lines = ["#!/bin/sh", `cd ${quoteDesktop(input.launch.workingDirectory ?? "")} || exit 1`];
      lines.push(`exec ${input.launch.command.map(quoteDesktop).join(" ")}`);
      files.push({ path: scriptPath, contents: `${lines.join("\n")}\n`, executable: true });
      removePaths.push(scriptPath);
    }
    return { files, removePaths };
  }

  const appData = input.appData ?? path.win32.join(input.home, "AppData", "Roaming");
  const cmdPath = path.win32.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "tokitoki.cmd",
  );
  const lines = ["@echo off"];
  if (input.launch.workingDirectory !== undefined) {
    lines.push(`cd /d ${quoteCmd(input.launch.workingDirectory)}`);
  }
  const started = input.launch.command.map(quoteCmd).join(" ");
  lines.push(`start "" ${started}`);
  return {
    files: [{ path: cmdPath, contents: `${lines.join("\r\n")}\r\n`, executable: false }],
    removePaths: [cmdPath],
  };
}

/** Walk up from the working directory to a checkout that contains the Electrobun panel. */
export function electrobunDirectory(start: string, exists: (candidate: string) => boolean): string | null {
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    const marker = path.join(dir, "menubar", "electrobun", "package.json");
    if (exists(marker)) return path.join(dir, "menubar", "electrobun");
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function installSessionStart(layout: SessionStartLayout): string[] {
  const written: string[] = [];
  for (const file of layout.files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
    if (file.executable) chmodSync(file.path, 0o755);
    written.push(file.path);
  }
  return written;
}

export function removeSessionStart(layout: SessionStartLayout): void {
  for (const target of layout.removePaths) {
    rmSync(target, { force: true });
  }
}
