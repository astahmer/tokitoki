import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccountOrderRequest } from "../src/account-order-api.ts";
import { moveAccountOrder } from "../src/account-order.ts";
import { loadConfig } from "../src/config.ts";
import { accountUiPreferences, isCardVisibleOn, setPreviewAccountVisibility, setSurfaceVisibility } from "../src/uiToggles.ts";

const originalConfig = process.env.TOKITOKI_CONFIG;
const originalData = process.env.TOKITOKI_DATA_DIR;
const directories: string[] = [];
afterEach(() => {
  if (originalConfig === undefined) delete process.env.TOKITOKI_CONFIG;
  else process.env.TOKITOKI_CONFIG = originalConfig;
  if (originalData === undefined) delete process.env.TOKITOKI_DATA_DIR;
  else process.env.TOKITOKI_DATA_DIR = originalData;
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "tokitoki-presentation-"));
  directories.push(directory);
  process.env.TOKITOKI_CONFIG = join(directory, "config.json");
  process.env.TOKITOKI_DATA_DIR = directory;
  writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({ ui: { menubarAccountOrder: ["codex@work", "codex@personal"] } }));
};
const request = (path: string, body: unknown, origin = "http://localhost:6736") => handleAccountOrderRequest(new Request("http://localhost:6736/v1/ui/" + path, {
  method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
}));

it("persists independent orders while retaining backward-compatible bar fallback", async () => {
  fixture();
  expect(accountUiPreferences(loadConfig()).barAccountOrder).toEqual(["codex@work", "codex@personal"]);
  expect((await request("bar-account-order", { ids: ["codex@personal", "codex@work"] })).status).toBe(200);
  expect((await request("account-order", { ids: ["codex@work", "codex@personal", "cursor@default"] })).status).toBe(200);
  const preferences = accountUiPreferences(loadConfig());
  expect(preferences.accountOrder).toEqual(["codex@work", "codex@personal", "cursor@default"]);
  expect(preferences.barAccountOrder).toEqual(["codex@personal", "codex@work"]);
  expect((await request("bar-account-order", { ids: [] })).status).toBe(200);
  expect(accountUiPreferences(loadConfig()).barAccountOrder).toEqual([]);
});

it("bar-only hide leaves the quota card visible and restoring global visibility preserves bar choice", async () => {
  fixture();
  expect((await request("account-visibility", { id: "codex@work", barHidden: true })).status).toBe(200);
  expect(isCardVisibleOn(loadConfig(), "codex", "work")).toBe(true);
  expect(accountUiPreferences(loadConfig()).barHiddenAccounts).toEqual(["codex@work"]);
  setSurfaceVisibility("codex", "widget", false);
  expect(isCardVisibleOn(loadConfig(), "codex", "work")).toBe(false);
  expect((await request("account-visibility", { id: "codex@work", hidden: false })).status).toBe(200);
  expect(isCardVisibleOn(loadConfig(), "codex", "work")).toBe(true);
  expect(accountUiPreferences(loadConfig()).barHiddenAccounts).toEqual(["codex@work"]);
  setPreviewAccountVisibility("codex@work", true);
  expect(accountUiPreferences(loadConfig()).barHiddenAccounts).toEqual([]);
});

it("freezes the effective bar order on the first Quotas reorder", async () => {
  fixture();
  expect((await request("account-order", { ids: ["codex@personal", "codex@work"] })).status).toBe(200);
  expect(accountUiPreferences(loadConfig()).barAccountOrder).toEqual(["codex@work", "codex@personal"]);
  writeFileSync(process.env.TOKITOKI_CONFIG!, JSON.stringify({ ui: {} }));
  expect((await request("account-order", { ids: ["codex@personal", "codex@work"], barIds: ["codex@work", "codex@personal"] })).status).toBe(200);
  expect(accountUiPreferences(loadConfig()).barAccountOrder).toEqual(["codex@work", "codex@personal"]);
  expect((await request("account-order", { ids: ["codex@work", "codex@personal"], barIds: ["codex@personal"] })).status).toBe(200);
  expect(accountUiPreferences(loadConfig()).barAccountOrder).toEqual(["codex@work", "codex@personal"]);
});

it("rejects cross-origin and malformed mutations without touching preferences", async () => {
  fixture();
  const before = loadConfig();
  expect((await request("account-order", { ids: ["codex@personal"] }, "https://untrusted.example")).status).toBe(403);
  expect((await request("account-visibility", { id: "codex@work" })).status).toBe(400);
  expect((await request("bar-account-order", { ids: ["invalid"] })).status).toBe(400);
  expect(loadConfig()).toEqual(before);
});

it("reorders visible neighbours while preserving hidden and temporarily absent slots", () => {
  expect(moveAccountOrder({ saved: ["codex@a", "codex@hidden", "codex@absent", "codex@b"],
    accounts: ["codex@a", "codex@hidden", "codex@b", "cursor@new"], visible: ["codex@a", "codex@b"], id: "codex@b", direction: -1,
  })).toEqual(["codex@b", "codex@hidden", "codex@absent", "codex@a", "cursor@new"]);
});
