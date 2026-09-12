import { describe, expect, it } from "bun:test";

import { modelProvider } from "../src/model-provider.ts";

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
});
