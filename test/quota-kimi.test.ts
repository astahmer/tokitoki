import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { pollQuotas } from "../src/poll.ts";
import { parseKimiUsage } from "../src/quota/kimi.ts";
import { hermeticPoll, json, readFixture, routeFetcher } from "./support/quota-poll.ts";

const epoch = (iso: string): number => Date.parse(iso) / 1000;
const now = Date.parse("2026-10-18T12:00:00Z");

const writeCliLogin = (input: { home: string; expiresAt: number; deviceId?: string }): void => {
  mkdirSync(path.join(input.home, "credentials"), { recursive: true });
  writeFileSync(
    path.join(input.home, "credentials", "kimi-code.json"),
    JSON.stringify({ access_token: "cli-token", refresh_token: "rotating", expires_at: input.expiresAt }),
  );
  if (input.deviceId !== undefined) writeFileSync(path.join(input.home, "device_id"), `${input.deviceId}\n`);
};

describe("Kimi usage parsing", () => {
  it("reads ratio pools and the membership plan", () => {
    expect(parseKimiUsage(readFixture("kimi", "usages.json"))).toEqual({
      plan: "Allegretto",
      windows: [
        { windowMinutes: 300, usedPct: 25, resetsAtEpoch: epoch("2026-10-18T15:00:00Z") },
        { windowMinutes: 10_080, usedPct: 50, resetsAtEpoch: epoch("2026-10-22T00:00:00Z") },
        { windowMinutes: 43_200, usedPct: 12.5, resetsAtEpoch: epoch("2026-11-01T00:00:00Z") },
      ],
    });
  });

  it("falls back to legacy string counts", () => {
    expect(parseKimiUsage(readFixture("kimi", "usages-legacy.json"))).toEqual({
      plan: "Moderato",
      windows: [
        { windowMinutes: 300, usedPct: 25, resetsAtEpoch: epoch("2026-10-18T15:00:00Z") },
        { windowMinutes: 10_080, usedPct: 25, resetsAtEpoch: epoch("2026-10-22T00:00:00Z") },
      ],
    });
    expect(parseKimiUsage({ user: { membership: { level: "LEVEL_NEW" } } })).toEqual({ plan: "LEVEL_NEW", windows: [] });
  });
});

describe("Kimi polling", () => {
  it("reuses a fresh CLI login with the CLI identity headers, read-only", async () => {
    const { dir, cache, options } = hermeticPoll({ providers: ["kimi"] });
    const home = path.join(dir, "kimi-home");
    writeCliLogin({ home, expiresAt: now / 1000 + 900, deviceId: "device-123" });
    const { fetcher, requests } = routeFetcher({ "api.kimi.com/coding/v1/usages": () => json(readFixture("kimi", "usages.json")) });
    try {
      const result = await pollQuotas({ ...options, kimiHome: home, fetcher, now });
      expect(result.accounts[0]).toMatchObject({ accountKey: "default", planType: "Allegretto", inserted: 3 });
      expect(requests[0]?.headers).toMatchObject({
        authorization: "Bearer cli-token",
        "x-msh-platform": "kimi_code_cli",
        "x-msh-device-id": "device-123",
      });
    } finally {
      cache.close();
    }
  });

  it("asks to renew a stale CLI token without calling the API", async () => {
    const { dir, cache, options } = hermeticPoll({ providers: ["kimi"] });
    const home = path.join(dir, "kimi-home");
    writeCliLogin({ home, expiresAt: now / 1000 + 30 });
    const { fetcher, requests } = routeFetcher({});
    try {
      const result = await pollQuotas({ ...options, kimiHome: home, fetcher, now });
      expect(requests).toHaveLength(0);
      expect(result.reason).toContain("kimi CLI token expired; run kimi to renew");
      expect(result.providerAuthStates).toEqual({ kimi: "login-required" });
    } finally {
      cache.close();
    }
  });

  it("prefers an API key and reports rejection as api-key-required", async () => {
    const { dir, cache, options } = hermeticPoll({ providers: ["kimi"], env: { KIMI_CODE_API_KEY: "sk-kimi" } });
    const home = path.join(dir, "kimi-home");
    writeCliLogin({ home, expiresAt: now / 1000 + 900 });
    const { fetcher, requests } = routeFetcher({ "api.kimi.com": () => json({}, { status: 401 }) });
    try {
      const result = await pollQuotas({ ...options, kimiHome: home, fetcher, now });
      expect(requests[0]?.headers.authorization).toBe("Bearer sk-kimi");
      expect(requests[0]?.headers["x-msh-platform"]).toBeUndefined();
      expect(result.providerAuthStates).toEqual({ kimi: "api-key-required" });
    } finally {
      cache.close();
    }
  });
});
