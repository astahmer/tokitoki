import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  it("preserves preview, card visibility, and account order across writes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-config-e2e-"));
    const configPath = path.join(dir, "config.json");
    configs.push(configPath);

    expect(run(["config", "set", "ui.previewHidden", '["claude","openrouter"]'], configPath).status).toBe(0);
    expect(run(["ui", "--hide", "codex:openai:plus"], configPath).status).toBe(0);
    expect(run(["ui", "--account-order", "codex@openai:plus,pi@opencode-go"], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.stripMetric", '"tokens"'], configPath).status).toBe(0);
    expect(run(["config", "set", "ui.stripExhausted", '"hide"'], configPath).status).toBe(0);

    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      ui?: {
        previewHidden?: string[];
        stripMetric?: string;
        stripExhausted?: string;
        menubarAccountOrder?: string[];
        hidden?: { menubar?: string[] };
      };
    };
    expect(cfg.ui?.previewHidden).toEqual(["claude", "openrouter"]);
    expect(cfg.ui?.stripMetric).toBe("tokens");
    expect(cfg.ui?.stripExhausted).toBe("hide");
    expect(cfg.ui?.menubarAccountOrder).toEqual(["codex@openai:plus", "pi@opencode-go"]);
    expect(cfg.ui?.hidden?.menubar).toEqual(["codex:openai:plus"]);
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
});
