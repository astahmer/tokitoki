import { describe, expect, it } from "bun:test";

import type { QuotaSnapshotRow } from "../src/cache.ts";
import { embeddedLimitWindow } from "../src/limits.ts";
import { computePace, describeQuotaWindow, withUniqueWindowIds } from "../src/quota-windows.ts";

describe("describeQuotaWindow", () => {
  it("names the 5-hour window a session, not a day", () => {
    expect(describeQuotaWindow({ windowMinutes: 300, usedPercent: 12 })).toEqual({
      id: "session",
      label: "Session",
      scope: "session",
      usedPercent: 12,
      windowMinutes: 300,
    });
    expect(describeQuotaWindow({ windowMinutes: 1440, usedPercent: 0 }).scope).toBe("daily");
    expect(describeQuotaWindow({ windowMinutes: 10_080, usedPercent: 0 }).scope).toBe("weekly");
    expect(describeQuotaWindow({ windowMinutes: 44_640, usedPercent: 0 }).scope).toBe("monthly");
  });

  it("gives per-model and labelled buckets distinct ids", () => {
    expect(describeQuotaWindow({ windowMinutes: 10_080, usedPercent: 140, model: "opus" })).toEqual({
      id: "weekly:opus",
      label: "Opus weekly",
      scope: "model",
      model: "opus",
      usedPercent: 100,
      windowMinutes: 10_080,
    });
    const bucket = describeQuotaWindow({ windowMinutes: 44_640, usedPercent: 5, label: "Other Models" });
    expect(bucket.id).toBe("monthly:other-models");
    expect(bucket.label).toBe("Other Models");
    expect(bucket.scope).toBe("monthly");
  });

  it("recognizes only established durations and preserves arbitrary meter lengths", () => {
    for (const minutes of [28 * 1440, 29 * 1440, 30 * 1440, 31 * 1440]) {
      expect(describeQuotaWindow({ windowMinutes: minutes, usedPercent: 5 }).scope).toBe("monthly");
    }
    for (const minutes of [1, 60, 299, 301, 720, 1441, 9 * 1440, 14 * 1440, 27 * 1440, 32 * 1440, 365 * 1440]) {
      expect(describeQuotaWindow({ windowMinutes: minutes, usedPercent: 5 })).toMatchObject({ scope: "other", label: "Limit", windowMinutes: minutes });
    }
    for (const minutes of [0, -1, NaN, Infinity]) {
      const window = describeQuotaWindow({ windowMinutes: minutes, usedPercent: 5 });
      expect(window.scope).toBe("other");
      expect(window.windowMinutes).toBeUndefined();
    }
  });

  it("prefers provider scope and stable meter slots over duration-derived identity", () => {
    expect(describeQuotaWindow({ windowMinutes: 60, usedPercent: 20, scope: "daily", bucketId: "requests", windowId: "primary" })).toMatchObject({ id: "requests:primary", label: "Daily", scope: "daily", windowMinutes: 60 });
    expect(describeQuotaWindow({ windowMinutes: 10080, usedPercent: 30, model: "opus", scope: "model", bucketId: "opus", windowId: "seven_day" })).toMatchObject({ id: "opus:seven_day:opus", scope: "model", label: "Opus weekly", model: "opus" });
  });
});

describe("computePace", () => {
  const resetsAt = "2026-10-18T15:00:00.000Z";
  // 5h window ending at 15:00 started at 10:00; 12:30 is exactly halfway.
  const halfway = new Date("2026-10-18T12:30:00.000Z");

  it("reports even-use expectation and on-pace status", () => {
    expect(computePace({ usedPercent: 48, resetsAt, windowMinutes: 300, now: halfway })).toEqual({
      expectedPercent: 50,
      deltaPercent: -2,
      status: "on",
    });
  });

  it("projects exhaustion before reset when burning ahead of pace", () => {
    const pace = computePace({ usedPercent: 80, resetsAt, windowMinutes: 300, now: halfway });
    expect(pace?.status).toBe("over");
    expect(pace?.deltaPercent).toBe(30);
    // 80% in 150min → the remaining 20% lasts 37.5min.
    expect(pace?.runsOutAt).toBe("2026-10-18T13:07:30.000Z");
  });

  it("omits the ETA when the quota outlasts the window", () => {
    const pace = computePace({ usedPercent: 20, resetsAt, windowMinutes: 300, now: halfway });
    expect(pace?.status).toBe("under");
    expect(pace?.runsOutAt).toBeUndefined();
  });

  it("has no pace without a usable reset or once the window is over", () => {
    expect(computePace({ usedPercent: 50, resetsAt: undefined, windowMinutes: 300, now: halfway })).toBeUndefined();
    expect(computePace({ usedPercent: 50, resetsAt, windowMinutes: undefined, now: halfway })).toBeUndefined();
    expect(computePace({ usedPercent: 50, resetsAt, windowMinutes: 300, now: new Date("2026-10-18T16:00:00Z") })).toBeUndefined();
    expect(computePace({ usedPercent: 50, resetsAt, windowMinutes: 60, now: halfway })).toBeUndefined();
  });

  it("marks an exhausted window over pace without an ETA", () => {
    const pace = computePace({ usedPercent: 100, resetsAt, windowMinutes: 300, now: halfway });
    expect(pace).toEqual({ expectedPercent: 50, deltaPercent: 50, status: "over" });
  });
});

describe("window ids", () => {
  const snapshot = (windowMinutes: number): QuotaSnapshotRow => ({
    accountKey: "codex",
    accountId: null,
    windowMinutes,
    label: "",
    usedPct: 10,
    amountUsd: null,
    model: null,
    resetsAt: 0,
    creditsJson: null,
    capturedAt: "2026-10-18T12:00:00.000Z",
  });

  it("never labels an unknown-duration window a session", () => {
    const now = new Date("2026-10-18T12:00:00.000Z");
    const unknown = embeddedLimitWindow({ snapshot: snapshot(0), now });
    expect(unknown).toMatchObject({ id: "other", label: "Limit", scope: "other" });
    expect(unknown.windowMinutes).toBeUndefined();
    const ids = [snapshot(300), snapshot(0), snapshot(10_080)].map((row) => embeddedLimitWindow({ snapshot: row, now }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a fresh known-duration observation current without inventing its reset", () => {
    const window = embeddedLimitWindow({ snapshot: snapshot(300), now: new Date("2026-10-18T12:05:00Z") });
    expect(window).toMatchObject({ status: "current", usedPct: 10, usedPercent: 10, observedAt: "2026-10-18T12:00:00.000Z" });
    expect(window.resetsAt).toBeUndefined();
    expect(window.pace).toBeUndefined();
  });

  it("suppresses current usage for expired, stale and unverified observations", () => {
    const now = new Date("2026-10-18T12:05:00Z");
    const expired = embeddedLimitWindow({ snapshot: { ...snapshot(300), resetsAt: Date.parse("2026-10-18T12:00:00Z") / 1000 }, now });
    const stale = embeddedLimitWindow({ snapshot: snapshot(300), now, maxAgeMs: 60_000 });
    const unknown = embeddedLimitWindow({ snapshot: snapshot(300), now, identityVerified: false });
    expect([expired.status, stale.status, unknown.status]).toEqual(["expired", "stale", "unknown"]);
    expect(expired.resetsAt).toBe("2026-10-18T12:00:00.000Z");
    for (const window of [expired, stale, unknown]) {
      expect(window.usedPct).toBeUndefined();
      expect(window.usedPercent).toBeUndefined();
      expect(window.pace).toBeUndefined();
      expect(window.observedAt).toBe("2026-10-18T12:00:00.000Z");
    }
  });

  it("suffixes repeated ids within one account", () => {
    expect(withUniqueWindowIds([{ id: "session" }, { id: "weekly" }, { id: "session" }, {}]).map((window) => window.id))
      .toEqual(["session", "weekly", "session:2", undefined]);
  });
});
