import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-serve-test-"));
process.env.TOKITOKI_DATA_DIR = dataDir;
process.env.TOKITOKI_CONFIG = path.join(dataDir, "config.json");
fs.writeFileSync(process.env.TOKITOKI_CONFIG, "{}");

const event = (id: string, over: Record<string, unknown>): string =>
  JSON.stringify({
    id,
    ts: new Date().toISOString(),
    machineId: "serve-test",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.1,
    sessionId: `s-${id}`,
    ...over,
  });

fs.writeFileSync(
  path.join(dataDir, "events.jsonl"),
  [
    event("a", { provider: "claude-code", accountKey: "default", model: "claude-sonnet-4", costUsd: 1 }),
    event("b", { provider: "pi", accountKey: "openrouter", model: "openrouter/anthropic/claude-opus-4", costUsd: 2 }),
    event("c", { provider: "codex", accountKey: "openai:plus", model: "gpt-5", costUsd: 0.5 }),
  ].join("\n") + "\n",
);

const UsageSchema = z.object({
  version: z.literal(1),
  by: z.string(),
  error: z.string().optional(),
  details: z.unknown().optional(),
  total: z.object({ requests: z.number() }),
  rows: z.array(z.object({ key: z.string(), costUsd: z.number() })),
});
const ErrorSchema = z.object({ error: z.string(), details: z.unknown().optional() });
const getJson = async (url: string): Promise<unknown> => (await fetch(url)).json();

const { LimitsDocumentSchema } = await import("../src/limits-document.ts");
const { handleLocalApiRequest, isLoopbackHost, startLocalApiServer } = await import("../src/serve.ts");
const server = startLocalApiServer({ port: 0, host: "127.0.0.1", appVersion: "test" });
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("tokitoki serve", () => {
  test("binds loopback and reports health on /v1/health", async () => {
    expect(server.hostname).toBe("127.0.0.1");
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1, ok: true, app: "tokitoki", appVersion: "test", events: 3 });
  });

  test("/v1/status matches the web dashboard's compact widget summary", async () => {
    const body = z.object({ app: z.literal("tokitoki"), stats: z.object({ requests: z.number() }), providers: z.array(z.object({ id: z.string() })) })
      .parse(await getJson(`${base}/v1/status?last=week`));
    expect(body.stats.requests).toBe(3);
    expect(body.providers.map((provider) => provider.id).sort()).toEqual(["claude-code", "codex", "pi"]);
  });

  test("/v1/usage groups by vendor by default", async () => {
    const body = UsageSchema.parse(await getJson(`${base}/v1/usage?period=today`));
    expect(body.version).toBe(1);
    expect(body.by).toBe("vendor");
    expect(body.rows.map((row) => row.key)).toEqual(["anthropic", "openai"]);
    expect(body.rows[0]!.costUsd).toBeCloseTo(3);
    expect(body.total.requests).toBe(3);
  });

  test("/v1/usage accepts harness, legacy provider and model", async () => {
    const harness = UsageSchema.parse(await getJson(`${base}/v1/usage?period=week&by=harness`));
    expect(harness.by).toBe("harness");
    expect(harness.rows.map((row) => row.key).sort()).toEqual(["claude-code", "codex", "pi"]);
    const legacy = UsageSchema.parse(await getJson(`${base}/v1/usage?period=month&by=provider`));
    expect(legacy.by).toBe("harness");
    const model = UsageSchema.parse(await getJson(`${base}/v1/usage?by=model`));
    expect(model.rows).toHaveLength(3);
  });

  test("rejects invalid query params with a 400 and zod details", async () => {
    const res = await fetch(`${base}/v1/usage?period=decade&by=planet`);
    expect(res.status).toBe(400);
    const body = ErrorSchema.parse(await res.json());
    expect(body.error).toBe("invalid query");
    expect(JSON.stringify(body.details)).toContain("period");
  });

  test("/v1/limits serves the versioned limits document", async () => {
    const res = await fetch(`${base}/v1/limits`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const document = LimitsDocumentSchema.parse(await res.json());
    expect(document.version).toBe(1);
    expect(document.accounts.find((account) => account.harness === "claude-code")?.vendor).toBe("anthropic");
  });

  test("is read-only and 404s unknown paths", async () => {
    expect((await fetch(`${base}/v1/limits`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/v1/nope`)).status).toBe(404);
  });

  test("refuses non-loopback Host headers when bound to loopback (DNS rebinding)", () => {
    const res = handleLocalApiRequest(new Request("http://evil.example:6736/v1/status"), { loopbackOnly: true, appVersion: "test" });
    expect(res.status).toBe(403);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
