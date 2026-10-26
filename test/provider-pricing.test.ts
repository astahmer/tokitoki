import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeProvider } from "../src/providers/claude-code.ts";
import { piProvider } from "../src/providers/pi.ts";
import { commandcodeProvider } from "../src/providers/commandcode.ts";
import { opencodeProvider } from "../src/providers/opencode.ts";
import { grokProvider } from "../src/providers/grok.ts";
import { geminiCliProvider } from "../src/providers/gemini.ts";
import { cursorDashboardUsageEvents } from "../src/providers/cursor-dashboard.ts";
import { setTableForTests } from "../src/pricing.ts";
import type { EntryContext } from "../src/providers/types.ts";
import type { UsageEvent } from "../src/types.ts";

const context = (): EntryContext => ({ path: "/fixture/session.jsonl", state: {}, freshFile: true, machineId: "test" });
const price = { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 3 };
const dirs: string[] = [];
function dir(): string { const d = mkdtempSync(join(tmpdir(), "tk-provider-pricing-")); dirs.push(d); return d; }
afterEach(() => { setTableForTests(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const reportedAdapters: Record<string, (model: string, reported?: unknown) => UsageEvent> = {
  claude: (model, costUSD) => claudeCodeProvider.parseLine(JSON.stringify({ type: "assistant", costUSD,
    message: { id: "msg", model, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 } },
  }), context())[0]!,
  pi: (model, total) => piProvider.parseLine(JSON.stringify({ type: "message", id: "msg",
    message: { model, usage: { input: 100, output: 10, cacheRead: 800, cacheWrite: 200, cost: { total } } },
  }), context())[0]!,
  commandcode: (model, costUsd) => commandcodeProvider.parseLine(JSON.stringify({ type: "message", id: "msg", model,
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 200, costUsd },
  }), context())[0]!,
  opencode: (modelID, cost) => {
    const file = join(dir(), "store.db"); const db = new Database(file);
    db.exec(`CREATE TABLE session (id TEXT, directory TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('s', '/fixture');`);
    db.query("INSERT INTO message VALUES ('m', 's', 1000, 2000, ?)").run(JSON.stringify({
      role: "assistant", modelID, cost, tokens: { input: 100, output: 10, cache: { read: 800, write: 200 } }, time: { completed: 2000 },
    })); db.close();
    return opencodeProvider.scanDb!(file, { state: {}, freshFile: true, machineId: "test" })[0]!;
  },
  cursorDashboard: (model, dollars) => cursorDashboardUsageEvents({ machineId: "test", body: { usageEventsDisplay: [{
    model, timestamp: "1761000000000", tokenUsage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 200,
      totalCents: typeof dollars === "number" ? dollars * 100 : dollars },
  }] } })[0]!,
};

for (const [name, parse] of Object.entries(reportedAdapters)) describe(`${name} cost provenance`, () => {
  it("preserves reported zero on an unknown model and leaves missing cost unpriced", () => {
    setTableForTests({});
    expect(parse("unlisted-model", 0)).toMatchObject({ costUsd: 0, costSource: "reported" });
    const unknown = parse("unlisted-model");
    expect(unknown.costUsd).toBeUndefined();
    expect(unknown.costSource).toBe("unpriced");
    expect(parse("unlisted-model", -1).costSource).toBe("unpriced");
  });
  it("estimates separate cache buckets without subtracting them again", () => {
    setTableForTests({ "fixture-model": price });
    const event = parse("fixture-model", -1);
    expect(event.costSource).toBe("estimated");
    expect(event.inputTokens).toBe(100);
    expect(event.costUsd).toBeCloseTo(0.00128, 10);
  });
});

it("marks unknown Grok and Gemini usage unpriced", () => {
  setTableForTests({});
  const grok = grokProvider.parseLine(JSON.stringify({ model: "unlisted-model", usage: { input_tokens: 100, output_tokens: 10 } }), context())[0]!;
  expect(grok.costSource).toBe("unpriced"); expect(grok.costUsd).toBeUndefined();
  const file = join(dir(), "session.json");
  writeFileSync(file, JSON.stringify({ messages: [{ model: "unlisted-model", tokens: { input: 100, output: 10 } }] }));
  const gemini = geminiCliProvider.parseLine("{}", { ...context(), path: file })[0]!;
  expect(gemini.costSource).toBe("unpriced"); expect(gemini.costUsd).toBeUndefined();
});
