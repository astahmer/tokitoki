import { describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TokitokiMcpServer } from "../src/mcp-server.ts";
import type { UsageEvent } from "../src/types.ts";

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "tk-mcp-"));
process.env.TOKITOKI_DATA_DIR = DATA_DIR;
// Isolate from the real user config and real harness stores. Without explicit
// provider roots, scan_now would walk the developer's multi-GB live Codex
// history and turn a deterministic fixture test into a minute-long scan.
const SOURCE_DIR = path.join(DATA_DIR, "sources");
mkdirSync(SOURCE_DIR);
process.env.TOKITOKI_CONFIG = path.join(DATA_DIR, "config.json");
writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({
  providers: Object.fromEntries([
    "claude-code", "pi", "codex", "opencode", "commandcode", "t3-code",
    "antigravity-cli", "cursor", "grok", "gemini-cli",
  ].map((id) => [id, { paths: [SOURCE_DIR] }])),
}));

// Rolling windows resolve against "now", so fixtures must be relative too.
const NOW_ISO = () => new Date().toISOString();

function makeEvent(overrides: Partial<UsageEvent> & Pick<UsageEvent, "id">): UsageEvent {
  return {
    ts: NOW_ISO(),
    machineId: "mcp-test-mac",
    provider: "pi",
    accountKey: "test-account",
    model: "ox-alpha-free",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.01,
    projectDir: "/Users/me/dev/proj",
    sessionId: "sess-1",
    ...overrides,
  };
}

// Fixture: seed the JSONL event log; the server's own cache.sync() projects
// it into sqlite on first tool call (mirrors the real flow — seeding the DB
// directly instead would be wiped by sync()'s log-vs-count reconciliation).
const LOG_LINES: string[] = [
  JSON.stringify(makeEvent({ id: "e1" })),
  JSON.stringify(makeEvent({ id: "e2", sessionId: "sess-2", costUsd: 0.25, inputTokens: 5000 })),
  JSON.stringify(makeEvent({ id: "e3", tool: "mcp__pencil__execute", sessionId: "sess-1" })),
  JSON.stringify(makeEvent({ id: "e4", provider: "codex", accountKey: "plus" })),
  // Multi-day spread so usage_chart has a real series to return.
  JSON.stringify(makeEvent({ id: "d1", ts: new Date(Date.now() - 3 * 86_400_000).toISOString(), sessionId: "sess-old" })),
  JSON.stringify(makeEvent({ id: "d2", ts: new Date(Date.now() - 1 * 86_400_000).toISOString(), costUsd: 0.5, inputTokens: 42_000, sessionId: "sess-old" })),
];
appendFileSync(path.join(DATA_DIR, "events.jsonl"), LOG_LINES.join("\n") + "\n");

const server = new TokitokiMcpServer();
const client = new Client({ name: "test-client", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

let ready: Promise<unknown>;
async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

// The SDK's result content is a wide discriminated union; tests only read
// text blocks, so accept the raw result and pull the first block's text.
function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ text?: string }> }).content;
  return (content?.[0] as { text?: string } | undefined)?.text ?? "";
}

afterAll(async () => {
  await client.close();
  await server.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("tokitoki MCP server", () => {
  it("exposes all 14 tools over the wire", async () => {
    ready = Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)]);
    await ready;
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "anomalies",
      "budgets_status",
      "export_report",
      "quota_snapshot",
      "repo_efficiency",
      "scan_now",
      "search_sessions",
      "session_detail",
      "sessions_top",
      "sources",
      "tool_spend",
      "usage_chart",
      "usage_report",
      "usage_totals",
    ]);
    expect(tools.length).toBe(14);
  });

  it("usage_report returns window rows + totals as JSON", async () => {
    const res = await call("usage_report", { last: "week", dimension: "provider" });
    expect(res.isError).toBeUndefined();
    const payload = JSON.parse(textOf(res));
    expect(payload.window.since).toBeDefined();
    expect(payload.dimension).toBe("provider");
    const pi = payload.rows.find((r: { bucket: string }) => r.bucket === "pi");
    expect(pi.requests).toBeGreaterThanOrEqual(3);
    expect(payload.totals.costUsd).toBeGreaterThan(0);
  });

  it("usage_report honors --from/--to style bounds and provider filter", async () => {
    const res = await call("usage_report", { from: "2026-08-01", to: "2026-09-01", provider: "codex" });
    const payload = JSON.parse(textOf(res));
    expect(payload.rows.every((r: { bucket: string }) => r.bucket === "codex")).toBe(true);
  });

  it("budgets_status returns the menubar contract shape (no budgets configured)", async () => {
    const res = await call("budgets_status", {});
    const payload = JSON.parse(textOf(res));
    // test env has no config file with [budgets] — either shape is valid, but
    // gauges must always be a list
    if (payload.configured === false) {
      expect(payload.gauges).toEqual([]);
    } else {
      for (const g of payload.gauges) {
        expect(typeof g.scope).toBe("string");
        expect(typeof g.ratio).toBe("number");
      }
    }
  });

  it("sessions_top finds fixture sessions; unknown session_detail is an isError", async () => {
    const top = await call("sessions_top", { last: "month" });
    const topPayload = JSON.parse(textOf(top));
    expect(topPayload.rows.length).toBeGreaterThan(0);

    const bad = await call("session_detail", { session_id: "does-not-exist" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("no session 'does-not-exist'");
  });

  it("tool_spend rolls mcp__ tools up to mcp:<server>", async () => {
    const res = await call("tool_spend", { last: "month" });
    const payload = JSON.parse(textOf(res));
    const buckets = payload.rows.map((r: { bucket: string }) => r.bucket);
    expect(buckets).toContain("pi/mcp:pencil"); // provider-qualified rollup
  });

  it("export_report markdown contains a table header", async () => {
    const res = await call("export_report", { format: "markdown", last: "week" });
    const md = textOf(res);
    expect(md).toContain("| bucket |");
    expect(md).toContain("|---|");
  });

  it("invalid window args surface as isError, not thrown rejections", async () => {
    const res = await call("usage_report", { last: "bogus" });
    expect(res.isError).toBe(true);
  });

  it("scan_now runs and returns per-provider counts", async () => {
    const res = await call("scan_now", {});
    const payload = JSON.parse(textOf(res));
    expect(Array.isArray(payload.scanned)).toBe(true);
    expect(payload.scanned.every((s: { provider: string; eventsEmitted: number }) => typeof s.provider === "string")).toBe(true);
  }, 60_000);

  describe("search_sessions", () => {
    // Index a fixture session body directly through the same insert path
    // updateSessionIndex uses — no real harness stores needed.
    const db = () => (server as unknown as { getCache(): { database: { exec: (sql: string) => void; prepare: (sql: string) => { run: (...args: unknown[]) => void } } } }).getCache();

    it("finds sessions by body text with a snippet", async () => {
      const cache = db();
      cache.database.exec(
        `INSERT INTO sessions_fts (session_id, provider, account_key, started_at, title, body, file)
         VALUES ('sess-fts', 'pi', 'test-account', '${new Date().toISOString()}',
                 'Postgres deadlock hunt', 'debugging the postgres deadlock in the payment worker retry loop', '/tmp/fixture.jsonl')`,
      );
      // ensureSessionFts is idempotent and keeps existing rows.
      const res = await call("search_sessions", { query: "postgres deadlock" });
      expect(res.isError).toBeUndefined();
      const payload = JSON.parse(textOf(res));
      expect(payload.matches).toBeGreaterThanOrEqual(1);
      const row = payload.rows.find((r: { sessionId: string }) => r.sessionId === "sess-fts");
      expect(row).toBeDefined();
      expect(row.provider).toBe("pi");
      expect(row.snippet.toLowerCase()).toContain("postgres");
      expect(row.snippet.length).toBeLessThanOrEqual(300);
    });

    it("filters by provider and degrades to empty results on garbage queries", async () => {
      const hit = await call("search_sessions", { query: "postgres deadlock", provider: "codex" });
      const payload = JSON.parse(textOf(hit));
      expect(payload.rows.every((r: { provider: string }) => r.provider === "codex")).toBe(true);
      expect(payload.matches).toBe(0);

      const none = await call("search_sessions", { query: "zzz-no-such-term-anywhere" });
      expect(JSON.parse(textOf(none)).matches).toBe(0);
    });
  });

  describe("usage_chart", () => {
    it("returns an ascending daily series with all metrics present", async () => {
      const res = await call("usage_chart", { last: "week" });
      expect(res.isError).toBeUndefined();
      const payload = JSON.parse(textOf(res));
      expect(payload.metric).toBe("tokens");
      expect(Array.isArray(payload.series)).toBe(true);
      expect(payload.series.length).toBeGreaterThanOrEqual(2); // d1/d2 fixtures + today
      const days = payload.series.map((s: { day: string }) => s.day);
      expect([...days].sort()).toEqual(days); // ascending
      for (const point of payload.series) {
        expect(typeof point.day).toBe("string");
        expect(typeof point.tokens).toBe("number");
        expect(typeof point.costUsd).toBe("number");
        expect(typeof point.requests).toBe("number");
      }
      // The -3d and -1d fixture days must both appear exactly once.
      expect(new Set(days).size).toBe(days.length);
    });

    it("honors the metric switch without changing the series shape", async () => {
      const res = await call("usage_chart", { last: "week", metric: "cost" });
      const payload = JSON.parse(textOf(res));
      expect(payload.metric).toBe("cost");
      expect(payload.series.every((s: { costUsd: number }) => typeof s.costUsd === "number")).toBe(true);
      // cost-bearing fixture day (-1d, $0.5) is present in the window
      expect(payload.series.some((s: { costUsd: number }) => s.costUsd >= 0.5)).toBe(true);
    });
  });
});
