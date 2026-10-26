import { expect, it, afterEach, spyOn } from "bun:test";
import { accountUiPreferences, normalizeHiddenAccounts, projectAccountUiConfig, readAccountUiPreferences, setSurfaceVisibility, setPreviewAccountVisibility } from "../src/uiToggles.ts";
import { EventCache } from "../src/cache.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TokitokiConfig } from "../src/config.ts";

const aliases = new Map([
  ["codex@codex:work", "codex@openai:work-id"],
  ["codex@old-work", "codex@openai:work-id"],
  ["codex@codex:personal", "codex@openai:personal-id"],
]);

it("projects independent native orders and visibility without mutating persisted settings", () => {
  const config: TokitokiConfig = { ui: {
    menubarAccountOrder: ["codex@codex:work", "cursor@default", "codex@openai:work-id", "codex@missing"],
    previewAccountOrder: ["codex@codex:personal", "codex@old-work"],
    previewHiddenAccounts: ["codex@codex:work"],
    hidden: { widget: ["codex:codex:work", "claude-code", "codex:missing"], dashboard: ["codex:codex:personal"] },
    previewHidden: ["openai"],
  } };
  const before = structuredClone(config);
  expect(accountUiPreferences(config, aliases)).toEqual({
    accountOrder: ["codex@openai:work-id", "cursor@default", "codex@missing"],
    barAccountOrder: ["codex@openai:personal-id", "codex@openai:work-id"],
    barHiddenAccounts: ["codex@openai:work-id"],
    menubarHidden: ["codex:openai:work-id", "claude-code", "codex:missing"],
    previewHidden: ["openai"],
  });
  expect(config).toEqual(before);
  const projected = projectAccountUiConfig(config, aliases);
  expect(projected.ui?.hidden?.dashboard).toEqual(["codex:openai:personal-id"]);
  expect(config).toEqual(before);
});

it("keeps explicit empty bar order and falls back only when absent", () => {
  const config: TokitokiConfig = { ui: { menubarAccountOrder: ["codex@codex:work"] } };
  expect(accountUiPreferences(config, aliases).barAccountOrder).toEqual(["codex@openai:work-id"]);
  config.ui!.previewAccountOrder = [];
  expect(accountUiPreferences(config, aliases).barAccountOrder).toEqual([]);
  expect(projectAccountUiConfig(config, aliases).ui?.previewAccountOrder).toEqual([]);
});

it("remaps hidden suffixes only when proven aliases have one destination", () => {
  const ambiguous = new Map([...aliases, ["codex@other:work", "codex@openai:other-id"]]);
  expect(normalizeHiddenAccounts(["codex:work", "codex:codex:work", "codex", "openai", "codex@codex:personal"], ambiguous))
    .toEqual(["codex:work", "codex:openai:work-id", "codex", "openai", "codex:openai:personal-id"]);
  expect(normalizeHiddenAccounts(["codex:work", "codex:old-work"], aliases)).toEqual(["codex:openai:work-id"]);
  expect(normalizeHiddenAccounts(["other:person@example.com"], aliases)).toEqual(["other:person@example.com"]);
});

const envBefore = { config: process.env.TOKITOKI_CONFIG, data: process.env.TOKITOKI_DATA_DIR };
const testFolders: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  if (envBefore.config === undefined) delete process.env.TOKITOKI_CONFIG;
  else process.env.TOKITOKI_CONFIG = envBefore.config;
  if (envBefore.data === undefined) delete process.env.TOKITOKI_DATA_DIR;
  else process.env.TOKITOKI_DATA_DIR = envBefore.data;
  for (const dir of testFolders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("read-projects then restores canonical cards and bar choices without re-hiding on reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokitoki-native-pref-"));
  testFolders.push(dir);
  process.env.TOKITOKI_DATA_DIR = dir;
  process.env.TOKITOKI_CONFIG = join(dir, "config.json");
  const saved = { ui: {
    hidden: { widget: ["codex:codex:work", "cursor"], dashboard: ["claude-code"] },
    previewHiddenAccounts: ["codex@codex:work", "cursor@default"],
    menubarAccountOrder: ["codex@codex:work", "codex@absent"],
    previewAccountOrder: ["codex@absent", "codex@codex:work"],
    stripMetric: "tokens", previewHidden: ["google"],
  }, privacy: { hideIdentities: true } };
  writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify(saved));
  mocks.push(spyOn(EventCache.prototype, "nativeAccountAliases").mockReturnValue(aliases));
  const original = readFileSync(process.env.TOKITOKI_CONFIG, "utf8");
  expect(readAccountUiPreferences().menubarHidden).toEqual(["codex:openai:work-id", "cursor"]);
  expect(readFileSync(process.env.TOKITOKI_CONFIG, "utf8")).toBe(original);
  setSurfaceVisibility("codex:openai:work-id", "widget", true);
  setPreviewAccountVisibility("codex@openai:work-id", true);
  const reloaded = readAccountUiPreferences();
  expect(reloaded.menubarHidden).toEqual(["cursor"]);
  expect(reloaded.barHiddenAccounts).toEqual(["cursor@default"]);
  expect(reloaded.accountOrder).toEqual(["codex@openai:work-id", "codex@absent"]);
  expect(reloaded.barAccountOrder).toEqual(["codex@absent", "codex@openai:work-id"]);
  const config = JSON.parse(readFileSync(process.env.TOKITOKI_CONFIG, "utf8"));
  expect(config.ui.hidden.dashboard).toEqual(["claude-code"]);
  expect(config.ui.stripMetric).toBe("tokens");
  expect(config.ui.previewHidden).toEqual(["google"]);
  expect(config.privacy).toEqual(saved.privacy);
});

it("local and web HTTP surfaces expose the same projected preferences without config writes", async () => {
  // Match the existing HTTP tests' initialization order for the CLI/report import cycle.
  await import("../src/limits-document.ts");
  const { handleLocalApiRequest } = await import("../src/serve.ts");
  const { startWebServer } = await import("../src/web/server.ts");
  const dir = mkdtempSync(join(tmpdir(), "tokitoki-native-http-pref-"));
  testFolders.push(dir);
  process.env.TOKITOKI_DATA_DIR = dir;
  process.env.TOKITOKI_CONFIG = join(dir, "config.json");
  const saved: TokitokiConfig = { ui: {
    menubarAccountOrder: ["codex@codex:work", "cursor@missing"],
    previewAccountOrder: [], previewHiddenAccounts: ["codex@old-work"],
    hidden: { widget: ["codex:codex:work", "claude-code"] },
  } };
  writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify(saved));
  const before = readFileSync(process.env.TOKITOKI_CONFIG, "utf8");
  mocks.push(spyOn(EventCache.prototype, "nativeAccountAliases").mockReturnValue(aliases));
  const expected = accountUiPreferences(saved, aliases);
  const web = startWebServer({ port: 0, staticRoot: dir });
  try {
    for (const route of ["/v1/status", "/v1/limits"]) {
      const response = await handleLocalApiRequest(new Request("http://localhost:6736" + route), { loopbackOnly: true, appVersion: "test" });
      expect(response.status).toBe(200);
      const body = await response.json() as { uiPreview: Record<string, unknown> };
      for (const [key, value] of Object.entries(expected)) expect(body.uiPreview[key]).toEqual(value);
    }
    for (const route of ["/v1/status", "/v1/limits", "/api/limits"]) {
      const response = await fetch(`http://localhost:${web.port}${route}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { uiPreview: Record<string, unknown> };
      for (const [key, value] of Object.entries(expected)) expect(body.uiPreview[key]).toEqual(value);
    }
    expect(readFileSync(process.env.TOKITOKI_CONFIG, "utf8")).toBe(before);
  } finally { web.stop(true); }
});
