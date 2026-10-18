import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";

import { vendorFor, vendorForProvider } from "../src/model-provider.ts";
import { PROVIDER_REGISTRY, providerInfo } from "../src/provider-registry.ts";
import { tagWidgetVendors } from "../src/widget-providers.ts";

describe("provider registry", () => {
  it("resolves vendors for direct, routed, and quota-only providers", () => {
    expect(vendorForProvider({ provider: "claude-code" })).toBe("anthropic");
    expect(vendorForProvider({ provider: "gemini-cli" })).toBe("google");
    expect(vendorForProvider({ provider: "zai" })).toBe("zhipu");
    expect(vendorForProvider({ provider: "kimi" })).toBe("moonshot");
    expect(vendorForProvider({ provider: "pi", accountKey: "openrouter" })).toBe("openrouter");
    expect(vendorForProvider({ provider: "pi", accountKey: "personal" })).toBe("pi");
    expect(vendorForProvider({ provider: "opencode", accountKey: "opencode-go" })).toBe("opencode");
    expect(vendorForProvider({ provider: "mystery-harness" })).toBe("mystery-harness");
  });

  it("falls back to a readable name for unknown ids", () => {
    expect(providerInfo("claude-code").displayName).toBe("Claude Code");
    expect(providerInfo("new-thing")).toEqual({ displayName: "New Thing", shortName: "New Thing", icon: "terminal" });
  });

  it("vendorFor agrees with every registry vendor", () => {
    for (const [id, info] of Object.entries(PROVIDER_REGISTRY)) {
      if (info.vendor === undefined) continue;
      expect(vendorFor({ harness: id }), id).toBe(info.vendor);
      expect(vendorForProvider({ provider: id, accountKey: "default" }), id).toBe(info.vendor);
    }
    expect(vendorFor({ harness: "zai", model: "glm-4.6" })).toBe("zhipu");
    expect(vendorFor({ harness: "opencode", model: "opencode-go/claude-sonnet-4" })).toBe("anthropic");
  });

  it("every vendor reference and logo asset exists", () => {
    for (const [id, info] of Object.entries(PROVIDER_REGISTRY)) {
      if (info.vendor !== undefined) expect(PROVIDER_REGISTRY[info.vendor]?.vendor).toBe(info.vendor);
      if (info.logo === undefined) continue;
      const asset = new URL(`../integrations/dms/tokitoki/assets/provider-logos/${info.logo}.svg`, import.meta.url);
      expect(existsSync(asset), `${id} logo ${info.logo}`).toBe(true);
    }
  });
});

describe("widget vendor tagging", () => {
  it("tags limits and today rows and collects the vendor set", () => {
    const tagged = tagWidgetVendors({
      limits: [
        { provider: "codex", accountKey: "openai:plus", windows: [] },
        { provider: "pi", accountKey: "openrouter", windows: [] },
      ],
      today: { rows: [{ bucket: "claude-code", costUsd: 1 }], total: { costUsd: 1 } },
    });
    expect(tagged.limits).toEqual([
      { provider: "codex", accountKey: "openai:plus", windows: [], vendor: "openai" },
      { provider: "pi", accountKey: "openrouter", windows: [], vendor: "openrouter" },
    ]);
    expect(tagged.today).toEqual({ rows: [{ bucket: "claude-code", costUsd: 1, vendor: "anthropic" }], total: { costUsd: 1 } });
    expect(tagged.vendors).toEqual(["anthropic", "openai", "openrouter"]);
  });

  it("passes unexpected section shapes through untouched", () => {
    expect(tagWidgetVendors({ limits: null, today: { error: "x" } })).toEqual({ limits: null, today: { error: "x" }, vendors: [] });
  });
});
