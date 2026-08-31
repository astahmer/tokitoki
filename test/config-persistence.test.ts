import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import TOML from "@iarna/toml";

const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
const configs: string[] = [];

function run(args: string[], configPath: string): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", cli, ...args], {
    env: { ...process.env, TOKITOKI_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

afterEach(() => {
  for (const file of configs.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

describe("menubar config persistence", () => {
  it("preserves preview, card visibility, tab order, sync, and account order across writes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-config-e2e-"));
    const configPath = path.join(dir, "config.json");
    configs.push(configPath);

    expect(run(["config", "set", "ui.previewHidden", '["claude","openrouter"]'], configPath).status).toBe(0);
    expect(run(["ui", "--hide", "codex:openai:plus"], configPath).status).toBe(0);
    expect(run(["ui", "--account-order", "codex@openai:plus,pi@opencode-go"], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.stripMetric", '"smart"'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.stripExhausted", '"hide"'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.menubarPreviewEnabled", "false"], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchEnabled", "true"], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchHidden", '["claude"]'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchMetric", '"smart"'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchWindow", '"week"'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchMode", '"runway"'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchSyncPreview", "true"], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.sideNotchPlacement", '"top-left"'], configPath).status).toBe(0);
    expect(run(["config", "set", "poll.adaptive", "true"], configPath).status).toBe(0);
    expect(run(["config", "set", "notifications.enabled", "false"], configPath).status).toBe(0);
    expect(run(["config", "set", "notifications.resetAware", "true"], configPath).status).toBe(0);
    expect(run(["config", "set", "notifications.burnWarningRatio", "0.9"], configPath).status).toBe(0);
    expect(run(["config", "set", "privacy.hideIdentities", "true"], configPath).status).toBe(0);
    expect(run(["ui", "--tabs", "tokens,overview,quotas,reports,mcp,sources,settings"], configPath).status).toBe(0);
    expect(run(["config", "set", "sync.backend", '"dir"'], configPath).status).toBe(0);

    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      ui?: {
        previewHidden?: string[];
        stripMetric?: string;
        stripExhausted?: string;
        menubarPreviewEnabled?: boolean;
        sideNotchEnabled?: boolean;
        sideNotchHidden?: string[];
        sideNotchMetric?: string;
        sideNotchWindow?: string;
        sideNotchMode?: string;
        sideNotchSyncPreview?: boolean;
        sideNotchPlacement?: string;
        menubarAccountOrder?: string[];
        hidden?: { menubar?: string[] };
        menubarTabs?: string[];
      };
      sync?: { backend?: string };
      poll?: { adaptive?: boolean };
      notifications?: { enabled?: boolean; resetAware?: boolean; burnWarningRatio?: number };
      privacy?: { hideIdentities?: boolean };
    };
    expect(cfg.ui?.previewHidden).toEqual(["claude", "openrouter"]);
    expect(cfg.ui?.stripMetric).toBe("smart");
    expect(cfg.ui?.stripExhausted).toBe("hide");
    expect(cfg.ui?.menubarPreviewEnabled).toBe(false);
    expect(cfg.ui?.sideNotchEnabled).toBe(true);
    expect(cfg.ui?.sideNotchHidden).toEqual(["claude"]);
    expect(cfg.ui?.sideNotchMetric).toBe("smart");
    expect(cfg.ui?.sideNotchWindow).toBe("week");
    expect(cfg.ui?.sideNotchMode).toBe("runway");
    expect(cfg.ui?.sideNotchSyncPreview).toBe(true);
    expect(cfg.ui?.sideNotchPlacement).toBe("top-left");
    expect(cfg.ui?.menubarAccountOrder).toEqual(["codex@openai:plus", "pi@opencode-go"]);
    expect(cfg.ui?.hidden?.menubar).toEqual(["codex:openai:plus"]);
    expect(cfg.ui?.menubarTabs).toEqual(["tokens", "overview", "quotas", "reports", "mcp", "sources", "settings"]);
    expect(cfg.sync?.backend).toBe("dir");
    expect(cfg.poll?.adaptive).toBe(true);
    expect(cfg.notifications?.enabled).toBe(false);
    expect(cfg.notifications?.resetAware).toBe(true);
    expect(cfg.notifications?.burnWarningRatio).toBe(0.9);
    expect(cfg.privacy?.hideIdentities).toBe(true);
  });

  it("rejects a foreign config section without touching the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-config-e2e-"));
    const configPath = path.join(dir, "config.json");
    configs.push(configPath);
    fs.writeFileSync(configPath, '{"ui":{"previewHidden":["claude"]}}\n');

    const result = run(["config", "set", "secrets.token", '"nope"'], configPath);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ ui: { previewHidden: ["claude"] } });
  });

  it("keeps TOML configs writable when they are the configured source of truth", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-config-toml-"));
    const configPath = path.join(dir, "config.toml");
    configs.push(configPath);

    expect(run(["config", "set", "ui.stripMetric", '"smart"'], configPath).status).toBe(0);
    expect(run(["ui", "--hide", "codex:work"], configPath).status).toBe(0);

    const parsed = TOML.parse(fs.readFileSync(configPath, "utf8")) as {
      ui?: { stripMetric?: string; hidden?: { menubar?: string[] } };
    };
    expect(parsed.ui?.stripMetric).toBe("smart");
    expect(parsed.ui?.hidden?.menubar).toEqual(["codex:work"]);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("{\n");
  });
});
