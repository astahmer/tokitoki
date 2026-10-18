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

  it("suffixes repeated ids within one account", () => {
    expect(withUniqueWindowIds([{ id: "session" }, { id: "weekly" }, { id: "session" }, {}]).map((window) => window.id))
      .toEqual(["session", "weekly", "session:2", undefined]);
  });
});
