import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import vm from "node:vm";

const model = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL("../integrations/kde-plasma/tokitoki/package/contents/ui/QuotaModel.js", import.meta.url), "utf8"), model);
const now = Date.parse("2026-10-24T12:00:00Z");
const window = (minutes: number, used: number, extra = {}) => ({ source: "provider", windowMinutes: minutes, usedPercent: used, resetsAt: "2026-10-25T12:00:00Z", ...extra });
const accounts = [
  { id: "codex@evvi", harness: "codex", vendor: "openai", vendorName: "OpenAI", accountKey: "evvi", label: "Evvi", windows: [window(10080, 80), window(300, 20)] },
  { id: "codex@work", harness: "codex", vendor: "openai", vendorName: "OpenAI", accountKey: "work", label: "Work", windows: [window(300, 50)] },
  { id: "cursor@personal", harness: "cursor", vendor: "cursor", vendorName: "Cursor", accountKey: "personal", windows: [window(43200, 63)] },
];

describe("native quota adapters", () => {
  test("shortest mode keeps every selected account and chooses duration, not remaining percentage", () => {
    const selected = model.accounts({ accounts }, "codex@evvi,codex@work,cursor@personal", false);
    expect(model.bar(selected, "shortest", {}, now)).toBe("OpenAI EV: 5h 80%  │  OpenAI WO: 5h 50%  │  Cursor 1mo 37%");
    expect(model.tooltip(selected, now)).toContain("7d 20%");
  });
  test("expired, stale and unknown observations never become full capacity", () => {
    for (const status of ["expired", "stale", "unknown"]) {
      expect(model.remaining(window(300, 0, { status }), now)).toBeNull();
      expect(model.value(window(300, 0, { status }), now)).toBe(status);
    }
    expect(model.value(window(300, 0, { resetsAt: "2026-10-23T00:00:00Z" }), now)).toBe("expired");
    expect(model.value({ source: "provider" }, now)).toBe("unknown");
    expect(model.label({ label: "Cursor Models" })).toBe("?");
  });
  test("local budgets and on-demand amounts cannot masquerade as quota capacity", () => {
    expect(model.remaining(window(300, 25, { source: "derived" }), now)).toBeNull();
    expect(model.windows({ windows: [window(300, 25, { source: "derived" })] }, false, now)).toHaveLength(0);
    expect(model.value(window(43200, 100, { amountUsd: 2.5 }), now)).toBe("$2.50");
    expect(model.remaining(window(43200, 100, { amountUsd: 2.5 }), now)).toBeNull();
  });
  test("local selection, shared account visibility and privacy apply together", () => {
    const rows = model.accounts({ accounts }, "", false, { menubarHidden: ["codex:work"], privacyHideIdentities: true });
    expect(rows.map((a: { id: string }) => a.id)).toEqual(["codex@evvi", "cursor@personal"]);
    expect(rows[0].name).toBe("OpenAI");
    expect(model.accounts({ accounts }, "codex@work", false, { previewHidden: ["openai"] })).toHaveLength(0);
  });
});
