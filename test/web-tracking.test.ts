import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fetchSessionDetail, fetchTracking, type TrackingPayload } from "../web/src/lib/api.ts";
import { trackingComposition, trackingModelLabel, trackingPercent, trackingRequestCounts } from "../web/src/lib/tracking.ts";
// Load the view at runtime: the CLI test tsconfig intentionally has no JSX;
// the separate web typecheck validates the component itself.
const viewModule = "../web/src/components/TrackingQuality.tsx";
const { TrackingQualitySummary } = await import(viewModule);

const data: TrackingPayload = {
  window: { since: "2026-10-01T00:00:00Z", until: null, label: "month" },
  requests: 10, totalTokens: 100, inputTokens: 10, outputTokens: 20,
  cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.12,
  reportedRequests: 1, estimatedRequests: 2, unpricedRequests: 3, unknownRequests: 4,
  pricedRequests: 3, pricingCoveragePercent: 30, cachedInputPercent: 37.5,
  unpricedModels: ["new-model"],
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("tracking dashboard", () => {
  it("preserves estimated token provenance when normalizing session detail", async () => {
    globalThis.fetch = Object.assign(async () => Response.json({ provider: "cursor", sessionId: "s", events: [{
      ts: "2026-10-01T00:00:00Z", model: "fixture", inputTokens: 10, outputTokens: 2,
      tokenSource: "estimated", tokenEstimationMethod: "characters/4",
    }] }), { preconnect: originalFetch.preconnect });
    const detail = await fetchSessionDetail("cursor", "s");
    expect(detail.events[0]).toMatchObject({ tokenSource: "estimated", tokenEstimationMethod: "characters/4" });
  });
  it("fetches the selected preset and absolute window with the existing API contract", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (path: string) => {
      paths.push(path);
      return Response.json(data);
    }) as typeof fetch;
    expect(await fetchTracking({ last: "30d" })).toEqual(data);
    await fetchTracking({ last: "week", from: "2026-10-01", to: "2026-10-20" });
    expect(paths).toEqual(["/api/tracking?last=30d", "/api/tracking?from=2026-10-01&to=2026-10-20"]);
  });

  it("rejects failed requests so the view can show unavailable instead of empty totals", async () => {
    globalThis.fetch = (async () => Response.json({ error: "unavailable" }, { status: 503 })) as unknown as typeof fetch;
    await expect(fetchTracking({ last: "week" })).rejects.toThrow("unavailable");
  });

  it("keeps all four request categories and normalized token components", () => {
    expect(trackingRequestCounts(data)).toEqual([
      { label: "Reported", value: 1 }, { label: "Estimated", value: 2 },
      { label: "Unpriced", value: 3 }, { label: "Legacy unknown", value: 4 },
    ]);
    expect(trackingComposition(data).reduce((sum, part) => sum + part.value, 0)).toBe(data.totalTokens);
    expect(trackingPercent(data.cachedInputPercent)).toBe("37.5%");
    for (const invalid of [undefined, null, NaN, Infinity, -1, 101]) expect(trackingPercent(invalid)).toBe("—");
    expect(trackingPercent(0)).toBe("0.0%");
  });

  it("renders period, scope, provenance counts, cost caveat and clipped model names", () => {
    const html = renderToStaticMarkup(createElement(TrackingQualitySummary, { data: {
      ...data, unpricedModels: ["new-model", "/home/person/private", "a".repeat(60), "name@example.com", "fifth"],
    } }));
    for (const text of ["month", "all accounts and harnesses", "Reported requests", "Estimated requests", "Unpriced requests", "Legacy unknown requests", "37.5%", "30.0%", "not a subscription bill", "not free", "(+1 more)"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("/home/person/private");
    expect(html).not.toContain("name@example.com");
    expect(html).not.toContain("fifth");
    expect(html).not.toContain("a".repeat(60));
  });

  it("renders empty periods with unavailable rates and sanitizes identifiers", () => {
    const html = renderToStaticMarkup(createElement(TrackingQualitySummary, { data: {
      ...data, requests: 0, pricingCoveragePercent: null, cachedInputPercent: null, unpricedModels: [],
    } }));
    expect(html).toContain("No requests recorded in this period");
    expect(html).toContain("—");
    expect(html).not.toContain("Unpriced models:");
    for (const name of ["/Users/person/private", "person@example.com", "sk-token", "line\nbreak"]) {
      expect(trackingModelLabel(name)).toBe("other model identifier");
    }
    expect(trackingModelLabel("new-model")).toBe("new-model");
    expect(trackingModelLabel("a".repeat(60))).toHaveLength(38);
  });

  it("distinguishes token measurement from cost estimation", () => {
    const html = renderToStaticMarkup(createElement(TrackingQualitySummary, { data: {
      ...data, reportedTokens: 60, estimatedTokens: 30, unknownTokens: 10,
    } }));
    expect(html).toContain("Token counts");
    expect(html).toContain("60 reported");
    expect(html).toContain("30 estimated");
    expect(html).toContain("10 source unknown");
    expect(html).toContain("characters ÷ 4");
    expect(html).toContain("hidden context is not counted");
  });
});
