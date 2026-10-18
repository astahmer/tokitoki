import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountLimits, LimitWindow } from "../src/limits.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-notify-test-"));
process.env.TOKITOKI_DATA_DIR = dataDir;

const { dispatchNotifications, emptyNotifyState, evaluateNotifications, readNotifyState } = await import("../src/notify.ts");

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const now = new Date("2026-09-10T15:00:00.000Z");

const window = (over: Partial<LimitWindow>): LimitWindow => ({
  kind: "day",
  source: "embedded",
  tokens: 0,
  cost: 0,
  requests: 0,
  id: "session",
  label: "Session",
  resetsAt: "2026-09-10T17:00:00.000Z",
  ...over,
});

const account = (windows: LimitWindow[], over: Partial<AccountLimits> = {}): AccountLimits => ({
  provider: "claude-code",
  accountKey: "default",
  email: "dev@example.com",
  windows,
  ...over,
});

const evaluate = (input: { limits: AccountLimits[]; settings?: Parameters<typeof evaluateNotifications>[0]["settings"]; state?: ReturnType<typeof emptyNotifyState> }) =>
  evaluateNotifications({
    limits: input.limits,
    budgets: [],
    settings: input.settings ?? { enabled: true },
    state: input.state ?? emptyNotifyState(),
    now,
  });

describe("evaluateNotifications", () => {
  test("alerts a critical window once per reset", () => {
    const limits = [account([window({ usedPct: 95 })])];
    const first = evaluate({ limits });
    expect(first.notifications.map((notification) => notification.kind)).toEqual(["quotaCritical"]);
    expect(first.notifications[0]!.body).toContain("5% left");
    expect(evaluate({ limits, state: first.state }).notifications).toEqual([]);

    const nextWindow = [account([window({ usedPct: 96, resetsAt: "2026-09-10T22:00:00.000Z" })])];
    expect(evaluate({ limits: nextWindow, state: first.state }).notifications).toHaveLength(1);
  });

  test("warns when the pace runs out before the reset", () => {
    const pace = { expectedPercent: 40, deltaPercent: 30, status: "over" as const, runsOutAt: "2026-09-10T16:10:00.000Z" };
    const result = evaluate({ limits: [account([window({ usedPct: 70, pace })])] });
    expect(result.notifications.map((notification) => notification.kind)).toEqual(["quotaPace"]);
    expect(result.notifications[0]!.body).toContain("runs out ~");
  });

  test("skips stale, estimated and disabled windows", () => {
    expect(evaluate({ limits: [account([window({ usedPct: 99 })], { freshness: "stale" })] }).notifications).toEqual([]);
    expect(evaluate({ limits: [account([window({ usedPct: 99, source: "derived" })])] }).notifications).toEqual([]);
    expect(evaluate({ limits: [account([window({ usedPct: 99 })])], settings: { enabled: true, disabled: ["quotaCritical"] } }).notifications).toEqual([]);
  });

  test("reports recovery only after a critical observation when resetAware is on", () => {
    const settings = { enabled: true, resetAware: true };
    const critical = evaluate({ limits: [account([window({ usedPct: 97 })])], settings });
    const recovered = evaluate({
      limits: [account([window({ usedPct: 3, resetsAt: "2026-09-10T22:00:00.000Z" })])],
      settings,
      state: critical.state,
    });
    expect(recovered.notifications.map((notification) => notification.kind)).toEqual(["quotaReset"]);
    expect(evaluate({ limits: [account([window({ usedPct: 3 })])], settings }).notifications).toEqual([]);
  });

  test("covers budgets and burn rate per calendar period", () => {
    const result = evaluateNotifications({
      limits: [],
      budgets: [{ scope: "month", label: "monthly", cap: 100, used: 85, unit: "usd", ratio: 0.85, state: "warn", daysLeft: 20 }],
      spendHealth: { monthToDate: 85, requests: 10, perDay: 8.5, projected: 255, monthlyCap: 100, projectedRatio: 2.55, state: "exceeded", daysElapsed: 10, daysInMonth: 30 },
      settings: { enabled: true, burnWarnings: true },
      state: emptyNotifyState(),
      now,
    });
    expect(result.notifications.map((notification) => notification.kind)).toEqual(["budget", "burnRate"]);
    expect(result.notifications.map((notification) => notification.key)).toEqual(["budget|monthly|80|2026-09", "burn|2026-09|100"]);
  });
});

describe("dispatchNotifications", () => {
  test("does nothing unless notifications are enabled", () => {
    const result = dispatchNotifications({ limits: [account([window({ usedPct: 99 })])], budgets: [], settings: undefined, now });
    expect(result.skipped).toBe("disabled");
  });

  test("dry runs report without recording", () => {
    const result = dispatchNotifications({ limits: [account([window({ usedPct: 99 })])], budgets: [], settings: { enabled: true }, now, dryRun: true });
    expect(result.sent).toHaveLength(1);
    expect(readNotifyState().keys).toEqual([]);
  });

  test("records sent alerts so the next run stays quiet", () => {
    // Empty PATH keeps notify-send from popping real alerts during the test.
    const previousPath = Bun.env.PATH;
    Bun.env.PATH = "";
    try {
      const first = dispatchNotifications({ limits: [account([window({ usedPct: 99 })])], budgets: [], settings: { enabled: true }, now });
      expect(first.sent).toHaveLength(1);
      expect(first.undelivered).toBe(1);
      expect(readNotifyState().history[0]!.title).toBe("tokitoki quota critical");
      const second = dispatchNotifications({ limits: [account([window({ usedPct: 99 })])], budgets: [], settings: { enabled: true }, now });
      expect(second.sent).toEqual([]);
    } finally {
      Bun.env.PATH = previousPath;
    }
  });
});
