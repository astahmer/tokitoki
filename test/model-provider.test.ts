import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { modelProvider, vendorFor } from "../src/model-provider.ts";

describe("modelProvider", () => {
  it("prefers explicit routing prefixes over the harness", () => {
    expect(modelProvider("openrouter/anthropic/claude-sonnet-4", "pi")).toBe("openrouter");
    expect(modelProvider("opencode-go/mini", "pi")).toBe("opencode");
  });

  it("uses account identity when a gateway is not encoded in the model", () => {
    expect(modelProvider("custom-model", "pi", "openrouter:work")).toBe("openrouter");
    expect(modelProvider("custom-model", "pi", "opencode-go")).toBe("opencode");
    expect(modelProvider("custom-model", "codex", "openai:plus")).toBe("openai");
    expect(modelProvider("custom-model", "t3code", "openai-acc-1")).toBe("openai");
    expect(modelProvider("custom-model", "codex", "opencode-go-api-key-1")).toBe("opencode");
  });

  it("recognizes common model families and keeps unknown values honest", () => {
    expect(modelProvider("claude-sonnet-4")).toBe("anthropic");
    expect(modelProvider("gemini-2.5-pro")).toBe("google");
    expect(modelProvider("grok-4")).toBe("xai");
    expect(modelProvider("mystery-model")).toBe("other");
  });

  it("routes custom account and model-prefix names through configured aliases", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-aliases-"));
    const configFile = path.join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ accountAliases: { "Work-Gateway": "openai", "lab-proxy": "anthropic" } }));
    const previous = process.env.TOKITOKI_CONFIG;
    process.env.TOKITOKI_CONFIG = configFile;
    try {
      expect(modelProvider("work-gateway/mystery", "pi")).toBe("openai");
      expect(modelProvider("mystery", "pi", "lab-proxy")).toBe("anthropic");
      expect(modelProvider("mystery", "pi", "unlisted")).toBe("other");
      expect(modelProvider("codex-team/gpt-5", "pi")).toBe("openai");
    } finally {
      if (previous === undefined) delete process.env.TOKITOKI_CONFIG;
      else process.env.TOKITOKI_CONFIG = previous;
    }
  });
});

describe("vendorFor", () => {
  it("maps direct harnesses to their own vendor", () => {
    expect(vendorFor({ harness: "claude-code", model: "claude-opus-4" })).toBe("anthropic");
    expect(vendorFor({ harness: "codex", model: "anything" })).toBe("openai");
    expect(vendorFor({ harness: "gemini-cli" })).toBe("google");
    expect(vendorFor({ harness: "copilot", accountKey: "default" })).toBe("github");
  });

  it("lets an explicit gateway or vendor model prefix outrank a direct harness", () => {
    expect(vendorFor({ harness: "codex", model: "opencode-go/deepseek-v4.1-flash", accountKey: "codex" })).toBe("deepseek");
    expect(vendorFor({ harness: "codex", model: "opencode-go/mimo-v2.6-flash" })).toBe("opencode");
    expect(vendorFor({ harness: "codex", model: "gpt-5.6-sol" })).toBe("openai");
  });

  it("uses the model's vendor for routed harnesses, through gateway prefixes", () => {
    expect(vendorFor({ harness: "pi", model: "openrouter/anthropic/claude-sonnet-4", accountKey: "openrouter" })).toBe("anthropic");
    expect(vendorFor({ harness: "opencode", model: "opencode-go/kimi-k2", accountKey: "opencode-go" })).toBe("moonshot");
    expect(vendorFor({ harness: "t3code", model: "gpt-5-codex", accountKey: "codex" })).toBe("openai");
    expect(vendorFor({ harness: "pi", model: "x-ai/some-model" })).toBe("xai");
  });

  it("falls back to the routing account, then the backend name, then other", () => {
    expect(vendorFor({ harness: "pi", model: "ox-alpha-free", accountKey: "opencode-go" })).toBe("opencode");
    expect(vendorFor({ harness: "t3code", accountKey: "claudeAgent" })).toBe("anthropic");
    expect(vendorFor({ harness: "t3code", accountKey: "cursor" })).toBe("cursor");
    expect(vendorFor({ harness: "pi", model: "mystery", accountKey: "default" })).toBe("other");
  });
});
