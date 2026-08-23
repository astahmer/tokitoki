import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated data dir so the API reads seeded fixtures, not real usage.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-web-test-"));
process.env.TOKITOKI_DATA_DIR = dataDir;

const event = (id: string, over: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    id,
    ts: new Date().toISOString(),
    machineId: "test-mac",
    provider: "pi",
    accountKey: "default",
    model: "m1",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 400,
    costUsd: 0.01,
    sessionId: `s-${id}`,
    ...over,
  });

fs.writeFileSync(
  path.join(dataDir, "events.jsonl"),
  [event("e1"), event("e2", { model: "m2", costUsd: 0.5 }), event("e3", { accountKey: "pro" })].join("\n") + "\n",
);

const { startWebServer } = await import("../src/web/server.ts");
const server = startWebServer({ port: 0 });

describe("web api + server", () => {

  afterAll(() => {
    server.stop(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("/ serves the dashboard html", async () => {
    const res = await fetch(`http://localhost:${server.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("tokitoki");
  });

  test("/api/summary aggregates the seeded week", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/summary`);
    const body = (await res.json()) as Record<string, number>;
    expect(res.status).toBe(200);
    expect(body.requests).toBeGreaterThanOrEqual(3);
    expect(body.sessions).toBeGreaterThanOrEqual(3);
    expect(body.cost).toBeGreaterThan(0);
    expect(body.projectedMonthEnd).toBeGreaterThan(0);
  });

  test("/api/table groups and exposes account tabs", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/table?by=model&period=week`);
    const body = (await res.json()) as {
      rows: Array<{ bucket: string; sharePct: number; costUsd: number }>;
      total: { requests: number };
      accounts: Array<{ key: string; requests: number }>;
    };
    expect(res.status).toBe(200);
    expect(body.rows.length).toBeGreaterThanOrEqual(2); // m1 + m2
    expect(body.total.requests).toBeGreaterThanOrEqual(3);
    expect(body.accounts.map((a) => a.key).sort()).toEqual(["default", "pro"]);
    const shares = body.rows.reduce((s, r) => s + r.sharePct, 0);
    expect(shares).toBeLessThanOrEqual(100);
  });

  test("/api/table account filter scopes rows", async () => {
    const res = await fetch(
      `http://localhost:${server.port}/api/table?by=model&period=week&account=pro`,
    );
    const body = (await res.json()) as { total: { requests: number } };
    expect(res.status).toBe(200);
    expect(body.total.requests).toBe(1);
  });

  test("/api/timeseries returns aligned series", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/timeseries?by=provider&days=7`);
    const body = (await res.json()) as { by: string; days: string[]; series: Array<{ bucket: string; values: number[] }> };
    expect(res.status).toBe(200);
    expect(body.by).toBe("provider");
    for (const s of body.series) expect(s.values).toHaveLength(days_len(body));
  });

  function days_len(b: { days: string[] }): number {
    return b.days.length;
  }

  test("invalid params get a 400 with message", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/table?by=bogus&period=week`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("invalid dimension");
  });
});
