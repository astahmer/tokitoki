import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import {
  cachedStatusIncidents,
  parseGoogleIncidents,
  parseStatuspageSummary,
  refreshStatusIncidents,
  statusVendors,
} from "../src/status-incidents.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/status/${name}`, import.meta.url), "utf8"));

const memoryMeta = () => {
  const values = new Map<string, string>();
  return {
    values,
    metaValue: (key: string) => values.get(key),
    setMetaValue: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

const GEMINI_PRODUCT = "npdyhgECDJ6tB66MxXyo";

describe("status page parsing", () => {
  it("takes the worst open Statuspage incident over the page indicator", () => {
    expect(parseStatuspageSummary({ body: fixture("statuspage-degraded.json"), pageUrl: "https://status.claude.com" })).toEqual({
      indicator: "major",
      description: "Elevated errors on Claude Opus",
      url: "https://stspg.io/abc123",
    });
  });

  it("reports an operational Statuspage summary as none", () => {
    expect(parseStatuspageSummary({ body: fixture("statuspage-operational.json"), pageUrl: "https://status.openai.com" })).toEqual({
      indicator: "none",
      description: "All Systems Operational",
      url: "https://status.openai.com/",
    });
  });

  it("maps maintenance to minor and rejects unrelated JSON", () => {
    expect(parseStatuspageSummary({ body: { status: { indicator: "maintenance" } }, pageUrl: "u" })?.indicator).toBe("minor");
    expect(parseStatuspageSummary({ body: { nope: true }, pageUrl: "u" })).toBeUndefined();
  });

  it("shows the latest provider update for an open incident", () => {
    const body = { status: { indicator: "minor" }, incidents: [{ name: "Copilot disruption", status: "investigating", impact: "minor", incident_updates: [{ body: "  Some models are unavailable.  " }] }] };
    expect(parseStatuspageSummary({ body, pageUrl: "https://status.example" })?.description).toBe("Some models are unavailable.");
  });

  it("filters Google incidents to active ones for the Gemini product", () => {
    expect(parseGoogleIncidents({ body: fixture("google-incidents.json"), productId: GEMINI_PRODUCT, pageUrl: "p" })).toEqual({
      indicator: "major",
      description: "Elevated error rates for Gemini API requests.",
      url: "https://www.google.com/appsstatus/dashboard/incidents/Gm2",
    });
    expect(parseGoogleIncidents({ body: [], productId: GEMINI_PRODUCT, pageUrl: "p" })).toEqual({ indicator: "none", description: "", url: "p" });
    expect(parseGoogleIncidents({ body: { not: "an array" }, productId: GEMINI_PRODUCT, pageUrl: "p" })).toBeUndefined();
  });
});

describe("status incident cache", () => {
  it("only checks vendors that publish a status page", () => {
    expect(statusVendors(["anthropic", "pi", "google", "anthropic", "zhipu"])).toEqual(["anthropic", "google"]);
  });

  it("fetches once per TTL, keeps the last answer on failure, and expires it", async () => {
    const cache = memoryMeta();
    let calls = 0;
    const ok: typeof fetch = Object.assign(async () => {
      calls += 1;
      return new Response(JSON.stringify(fixture("statuspage-degraded.json")));
    }, { preconnect: () => {} });
    const failing: typeof fetch = Object.assign(async () => {
      calls += 1;
      throw new Error("offline");
    }, { preconnect: () => {} });
    const start = Date.UTC(2026, 9, 18, 12);

    await refreshStatusIncidents({ cache, vendors: ["anthropic"], fetcher: ok, now: start });
    await refreshStatusIncidents({ cache, vendors: ["anthropic"], fetcher: ok, now: start + 60_000 });
    expect(calls).toBe(1);
    expect(cachedStatusIncidents({ cache, vendors: ["anthropic"], now: start }).anthropic?.indicator).toBe("major");

    await refreshStatusIncidents({ cache, vendors: ["anthropic"], fetcher: failing, now: start + 6 * 60_000 });
    expect(calls).toBe(2);
    expect(cachedStatusIncidents({ cache, vendors: ["anthropic"], now: start + 6 * 60_000 }).anthropic?.indicator).toBe("major");
    expect(cachedStatusIncidents({ cache, vendors: ["anthropic"], now: start + 2 * 60 * 60_000 })).toEqual({});
  });
});
