import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { computeLimits } from "../src/limits.ts";
import { pollQuotas } from "../src/poll.ts";
import {
  GEMINI_CONSUMER_SHUTDOWN_REASON,
  parseGeminiCodeAssist,
  parseGeminiOAuthClient,
  parseGeminiQuota,
  resolveGeminiOAuthClient,
} from "../src/quota/gemini.ts";
import { fixturePath, hermeticPoll, json, readFixture, routeFetcher } from "./support/quota-poll.ts";

const reset = Date.parse("2026-10-19T00:00:00Z") / 1000;

const idToken = (claims: Record<string, unknown>): string =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

describe("Gemini parsers", () => {
  it("keeps the lowest remaining fraction per model family", () => {
    expect(parseGeminiQuota(readFixture("gemini", "quota.json"))).toEqual([
      { windowMinutes: 1440, usedPct: 60, resetsAtEpoch: reset, model: "pro", label: "Pro daily" },
      { windowMinutes: 1440, usedPct: 10, resetsAtEpoch: reset, model: "flash", label: "Flash daily" },
      { windowMinutes: 1440, usedPct: 0, resetsAtEpoch: reset, model: "flash-lite", label: "Flash Lite daily" },
    ]);
    expect(parseGeminiQuota({ buckets: "nope" })).toBeUndefined();
  });

  it("maps tiers to plans and reads the quota project", () => {
    expect(parseGeminiCodeAssist(readFixture("gemini", "load-code-assist.json"))).toEqual({
      tierId: "standard-tier",
      plan: "Gemini Code Assist Standard",
      projectId: "proj-quota-123",
      consumerUnsupported: false,
    });
    expect(parseGeminiCodeAssist({ currentTier: { id: "standard-tier" }, cloudaicompanionProject: "p-1" })).toMatchObject({ plan: "Paid", projectId: "p-1" });
    expect(parseGeminiCodeAssist({ currentTier: { id: "free-tier" } }, "example.com")?.plan).toBe("Workspace");
    expect(parseGeminiCodeAssist({ currentTier: { id: "free-tier" } })?.plan).toBe("Free");
    expect(parseGeminiCodeAssist({ currentTier: { id: "legacy-tier" } })?.plan).toBe("Legacy");
  });

  it("flags the consumer shutdown unless the account is Workspace or paid", () => {
    const shutdown = readFixture("gemini", "load-code-assist-shutdown.json");
    expect(parseGeminiCodeAssist(shutdown)?.consumerUnsupported).toBe(true);
    expect(parseGeminiCodeAssist(shutdown, "school.edu")?.consumerUnsupported).toBe(false);
  });

  it("extracts the OAuth client from an installed gemini-cli bundle", () => {
    expect(parseGeminiOAuthClient(readFileSync(fixturePath("gemini", "oauth2.js"), "utf8"))).toEqual({
      clientId: "fixture-client-id.apps.googleusercontent.com",
      clientSecret: "FIXTURE-not-a-secret_123",
    });
    const { dir } = hermeticPoll({ providers: [] });
    const out = path.join(dir, "nix-store", "gemini-cli-0.9.0");
    mkdirSync(path.join(out, "bin"), { recursive: true });
    mkdirSync(path.join(out, "share", "gemini-cli", "bundle"), { recursive: true });
    writeFileSync(path.join(out, "bin", "gemini"), "#!/bin/sh\n");
    chmodSync(path.join(out, "bin", "gemini"), 0o755);
    writeFileSync(path.join(out, "share", "gemini-cli", "bundle", "gemini.js"), "import './chunk-a.js';\n");
    copyFileSync(fixturePath("gemini", "oauth2.js"), path.join(out, "share", "gemini-cli", "bundle", "chunk-a.js"));
    expect(resolveGeminiOAuthClient({ PATH: path.join(out, "bin") })?.clientId).toBe("fixture-client-id.apps.googleusercontent.com");
    expect(resolveGeminiOAuthClient({ GEMINI_OAUTH2_JS_PATH: fixturePath("gemini", "oauth2.js") })?.clientSecret).toBe("FIXTURE-not-a-secret_123");
    expect(resolveGeminiOAuthClient({ PATH: path.join(dir, "empty") })).toBeUndefined();
  });
});

describe("Gemini polling", () => {
  it("refreshes an expired token, persists it, and stores per-model windows with plan and email", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const { dir, cache, options } = hermeticPoll({
      providers: ["gemini-cli"],
      env: { GEMINI_OAUTH_CLIENT_ID: "env-client", GEMINI_OAUTH_CLIENT_SECRET: "env-secret" },
    });
    const credsPath = path.join(dir, "oauth_creds.json");
    writeFileSync(credsPath, JSON.stringify({
      access_token: "stale",
      refresh_token: "refresh-1",
      id_token: idToken({ email: "old@example.com" }),
      expiry_date: now - 1000,
      scope: "kept",
    }));
    const { fetcher, requests } = routeFetcher({
      "oauth2.googleapis.com/token": () => json({ access_token: "fresh", expires_in: 3600, id_token: idToken({ email: "dev@example.com" }) }),
      ":loadCodeAssist": () => json(readFixture("gemini", "load-code-assist.json")),
      ":retrieveUserQuota": () => json(readFixture("gemini", "quota.json")),
    });
    try {
      const result = await pollQuotas({ ...options, geminiCredsPath: credsPath, fetcher, now });
      expect(result.ok).toBe(true);
      expect(result.accounts[0]).toMatchObject({
        accountKey: "default",
        email: "dev@example.com",
        planType: "Gemini Code Assist Standard",
        inserted: 3,
      });
      expect(requests[0]?.body).toContain("client_secret=env-secret");
      expect(requests[1]?.headers.authorization).toBe("Bearer fresh");
      expect(JSON.parse(requests[2]?.body ?? "{}")).toEqual({ project: "proj-quota-123" });
      const persisted = JSON.parse(readFileSync(credsPath, "utf8"));
      expect(persisted).toMatchObject({ access_token: "fresh", refresh_token: "refresh-1", expiry_date: now + 3_600_000, scope: "kept" });
      expect(cache.quotaAccountMeta("gemini-cli", "default")).toEqual({ plan: "Gemini Code Assist Standard", email: "dev@example.com" });

      cache.insert([{
        id: "gemini-cli:default:s1:rec-0",
        ts: new Date(now - 60_000).toISOString(),
        machineId: "m",
        provider: "gemini-cli",
        accountKey: "default",
        model: "gemini-2.5-pro",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0,
      }]);
      const card = computeLimits(cache, {}, new Date(now)).find((limit) => limit.provider === "gemini-cli");
      expect(card?.plan).toBe("Gemini Code Assist Standard");
      expect(card?.windows.find((window) => window.id === "daily:pro")).toMatchObject({ scope: "model", model: "pro", usedPercent: 60 });
    } finally {
      cache.close();
    }
  });

  it("reports Google's consumer shutdown without asking for a login", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const { dir, cache, options } = hermeticPoll({ providers: ["gemini-cli"] });
    const credsPath = path.join(dir, "oauth_creds.json");
    writeFileSync(credsPath, JSON.stringify({ access_token: "valid", expiry_date: now + 3_600_000 }));
    const { fetcher, requests } = routeFetcher({
      ":loadCodeAssist": () => json(readFixture("gemini", "load-code-assist-shutdown.json")),
    });
    try {
      const result = await pollQuotas({ ...options, geminiCredsPath: credsPath, fetcher, now });
      expect(requests).toHaveLength(1);
      expect(result.reason).toContain(GEMINI_CONSUMER_SHUTDOWN_REASON);
      expect(result.providerAuthStates).toBeUndefined();
    } finally {
      cache.close();
    }
  });

  it("skips silently without local credentials", async () => {
    const { cache, options } = hermeticPoll({ providers: ["gemini-cli"] });
    const { fetcher, requests } = routeFetcher({});
    try {
      const result = await pollQuotas({ ...options, fetcher });
      expect(requests).toHaveLength(0);
      expect(result.reason).toBe("no provider returned quota data");
      expect(result.providerAuthStates).toBeUndefined();
    } finally {
      cache.close();
    }
  });
});
