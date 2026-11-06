import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserView, BrowserWindow, Screen, Tray, Utils, type RPCSchema } from "electrobun/main";

import { dashboardUrl, importCommand, isPublicHttpsUrl, isSignInUrl, panelCommand, pollResult, systemTrayPopupFrame, tokitokiCommandCandidates, type Rectangle } from "../mainview/format.ts";
import { sessionDetailArguments, sessionListArguments } from "../mainview/sessions.ts";
import { configPathFromList, parseAlertHistory } from "../mainview/settings-info.ts";
import { addStoredApiKey, maskedApiKeys, readStoredApiKeys, removeStoredApiKey, storedApiKeyJson, type StoredApiKey } from "../mainview/api-keys.ts";

type AppRpc = {
  bun: RPCSchema<{
    requests: {
      loadPayload: { params: { cached: boolean }; response: { json: string } };
      loadSources: { params: Record<string, never>; response: { text: string } };
      loadSessions: { params: { query: string; page: number }; response: { json: string } };
      loadSession: { params: { provider: string; sessionId: string; offset: number }; response: { json: string } };
      reindexSessions: { params: Record<string, never>; response: { text: string } };
      loadSettingsInfo: { params: Record<string, never>; response: { configPath: string; alertsJson: string } };
      openConfig: { params: Record<string, never>; response: { ok: boolean; detail: string } };
      listApiKeys: { params: Record<string, never>; response: { json: string } };
      saveApiKey: { params: { id: string; label: string; provider: string; key: string }; response: { ok: boolean; detail: string } };
      removeApiKey: { params: { id: string; provider: string }; response: { ok: boolean; detail: string } };
      importCsv: { params: Record<string, never>; response: { ok: boolean; detail: string } };
      openDashboard: { params: { path: string }; response: { opened: boolean; detail: string; owned: boolean } };
      stopDashboard: { params: Record<string, never>; response: { detail: string; owned: boolean } };
      dashboardStatus: { params: Record<string, never>; response: { detail: string; owned: boolean } };
      // Not "apply": rpc.request is a function proxy, so that name is Function.prototype.apply.
      performAction: { params: { action: string; path?: string; value?: string; provider?: string; url?: string }; response: { ok: boolean; detail: string; authJson?: string } };
    };
    messages: {
      ready: { title: string };
      dismiss: { closed: boolean };
      summary: { text: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: Record<string, never>;
  }>;
};

async function runTokitoki(args: string[], quiet = false, keepFailureOutput = false): Promise<string> {
  const repositoryCli = path.join(import.meta.dir, "../../../../src/cli.ts");
  const candidates = tokitokiCommandCandidates({
    executableOverride: process.env.TOKITOKI_BIN,
    localApplicationData: process.env.LOCALAPPDATA,
    pathSeparator: path.sep,
    repositoryCli,
    repositoryCliExists: existsSync(repositoryCli),
    bunExecutable: process.execPath,
  });
  const errors: string[] = [];
  for (const command of candidates) {
    const executable = command[0];
    if (executable === undefined) continue;
    if (executable !== "tokitoki" && !existsSync(executable)) continue;
    try {
      console.log(quiet ? `run ${executable} ${args[0] ?? ""}` : `run ${command.concat(args).join(" ")}`);
      const child = Bun.spawn(command.concat(args), { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      const code = await child.exited;
      if (code === 0 || (keepFailureOutput && stdout.trim().length > 0)) return stdout;
      const detail = stderr.trim().length > 0 ? stderr.trim() : `exit ${code}`;
      errors.push(`${command.join(" ")}\n${detail}`);
    } catch (error) {
      errors.push(`${command.join(" ")}\n${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join("\n\n") || "tokitoki was not found");
}

async function chooseCsvFile(): Promise<string> {
  if (process.platform !== "win32") return "";
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Filter = 'CSV files (*.csv)|*.csv'",
    "$dialog.Title = 'Import usage CSV'",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.FileName) }",
  ].join("; ");
  const child = Bun.spawn(["powershell", "-NoProfile", "-STA", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) return "";
  return stdout.trim();
}

async function writeApiKeys(keys: StoredApiKey[]): Promise<void> {
  try {
    await runTokitoki(["config", "set", "poll.extraKeys", storedApiKeyJson(keys)], true);
  } catch {
    throw new Error("Could not save API keys");
  }
}

function notifyStatePath(): string {
  const dataDir = process.env.TOKITOKI_DATA_DIR ?? "";
  if (dataDir.length > 0) return path.join(dataDir, "notify-state.json");
  const xdgDataHome = process.env.XDG_DATA_HOME ?? "";
  if (xdgDataHome.length > 0) return path.join(xdgDataHome, "tokitoki", "notify-state.json");
  return path.join(os.homedir(), ".local", "share", "tokitoki", "notify-state.json");
}

function tokitokiLaunch(): string[] | undefined {
  const repositoryCli = path.join(import.meta.dir, "../../../../src/cli.ts");
  const candidates = tokitokiCommandCandidates({
    executableOverride: process.env.TOKITOKI_BIN,
    localApplicationData: process.env.LOCALAPPDATA,
    pathSeparator: path.sep,
    repositoryCli,
    repositoryCliExists: existsSync(repositoryCli),
    bunExecutable: process.execPath,
  });
  for (const command of candidates) {
    const executable = command[0];
    if (executable === undefined) continue;
    if (executable !== "tokitoki" && !existsSync(executable)) continue;
    return command;
  }
  return undefined;
}

let dashboardProcess: ReturnType<typeof Bun.spawn> | undefined;
let dashboardOpening = false;

function dashboardOwned(): boolean {
  return dashboardProcess !== undefined && dashboardProcess.exitCode === null;
}

async function dashboardReady(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:7788/api/healthz", { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("app" in body)) return false;
    const app = body.app;
    return app === "tokitoki";
  } catch {
    return false;
  }
}

async function dashboardState(): Promise<{ detail: string; owned: boolean }> {
  const owned = dashboardOwned();
  if (await dashboardReady()) {
    return { detail: owned ? "Running · owned by tokitoki" : "Running · external process", owned };
  }
  if (owned) return { detail: "Starting…", owned: true };
  return { detail: "Stopped", owned: false };
}

async function ensureDashboard(): Promise<{ ready: boolean; detail: string; owned: boolean }> {
  if (await dashboardReady()) {
    const owned = dashboardOwned();
    return { ready: true, detail: owned ? "Running · owned by tokitoki" : "Running · external process", owned };
  }
  let child = dashboardProcess;
  let startedHere = false;
  if (child === undefined || child.exitCode !== null) {
    const command = tokitokiLaunch();
    if (command === undefined) return { ready: false, detail: "Could not start dashboard", owned: false };
    const executable = command[0] ?? "";
    console.log(`run ${executable} web`);
    child = Bun.spawn(command.concat(["web"]), { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    dashboardProcess = child;
    startedHere = true;
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await dashboardReady()) return { ready: true, detail: "Running · owned by tokitoki", owned: true };
    if (child.exitCode !== null) {
      const stderr = startedHere ? await new Response(child.stderr).text() : "";
      if (dashboardProcess === child) dashboardProcess = undefined;
      const detail = stderr.trim().split("\n")[0] ?? "";
      return { ready: false, detail: detail.length > 0 ? detail.slice(0, 180) : "Could not start dashboard", owned: false };
    }
    await Bun.sleep(200);
  }
  return { ready: false, detail: "Dashboard did not become ready", owned: dashboardOwned() };
}

function sessionArgument(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("invalid session argument");
  }
  return trimmed;
}

const rpc = BrowserView.defineRPC<AppRpc>({
  handlers: {
    requests: {
      loadPayload: async (params) => {
        const args = ["widget-payload", "--json"];
        if (params.cached) args.push("--cached");
        console.log(`loadPayload ${args.join(" ")}`);
        const json = await runTokitoki(args);
        console.log(`loadPayload bytes ${json.length}`);
        return { json };
      },
      loadSources: async () => {
        const text = await runTokitoki(["sources"]);
        return { text };
      },
      loadSessions: async (params) => {
        const page = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1;
        const query = params.query.replace(/[\r\n]/g, " ");
        const json = await runTokitoki(sessionListArguments(query, page));
        return { json };
      },
      loadSession: async (params) => {
        const provider = sessionArgument(params.provider);
        const sessionId = sessionArgument(params.sessionId);
        const offset = Number.isFinite(params.offset) ? Math.max(0, Math.floor(params.offset)) : 0;
        const json = await runTokitoki(sessionDetailArguments(provider, sessionId, offset));
        return { json };
      },
      reindexSessions: async () => {
        const text = await runTokitoki(["reindex"]);
        return { text };
      },
      loadSettingsInfo: async () => {
        const text = await runTokitoki(["ui", "--list"]);
        const configPath = configPathFromList(text);
        const file = notifyStatePath();
        let alertsJson = "[]";
        try {
          alertsJson = JSON.stringify(parseAlertHistory(readFileSync(file, "utf8")));
        } catch {
          alertsJson = "[]";
        }
        return { configPath, alertsJson };
      },
      openConfig: async () => {
        const text = await runTokitoki(["ui", "--list"]);
        const configFile = configPathFromList(text);
        if (configFile.length === 0 || configFile.includes("\n") || configFile.includes("\r")) {
          return { ok: false, detail: "Config path was not found" };
        }
        if (!existsSync(configFile)) return { ok: false, detail: "Config file is not on disk yet" };
        const command = process.platform === "win32" ? ["cmd", "/c", "start", "", configFile] : ["xdg-open", configFile];
        const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
        const code = await child.exited;
        return { ok: code === 0, detail: code === 0 ? "Opened config file" : "Could not open config file" };
      },
      listApiKeys: async () => {
        const json = await runTokitoki(["config", "--json"]);
        return { json: JSON.stringify(maskedApiKeys(readStoredApiKeys(json))) };
      },
      saveApiKey: async (params) => {
        const existing = readStoredApiKeys(await runTokitoki(["config", "--json"]));
        const next = addStoredApiKey(existing, params);
        await writeApiKeys(next);
        return { ok: true, detail: "API key saved" };
      },
      removeApiKey: async (params) => {
        const existing = readStoredApiKeys(await runTokitoki(["config", "--json"]));
        await writeApiKeys(removeStoredApiKey(existing, params.id, params.provider));
        return { ok: true, detail: "API key removed" };
      },
      importCsv: async () => {
        const file = await chooseCsvFile();
        if (file.length === 0) return { ok: false, detail: "Import cancelled" };
        const command = importCommand(file);
        if (command === undefined || !existsSync(file)) return { ok: false, detail: "Choose a CSV file" };
        try {
          const text = await runTokitoki(command, true);
          const lines = text.trim().split("\n");
          const detail = lines[lines.length - 1] ?? "Import complete";
          return { ok: true, detail };
        } catch {
          return { ok: false, detail: "Import failed" };
        }
      },
      openDashboard: async (params) => {
        const url = dashboardUrl(params.path);
        if (url === undefined) return { opened: false, detail: "That dashboard page is not available", owned: dashboardOwned() };
        if (dashboardOpening) return { opened: false, detail: "Checking local dashboard…", owned: dashboardOwned() };
        dashboardOpening = true;
        try {
          const ready = await ensureDashboard();
          if (!ready.ready) return { opened: false, detail: ready.detail, owned: ready.owned };
          const opened = Utils.openExternal(url);
          return {
            opened: opened !== false,
            detail: opened !== false ? "Dashboard opened" : "Dashboard did not open",
            owned: dashboardOwned(),
          };
        } finally {
          dashboardOpening = false;
        }
      },
      stopDashboard: () => {
        if (!dashboardOwned()) return { detail: "Stopped · no server owned by tokitoki", owned: false };
        dashboardProcess?.kill();
        dashboardProcess = undefined;
        return { detail: "Stopped", owned: false };
      },
      dashboardStatus: async () => dashboardState(),
      performAction: async (params) => {
        if (params.action === "open") {
          const url = params.url ?? "";
          const signIn = isSignInUrl(url);
          if (!signIn && !isPublicHttpsUrl(url)) return { ok: false, detail: "That address is not available from the panel" };
          const opened = Utils.openExternal(url);
          const openedDetail = signIn ? "Sign-in opened" : "Status page opened";
          const failedDetail = signIn ? "Sign-in did not open" : "Status page did not open";
          return { ok: opened !== false, detail: opened !== false ? openedDetail : failedDetail };
        }
        const command = panelCommand(params);
        if (command === undefined) return { ok: false, detail: "That change is not available from the panel" };
        const polling = command[0] === "poll" && command.includes("--json");
        const text = await runTokitoki(command, false, polling);
        if (polling) return pollResult(text);
        const detail = text.trim().split("\n")[0] ?? "Saved";
        return { ok: true, detail };
      },
    },
    messages: {
      ready: (params) => {
        console.log(params.title);
      },
      dismiss: () => {
        tokitokiWindow.hide();
      },
      summary: (params) => {
        tray.setTitle(params.text);
        console.log(`tray title ${params.text}`);
      },
    },
  },
});

const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 640;
const POPUP_GAP = 8;

function workArea(): Rectangle {
  try {
    const display = Screen.getPrimaryDisplay();
    const area = display.workArea ?? display.bounds;
    if (area !== undefined && area.width > 0 && area.height > 0) {
      return { x: area.x, y: area.y, width: area.width, height: area.height };
    }
  } catch (error) {
    console.log(`display lookup failed ${error instanceof Error ? error.message : String(error)}`);
  }
  return { x: 0, y: 0, width: 1280, height: 800 };
}

function readTrayBounds(tray: Tray): Rectangle | undefined {
  try {
    const bounds = tray.getBounds();
    console.log(`tray bounds ${JSON.stringify(bounds)}`);
    if (bounds === undefined || bounds === null) return undefined;
    return { x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width ?? 0, height: bounds.height ?? 0 };
  } catch (error) {
    console.log(`tray bounds failed ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const tokitokiWindow = new BrowserWindow({
  title: "tokitoki",
  url: "views://mainview/index.html",
  titleBarStyle: "hidden",
  hidden: true,
  frame: { x: 0, y: 0, width: POPUP_WIDTH, height: POPUP_HEIGHT },
  rpc,
});

function showPopover(tray: Tray): void {
  const frame = systemTrayPopupFrame({
    trayBounds: readTrayBounds(tray),
    workArea: workArea(),
    popupWidth: POPUP_WIDTH,
    popupHeight: POPUP_HEIGHT,
    gap: POPUP_GAP,
    bottomInset: 88,
  });
  tokitokiWindow.setFrame(frame.x, frame.y, frame.width, frame.height);
  tokitokiWindow.setAlwaysOnTop(true);
  tokitokiWindow.show();
  console.log(`popover ${frame.x},${frame.y} ${frame.width}x${frame.height}`);
}

function trayImagePath(): string {
  const localApplicationData = process.env.LOCALAPPDATA;
  if (localApplicationData !== undefined) {
    const installed = path.join(localApplicationData, "tokitoki", "electrobun", "src", "mainview", "tray.ico");
    if (existsSync(installed)) return installed;
  }
  return "views://mainview/tray.png";
}

const trayImage = trayImagePath();
console.log(`tray image ${trayImage}`);
const tray = new Tray({
  title: "tokitoki",
  image: trayImage,
  template: false,
  width: 32,
  height: 32,
});

tray.on("tray-clicked", () => {
  if (tokitokiWindow.isVisible()) tokitokiWindow.hide();
  else showPopover(tray);
});

showPopover(tray);
setTimeout(() => {
  const bounds = readTrayBounds(tray);
  if (bounds !== undefined && bounds.width > 0 && bounds.height > 0) showPopover(tray);
}, 600);
console.log("tokitoki window open");
