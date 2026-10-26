import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { workspaceCreditsLabel } from "../web/src/lib/workspace-credits.ts";

it("web and QML show workspace credits independently of money and reset inventory", () => {
  const qml = readFileSync(new URL("../integrations/dms/tokitoki/TokitokiWidget.qml", import.meta.url), "utf8");
  const body = qml.match(/function workspaceCreditsLabel\(credits\) \{([\s\S]*?)\n    \}/)![1]!;
  const qmlLabel = new Function("credits", body);
  const cases = [
    [undefined, ""],
    [{ hasCredits: false, unlimited: false }, ""],
    [{ hasCredits: false, unlimited: false, balance: null }, ""],
    [{ hasCredits: false, unlimited: false, balance: "0" }, "Workspace credits 0"],
    [{ hasCredits: true, unlimited: false, balance: "123.45" }, "Workspace credits 123.45"],
    [{ hasCredits: true, unlimited: true, balance: "123.45" }, "Unlimited workspace credits"],
  ] as const;
  for (const [credits, label] of cases) {
    expect(workspaceCreditsLabel(credits)).toBe(label);
    expect(qmlLabel(credits)).toBe(label);
  }
  const fixture = JSON.parse(readFileSync(new URL("../e2e/fixtures/payload.json", import.meta.url), "utf8"));
  const personal = fixture.limits.find((account: { accountKey: string }) => account.accountKey === "openai:personal");
  expect(workspaceCreditsLabel(personal.credits)).toBe("Workspace credits 123.45");
  expect(personal.bankedResets).toBe(2);
});
