import { describe, expect, it } from "bun:test";

import { pollQuotas } from "../src/poll.ts";
import { parseZaiQuota } from "../src/quota/zai.ts";
import { hermeticPoll, json, readFixture, routeFetcher } from "./support/quota-poll.ts";

const now = 1_792_310_400_000 - 3_600_000;

describe("z.ai quota parsing", () => {
  it("maps token windows and the monthly MCP marker, skipping unknown limit types", () => {
    expect(parseZaiQuota(readFixture("zai", "quota.json"), now)).toEqual({
      plan: "GLM Coding Pro",
      windows: [
        { windowMinutes: 300, usedPct: 25, resetsAtEpoch: 1_792_310_400 },
        { windowMinutes: 10_080, usedPct: 40, resetsAtEpoch: 1_792_828_800 },
        { windowMinutes: 43_200, usedPct: 10, resetsAtEpoch: 1_794_614_400, label: "MCP" },
      ],
    });
  });

  it("drops an implausible five-hour reset instead of guessing a timezone", () => {
    const body = {
      success: true,
      code: 200,
      data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: now + 10 * 3_600_000 }] },
    };
    expect(parseZaiQuota(body, now)).toEqual({ windows: [{ windowMinutes: 300, usedPct: 5, resetsAtEpoch: 0 }] });
  });

  it("surfaces API-level errors with their code", () => {
    expect(parseZaiQuota({ success: false, code: 401, msg: "token expired" }, now)).toBe("quota API error 401: token expired");
    expect(parseZaiQuota({ data: [] }, now)).toBe("quota response shape unrecognized");
  });
});

describe("z.ai polling", () => {
  it("uses the BigModel host and alias keys for the bigmodel-cn region", async () => {
    const { cache, options } = hermeticPoll({ providers: ["zai"], env: { BIGMODEL_API_KEY: "bm-key" } });
    const { fetcher, requests } = routeFetcher({ "/api/monitor/usage/quota/limit": () => json(readFixture("zai", "quota.json")) });
    try {
      const result = await pollQuotas({ ...options, zaiRegion: "bigmodel-cn", fetcher, now });
      expect(requests[0]?.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
      expect(requests[0]?.headers.authorization).toBe("Bearer bm-key");
      expect(result.accounts[0]).toMatchObject({ accountKey: "default", planType: "GLM Coding Pro", inserted: 3 });
      expect(cache.quotaAccountMeta("zai", "default")?.plan).toBe("GLM Coding Pro");
    } finally {
      cache.close();
    }
  });

  it("ignores BigModel aliases for the global region and prefers a config key", async () => {
    const { cache, options } = hermeticPoll({ providers: ["zai"], env: { BIGMODEL_API_KEY: "bm-key" } });
    const { fetcher, requests } = routeFetcher({ "api.z.ai": () => json(readFixture("zai", "quota.json")) });
    try {
      await pollQuotas({ ...options, fetcher, now });
      expect(requests).toHaveLength(0);
      await pollQuotas({ ...options, providerKeys: { zai: "config-key" }, fetcher, now });
      expect(requests[0]?.headers.authorization).toBe("Bearer config-key");
    } finally {
      cache.close();
    }
  });

  it("marks a rejected key as api-key-required", async () => {
    const { cache, options } = hermeticPoll({ providers: ["zai"], env: { Z_AI_API_KEY: "bad" } });
    const { fetcher } = routeFetcher({ "api.z.ai": () => json({ error: "unauthorized" }, { status: 401 }) });
    try {
      const result = await pollQuotas({ ...options, fetcher, now });
      expect(result.providerAuthStates).toEqual({ zai: "api-key-required" });
    } finally {
      cache.close();
    }
  });

  it("holds after HTTP 429 for the server's Retry-After", async () => {
    const { cache, options } = hermeticPoll({ providers: ["zai"], env: { ZAI_API_KEY: "key" } });
    let limited = true;
    const { fetcher, requests } = routeFetcher({
      "api.z.ai": () => (limited ? new Response("slow down", { status: 429, headers: { "retry-after": "600" } }) : json(readFixture("zai", "quota.json"))),
    });
    try {
      const first = await pollQuotas({ ...options, fetcher, now });
      expect(first.reason).toContain("HTTP 429 (retry after 600s)");
      expect(first.providerAuthStates).toEqual({ zai: "temporarily-unavailable" });

      limited = false;
      const held = await pollQuotas({ ...options, fetcher, now: now + 9 * 60_000 });
      expect(requests).toHaveLength(1);
      expect(held.reason).toContain("holding until");

      const resumed = await pollQuotas({ ...options, fetcher, now: now + 10 * 60_000 + 1 });
      expect(requests).toHaveLength(2);
      expect(resumed.ok).toBe(true);
    } finally {
      cache.close();
    }
  });
});
