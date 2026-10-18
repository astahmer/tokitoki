import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

import { PROVIDER_REGISTRY } from "../src/provider-registry.ts";

const widget = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiWidget.qml", import.meta.url), "utf8");
const functions = (source: string) => [...source.matchAll(/^    function [\s\S]*?^    }/gm)].map((match) => match[0]).join("\n");

const makeWidget = (payload: Record<string, unknown>) => {
  const context = createContext({
    payload: { schema: 1, app: "tokitoki", providerRegistry: JSON.parse(JSON.stringify(PROVIDER_REGISTRY)), ...payload },
    hasPayload: true,
    hasLimits: Array.isArray(payload.limits),
    searchText: "",
    privacyHideIdentities: false,
    providerVisibility: "all",
    selectedProviders: "",
    Theme: { warning: "orange", error: "red", success: "green", primary: "pink" },
  });
  context.root = context;
  runInContext(functions(widget), context);
  return context;
};

describe("DMS widget provider registry lookups", () => {
  it("names, icons, and labels come from the payload registry with a raw-id fallback", () => {
    const ui = makeWidget({});
    expect(ui.providerName("gemini-cli")).toBe("Gemini CLI");
    expect(ui.providerName("brand-new")).toBe("brand-new");
    expect(ui.harnessIcon("cursor")).toBe("mouse");
    expect(ui.harnessIcon("brand-new")).toBe("terminal");
    expect(ui.providerShortName("anthropic")).toBe("Claude");
    expect(ui.providerShortName("brand-new")).toBe("Brand-new");
  });

  it("groups the bar strip by payload vendor instead of account-key guesses", () => {
    const ui = makeWidget({
      limits: [
        { provider: "claude-code", accountKey: "default", vendor: "anthropic", windows: [{ kind: "day", usedPct: 40, windowMinutes: 300 }] },
        { provider: "pi", accountKey: "work-gateway", vendor: "openrouter", windows: [] },
      ],
      today: { rows: [{ bucket: "pi", vendor: "openrouter", inputTokens: 50, costUsd: 1 }] },
    });
    const groups = ui.buildStatusStripGroups();
    expect(groups.map((group: { provider: string; label: string }) => [group.provider, group.label])).toEqual([
      ["anthropic", "Claude"],
      ["openrouter", "OpenRouter"],
    ]);
    expect(groups[1].lines[0]).toBe("50 · $1.00");
  });

  it("honors legacy upstream aliases in saved strip and selection settings", () => {
    const ui = makeWidget({ uiPreview: { previewHidden: ["claude"] } });
    expect(ui.providerIsVisible("claude-code", "default", "anthropic")).toBe(false);
    expect(ui.providerIsVisible("codex", "openai:plus", "openai")).toBe(true);
    ui.payload.uiPreview = {};
    ui.providerVisibility = "selected";
    ui.selectedProviders = "gemini";
    expect(ui.providerIsVisible("gemini-cli", "default", "google")).toBe(true);
    expect(ui.providerIsVisible("codex", "openai:plus", "openai")).toBe(false);
  });

  it("surfaces degraded vendors worst-first for the badge, bar indicator, and attention list", () => {
    const ui = makeWidget({
      statusIncidents: {
        openai: { indicator: "none", description: "All Systems Operational", url: "https://status.openai.com" },
        google: { indicator: "minor", description: "Slow responses", url: "g" },
        anthropic: { indicator: "major", description: "Elevated errors", url: "a" },
      },
    });
    expect(ui.degradedVendors()).toEqual(["anthropic", "google"]);
    expect(ui.vendorIncident("openai")).toBeNull();
    expect(ui.incidentColor(ui.vendorIncident("anthropic"))).toBe("red");
    expect(ui.incidentColor(ui.vendorIncident("google"))).toBe("orange");
    expect(ui.buildAttentionItems()[0]).toEqual({ title: "Claude status: major", detail: "Elevated errors" });
  });

  it("formats prepaid balances", () => {
    const ui = makeWidget({});
    expect(ui.balanceLabel({ currency: "USD", remaining: 12.5, paid: 10, granted: 2.5 })).toBe("Balance $12.50 (paid $10.00, granted $2.50)");
    expect(ui.balanceLabel({ currency: "CNY", remaining: 3, available: false })).toBe("Balance 3.00 CNY · unavailable for API calls");
    expect(ui.balanceLabel(undefined)).toBe("");
  });
});
